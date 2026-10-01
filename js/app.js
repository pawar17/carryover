import * as vault from "./vault.js";
import * as T from "./text.js";
import * as ocr from "./ocr.js";
import * as ai from "./ai.js";
import MiniSearch from "../vendor/minisearch.js";

/* ============ helpers ============ */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const uid = () => crypto.getRandomValues(new Uint32Array(2)).reduce((a, n) => a + n.toString(36), "");
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const fmtDate = d => { if (!d) return ""; const x = new Date(d.length === 10 ? d + "T12:00:00" : d); return isNaN(x) ? d : x.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }

const ENVS = ["", "Any", "Dev", "QA / Test", "UAT", "Prod"];
const STATUSES = ["Confirmed", "Needs verification", "Outdated"];
const CTX_FIELDS = [
  ["system", "System / app", "e.g. Trade Reporting, Snowflake"],
  ["team", "Team / owner", "e.g. Data Platform team"],
  ["process", "Process / step", "e.g. Month-end close, Release"],
  ["env", "Environment", ""],
  ["source", "Learned from", "e.g. Priya, KT session 3"],
  ["status", "Status", ""],
];

/* ============ state ============ */
const S = {
  doc: null, view: "notebook", sec: "__all", groupBy: "section", filters: { system: "", env: "", status: "" }, q: "",
  noteId: null, editing: false,
  cap: { stage: "input", shots: [], drafts: [], busy: false, pasted: "" },
  ask: { q: "", ran: false, aiText: "", aiBusy: false },
  fu: "questions", glossQ: "",
  aiStatus: { sum: "unavailable", prompt: "unavailable" },
};
const emptyDoc = () => ({ v: 1, sections: [], notes: [], glossary: [], questions: [], settings: { autoLockMin: 10 } });

/* ============ persistence ============ */
let saveT = null, saving = Promise.resolve();
function commit(opts = {}) {
  S.doc.updatedAt = nowIso(); dirtyIndex = true; idfCache = null;
  clearTimeout(saveT);
  saveT = setTimeout(() => { saving = saving.then(() => vault.put("doc", S.doc)).catch(e => { console.error(e); toast("Couldn't save. Your browser storage may be full."); }); }, 250);
  if (opts.render !== false) render();
}
async function flush() { clearTimeout(saveT); if (S.doc && vault.isUnlocked()) await (saving = saving.then(() => vault.put("doc", S.doc))); }

/* ============ derived ============ */
const secById = id => S.doc.sections.find(s => s.id === id);
const secName = id => secById(id)?.name || "Unsorted";
const secColor = id => `var(--t${secById(id)?.color || 4})`;
const noteById = id => S.doc.notes.find(n => n.id === id);
let idfCache = null;
function idf() {
  if (!idfCache) idfCache = T.buildIdf(S.doc.notes.map(n => n.title + " " + n.body)).idf;
  return idfCache;
}
function uniqueCtx(field) { return [...new Set(S.doc.notes.map(n => n.ctx?.[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function sortedSections() { return [...S.doc.sections].sort((a, b) => a.order - b.order); }
function ensureSection(name) {
  const clean = String(name || "").trim() || "Unsorted";
  let s = S.doc.sections.find(x => x.name.toLowerCase() === clean.toLowerCase());
  if (!s) { s = { id: uid(), name: clean, color: (S.doc.sections.length % 8) + 1, order: S.doc.sections.length, description: "" }; S.doc.sections.push(s); }
  return s.id;
}
function unresolved(n) { return ((n.title + n.body).match(/⟦/g) || []).length; }

/* ============ search index ============ */
let mini = null, dirtyIndex = true;
function index() {
  if (!dirtyIndex && mini) return mini;
  mini = new MiniSearch({
    fields: ["title", "text", "extra"], storeFields: ["kind", "title", "sub", "ref"],
    searchOptions: { boost: { title: 3, extra: 1.5 }, prefix: true, fuzzy: 0.2 },
  });
  const docs = [];
  for (const n of S.doc.notes) docs.push({ id: "n:" + n.id, kind: "note", ref: n.id, title: n.title, text: n.body.replace(/[⟦⟧]/g, ""), extra: [secName(n.sectionId), ...Object.values(n.ctx || {}), ...(n.tags || [])].join(" "), sub: [secName(n.sectionId), n.ctx?.system].filter(Boolean).join(" · ") });
  for (const g of S.doc.glossary) docs.push({ id: "g:" + g.id, kind: "term", ref: g.id, title: g.term, text: g.meaning, extra: g.system || "", sub: g.meaning });
  for (const q of S.doc.questions) docs.push({ id: "q:" + q.id, kind: "question", ref: q.id, title: q.q, text: q.answer || "", extra: q.status, sub: q.answer ? "Answer: " + q.answer : "Open question" });
  mini.addAll(docs); dirtyIndex = false; return mini;
}

/* ============ markdown-lite with glossary terms and uncertain words ============ */
function termRegex() {
  const terms = S.doc.glossary.map(g => g.term).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return null;
  return new RegExp(`(^|[^A-Za-z0-9])(${terms.map(t => reEsc(esc(t))).join("|")})(?=$|[^A-Za-z0-9])`, "g");
}
function inline(s, tre, hl) {
  if (tre) s = s.replace(tre, (m, pre, term) => `${pre}<button class="term" data-term="${term}">${term}</button>`);
  s = s.replace(/⟦(.*?)⟧/g, `<mark class="unsure" title="Unsure: check the original page">$1</mark>`);
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  if (hl?.length) for (const w of hl) s = s.replace(new RegExp(`(?<![<\\w/="-])(${reEsc(esc(w))})(?![\\w>])`, "gi"), `<mark class="hit">$1</mark>`);
  return s;
}
function md(text, { terms = true, hl = null } = {}) {
  const tre = terms ? termRegex() : null;
  const lines = esc(text || "").split("\n"); let out = "", list = false;
  for (const l of lines) {
    const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) { if (!list) { out += "<ul>"; list = true; } out += "<li>" + inline(m[1], tre, hl) + "</li>"; continue; }
    if (list) { out += "</ul>"; list = false; }
    const h = l.match(/^#{1,4}\s+(.*)/);
    if (h) { out += "<h4>" + inline(h[1], tre, hl) + "</h4>"; continue; }
    if (l.trim() === "---") { out += "<hr>"; continue; }
    if (l.trim()) out += "<p>" + inline(l, tre, hl) + "</p>";
  }
  if (list) out += "</ul>"; return out;
}
function excerpt(n) { return n.body.replace(/[⟦⟧*#`]/g, "").replace(/^\s*[-*•]\s*/gm, "").split("\n").filter(Boolean).slice(0, 4).join(" · "); }

/* ============ lock screen ============ */
async function showLock(mode) {
  S.doc = null; mini = null; idfCache = null;
  closeModal(); $("#palette").hidden = true;
  const has = await vault.hasVault().catch(() => false);
  mode = mode || (has ? "unlock" : "create");
  const root = $("#root");
  root.innerHTML = `<div class="lock"><form class="lockcard" id="lockform" autocomplete="off">
    <div class="lockmark">Carry<em>over</em></div>
    ${mode === "create" ? `
      <p>Your notebook lives only on this device, encrypted with a passphrase you choose. There is no account and no server.</p>
      <div class="field"><label for="p1">Choose a passphrase</label><input id="p1" type="password" minlength="10" required autocomplete="new-password"></div>
      <div class="field"><label for="p2">Type it again</label><input id="p2" type="password" required autocomplete="new-password"></div>
      <p class="small muted">At least 10 characters. A short sentence works well. <b>If you forget it, your notes can't be recovered</b>, not even by you.</p>
      <button class="btn pink" type="submit">Create my notebook</button>
      <label class="small muted">Moving from another device? <button type="button" class="lnk" data-act="restore">Restore a backup file</button></label>`
    : `
      <p>Enter your passphrase to open your notebook.</p>
      <div class="field"><label for="p1">Passphrase</label><input id="p1" type="password" required autocomplete="current-password"></div>
      <button class="btn pink" type="submit">Unlock</button>
      <div class="row small"><button type="button" class="lnk" data-act="restore">Restore a backup file</button></div>`}
    <p class="err" id="lockerr" role="alert"></p>
    <input type="file" id="restorefile" accept=".carryover,application/json" hidden>
  </form></div>`;
  $("#p1").focus();
  $("#lockform").onsubmit = async e => {
    e.preventDefault();
    const p1 = $("#p1").value, err = $("#lockerr"); err.textContent = "";
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = mode === "create" ? "Creating…" : "Unlocking…";
    try {
      if (mode === "create") {
        if (p1.length < 10) throw new Error("short");
        if (p1 !== $("#p2").value) throw new Error("mismatch");
        await vault.create(p1); S.doc = emptyDoc(); await vault.put("doc", S.doc);
        vault.requestPersistence();
      } else {
        await vault.unlock(p1); S.doc = (await vault.get("doc")) || emptyDoc();
        S.doc = { ...emptyDoc(), ...S.doc, settings: { ...emptyDoc().settings, ...(S.doc.settings || {}) } };
      }
      startSession();
    } catch (x) {
      btn.disabled = false; btn.textContent = mode === "create" ? "Create my notebook" : "Unlock";
      err.textContent = { short: "Use at least 10 characters.", mismatch: "The two passphrases don't match.", wrong_passphrase: "That passphrase doesn't open this notebook." }[x.message] || "Something went wrong opening your notebook.";
    }
  };
  $("#restorefile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (has && !confirmedRestore) { pendingRestore = data; return openConfirmRestore(); }
      await vault.importBackup(data); toast("Backup restored. Unlock it with that backup's passphrase."); showLock("unlock");
    } catch { $("#lockerr").textContent = "That file isn't a Carryover backup."; }
  };
}
let pendingRestore = null, confirmedRestore = false;
function openConfirmRestore() {
  openModal(`<h2>Replace this notebook?</h2><p>Restoring a backup replaces everything currently stored on this device with the backup's contents.</p>
    <div class="row end"><button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn danger" data-act="dorestore">Replace</button></div>`);
}

/* ============ session / auto-lock ============ */
let lastActive = Date.now(), lockTimer = null;
function startSession() {
  lastActive = Date.now();
  clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    const mins = S.doc?.settings?.autoLockMin ?? 10;
    if (S.doc && mins > 0 && Date.now() - lastActive > mins * 60000) doLock("Locked after inactivity.");
  }, 15000);
  S.view = "notebook"; render();
  ai.summarizerStatus().then(s => { S.aiStatus.sum = s; });
  ai.promptStatus().then(s => { S.aiStatus.prompt = s; });
}
async function doLock(msg) {
  try { await flush(); } catch {}
  vault.lock(); clearInterval(lockTimer);
  S.cap = { stage: "input", shots: [], drafts: [], busy: false, pasted: "" }; S.ask = { q: "", ran: false, aiText: "", aiBusy: false };
  await showLock("unlock"); if (msg) toast(msg);
}
["pointerdown", "keydown", "scroll", "touchstart"].forEach(ev => addEventListener(ev, () => (lastActive = Date.now()), { passive: true }));

/* ============ shell ============ */
const NAV = [["notebook", "Notebook"], ["ask", "Ask"], ["followups", "Follow-ups"], ["glossary", "Glossary"], ["context", "Context map"], ["settings", "Settings"], ["brief", "Product brief"]];
function render() {
  if (!S.doc) return;
  const root = $("#root");
  const y = scrollY, act = document.activeElement, fid = act?.id, caret = act?.selectionStart;
  const openQs = S.doc.questions.filter(q => q.status === "open").length;
  root.innerHTML = `
    <header class="top">
      <button class="brand" data-view="notebook" aria-label="Carryover home"><span class="wordmark">Carry<em>over</em></span></button>
      <span class="lockchip" title="Encrypted on this device"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>Encrypted on device</span>
      <nav class="nav" aria-label="Views">${NAV.map(([k, l]) => `<button data-view="${k}" aria-current="${S.view === k || (k === "notebook" && S.view === "note")}">${l}${k === "followups" && openQs ? ` · ${openQs}` : ""}</button>`).join("")}</nav>
      <div class="tools">
        <button class="pill" data-act="palette" title="Quick lookup"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>Look up<span class="kbd">/</span></button>
        <button class="btn pink sm" data-view="capture">+ Add pages</button>
        <button class="btn ghost sm" data-act="lock">Lock</button>
      </div>
    </header>
    <main id="main">${viewHtml()}</main>`;
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus({ preventScroll: true }); try { if (caret != null) el.setSelectionRange(caret, caret); } catch {} } }
  scrollTo(0, y);
  afterRender();
}
function viewHtml() {
  switch (S.view) {
    case "note": return viewNote();
    case "capture": return viewCapture();
    case "ask": return viewAsk();
    case "followups": return viewFollowups();
    case "glossary": return viewGlossary();
    case "context": return viewContext();
    case "settings": return viewSettings();
    case "brief": return viewBrief();
    default: return viewNotebook();
  }
}
function go(view, extra = {}) { Object.assign(S, extra); S.view = view; S.editing = extra.editing || false; render(); scrollTo(0, 0); }

/* ============ notebook ============ */
function filteredNotes() {
  let list = S.doc.notes;
  if (S.groupBy === "section" && S.sec !== "__all" && S.sec !== "__review" && S.sec !== "__pinned") list = list.filter(n => n.sectionId === S.sec);
  if (S.sec === "__review") list = list.filter(n => unresolved(n) || n.ctx?.status === "Needs verification");
  if (S.sec === "__pinned") list = list.filter(n => n.pinned);
  for (const f of ["system", "env", "status"]) if (S.filters[f]) list = list.filter(n => (n.ctx?.[f] || "") === S.filters[f]);
  if (S.q.trim()) { const ids = new Set(index().search(S.q, { filter: r => r.kind === "note" }).map(r => r.ref)); list = list.filter(n => ids.has(n.id)); }
  return [...list].sort((a, b) => (b.pinned - a.pinned) || (a.order ?? 0) - (b.order ?? 0) || (b.date || "").localeCompare(a.date || ""));
}
function tabsHtml() {
  const count = id => S.doc.notes.filter(n => n.sectionId === id).length;
  const review = S.doc.notes.filter(n => unresolved(n) || n.ctx?.status === "Needs verification").length;
  const pinned = S.doc.notes.filter(n => n.pinned).length;
  const t = (key, label, n, cls = "", col = "") => `<button class="tab ${cls}" data-sec="${esc(key)}" ${key.startsWith("__") ? "" : `data-droptab="${esc(key)}"`} aria-current="${S.sec === key}" ${col ? `style="--tc:${col}"` : ""}><span>${esc(label)}</span><span class="n">${n}</span></button>`;
  return `<aside class="tabs" aria-label="Sections">
    ${t("__all", "All notes", S.doc.notes.length, "smart")}
    ${pinned ? t("__pinned", "Pinned", pinned, "smart") : ""}
    ${review ? t("__review", "To check", review, "smart") : ""}
    <hr>
    ${sortedSections().map(s => t(s.id, s.name, count(s.id), "", `var(--t${s.color})`)).join("")}
    <button class="tab add" data-act="newsection"><span>+ New section</span></button>
    <button class="tab add" data-act="managesections"><span>Arrange sections</span></button>
  </aside>`;
}
function noteCard(n) {
  const u = unresolved(n);
  return `<button class="note" draggable="true" data-open="${n.id}" data-drag="${n.id}" style="--tc:${secColor(n.sectionId)}">
    ${n.pinned ? `<span class="pin">Pinned</span>` : ""}
    <span class="meta"><span class="chip" style="--tc:${secColor(n.sectionId)}">${esc(secName(n.sectionId))}</span><span class="mono">${esc(fmtDate(n.date))}</span></span>
    <h3>${esc(n.title.replace(/[⟦⟧]/g, ""))}</h3>
    <span class="excerpt">${esc(excerpt(n))}</span>
    <span class="meta">
      ${n.ctx?.system ? `<span class="chip line">${esc(n.ctx.system)}</span>` : ""}
      ${n.ctx?.env && n.ctx.env !== "Any" ? `<span class="chip line">${esc(n.ctx.env)}</span>` : ""}
      ${n.ctx?.status === "Needs verification" ? `<span class="chip warn">Needs verification</span>` : n.ctx?.status === "Outdated" ? `<span class="chip bad">Outdated</span>` : ""}
      ${u ? `<span class="chip warn">${plural(u, "word")} to check</span>` : ""}
    </span>
  </button>`;
}
function groupsFor(list) {
  if (S.groupBy === "section") return [[null, list]];
  const key = { system: n => n.ctx?.system || "No system set", env: n => n.ctx?.env || "No environment set", status: n => n.ctx?.status || "Confirmed", date: n => (n.date || "").slice(0, 7) || "Undated", team: n => n.ctx?.team || "No team set" }[S.groupBy];
  const m = new Map(); for (const n of list) { const k = key(n); if (!m.has(k)) m.set(k, []); m.get(k).push(n); }
  let entries = [...m];
  if (S.groupBy === "date") entries.sort((a, b) => b[0].localeCompare(a[0])).forEach(e => { if (/^\d{4}-\d{2}$/.test(e[0])) e[0] = new Date(e[0] + "-15").toLocaleDateString(undefined, { month: "long", year: "numeric" }); });
  else entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries;
}
function viewNotebook() {
  if (!S.doc.notes.length) return `<div class="desk"><section class="book"><div class="empty">
      <h3>Your notebook is empty</h3>
      <p class="muted" style="max-width:52ch">Add a photo of today's page, or paste text from your phone. Or explore with a few example notes first; you can delete them anytime.</p>
      <div class="row" style="justify-content:center"><button class="btn pink" data-view="capture">Add my first page</button><button class="btn ghost" data-act="examples">Load example notes</button></div>
    </div></section>${tabsHtml()}</div>`;
  const list = filteredNotes();
  const isSec = !S.sec.startsWith("__") && S.groupBy === "section";
  const sec = isSec ? secById(S.sec) : null;
  const label = sec ? sec.name : { __all: "All notes", __review: "To check", __pinned: "Pinned" }[S.sec] || "All notes";
  const opt = (v, cur, l) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`;
  const sel = (f, l, vals) => `<select id="f-${f}" data-filter="${f}" aria-label="Filter by ${l}">${opt("", S.filters[f], "Any " + l.toLowerCase())}${vals.map(v => opt(v, S.filters[f], v)).join("")}</select>`;
  return `<div class="desk"><section class="book">
    <div class="pagehead">
      <div class="stack" style="gap:2px"><h2>${esc(label)}</h2>
        <span class="muted small">${plural(list.length, "note")}${sec?.description ? " · " + esc(sec.description) : ""}${S.sec === "__review" ? " with unclear words or facts to verify" : ""}</span></div>
      <div class="row">
        ${sec ? `<button class="btn ghost sm" data-act="summarysec">Summarize section</button><button class="btn ghost sm" data-act="editsection" data-id="${sec.id}">Edit section</button>` : ""}
      </div>
    </div>
    <div class="toolbar">
      <label class="search"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg><input id="q" type="search" placeholder="Filter these notes…" value="${esc(S.q)}" aria-label="Filter notes"></label>
      <select id="groupby" aria-label="Organize by">
        ${[["section", "Organize: my sections"], ["system", "Group by system"], ["team", "Group by team"], ["env", "Group by environment"], ["status", "Group by status"], ["date", "Group by month written"]].map(([v, l]) => opt(v, S.groupBy, l)).join("")}
      </select>
      ${sel("system", "System", uniqueCtx("system"))}${sel("env", "Environment", ENVS.filter(Boolean))}${sel("status", "Status", STATUSES)}
    </div>
    ${S.groupBy === "section" && S.sec !== "__review" ? `<p class="small muted" style="margin:-8px 0 14px">Drag a note onto a tab to move it, or onto another note to reorder.</p>` : ""}
    ${list.length ? groupsFor(list).map(([g, ns]) => `<div class="group">${g ? `<h3>${esc(g)} <span class="mono">${ns.length}</span></h3>` : ""}<div class="notes">${ns.map(noteCard).join("")}</div></div>`).join("")
      : `<div class="empty"><h3>Nothing here</h3><p class="muted">No notes match these filters.</p><button class="btn ghost" data-act="clearfilters">Clear filters</button></div>`}
  </section>${tabsHtml()}</div>`;
}

/* ============ note page ============ */
function viewNote() {
  const n = noteById(S.noteId); if (!n) { S.view = "notebook"; return viewNotebook(); }
  if (S.editing) return editNoteHtml(n);
  const idfn = idf();
  const sum = T.summarize(n.body.replace(/[⟦⟧]/g, ""), idfn, { max: 4, glossaryTerms: S.doc.glossary.map(g => g.term) });
  const bodyText = n.title + "\n" + n.body;
  const usedTerms = S.doc.glossary.filter(g => new RegExp(`(^|[^A-Za-z0-9])${reEsc(g.term)}($|[^A-Za-z0-9])`).test(bodyText));
  const undef = T.undefinedTerms([n], S.doc.glossary).slice(0, 6);
  const rel = T.related(n, S.doc.notes, idfn);
  const qs = S.doc.questions.filter(q => q.noteId === n.id);
  const u = unresolved(n);
  const c = n.ctx || {};
  return `<div class="notepage">
    <section class="book" style="--tc:${secColor(n.sectionId)}">
      <div class="stack">
        <div class="row spread"><button class="lnk" data-view="notebook">← Back to notebook</button>
          <div class="row"><button class="btn ghost sm" data-act="pin" data-id="${n.id}">${n.pinned ? "Unpin" : "Pin"}</button><button class="btn sm" data-act="edit" data-id="${n.id}">Edit</button></div></div>
        <div class="meta"><button class="chip" style="--tc:${secColor(n.sectionId)}" data-sec="${n.sectionId}">${esc(secName(n.sectionId))}</button><span class="mono">Written ${esc(fmtDate(n.date))}</span>${(n.tags || []).map(t => `<span class="chip line">#${esc(t)}</span>`).join("")}</div>
        <h2>${esc(n.title.replace(/[⟦⟧]/g, ""))}</h2>
        <div class="ctx" aria-label="Where this applies">
          ${CTX_FIELDS.map(([k, l]) => `<div><span class="lbl">${l}</span><b>${esc(c[k] || "—")}</b></div>`).join("")}
        </div>
        ${!c.system && !c.process ? `<div class="ribbon info"><span>Add context so future-you knows which system or process this applies to.</span><button class="btn sm" data-act="edit" data-id="${n.id}">Add context</button></div>` : ""}
        ${u ? `<div class="ribbon"><span>${plural(u, "word")} couldn't be read with confidence and ${u === 1 ? "is" : "are"} highlighted. Compare with the original page and fix in Edit.</span>${n.pageIds?.length ? `<button class="btn sm" data-act="viewpage" data-id="${n.pageIds[0]}">Open page</button>` : ""}</div>` : ""}
        <div class="body">${md(n.body)}</div>
        ${(n.todos || []).length ? `<h3 class="subhead" style="margin-top:8px">Action items</h3><ul class="todos">${n.todos.map((t, i) => `<li class="${t.done ? "done" : ""}"><label><input type="checkbox" ${t.done ? "checked" : ""} data-todo="${n.id}" data-i="${i}"><span>${esc(t.text)}</span></label></li>`).join("")}</ul>` : ""}
        <div class="row" style="margin-top:10px">
          <label class="field" style="flex:0 1 240px"><span class="lbl">Move to section</span><select id="movesec" data-move="${n.id}">${sortedSections().map(s => `<option value="${s.id}" ${s.id === n.sectionId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
          <button class="lnk danger" data-act="delnote" data-id="${n.id}" style="margin-top:18px">Delete note</button>
        </div>
      </div>
    </section>
    <aside class="side">
      <div class="panel">
        <h3>In short</h3>
        <ul style="margin:0;padding-left:18px">${sum.points.map(p => `<li>${md(p).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul>
        <div class="meta">${sum.keyTerms.map(k => `<span class="chip line">${esc(k)}</span>`).join("")}</div>
        ${aiButton("aisumnote", n.id)}
        <div id="aiout" class="body"></div>
      </div>
      <div class="panel">
        <h3>Terms in this note</h3>
        ${usedTerms.length ? `<ul class="list">${usedTerms.map(g => `<li><b>${esc(g.term)}</b>${g.system ? ` <span class="chip line">${esc(g.system)}</span>` : ""}<br><span class="small">${esc(g.meaning)}</span></li>`).join("")}</ul>` : `<p class="small muted">No glossary terms yet.</p>`}
        ${undef.length ? `<p class="small muted">Not defined yet:</p><div class="meta">${undef.map(t => `<button class="chip warn" data-define="${esc(t.term)}">+ ${esc(t.term)}</button>`).join("")}</div>` : ""}
      </div>
      <div class="panel">
        <div class="row spread"><h3>Questions</h3><button class="btn ghost sm" data-act="addq" data-id="${n.id}">+ Ask later</button></div>
        ${qs.length ? `<ul class="list">${qs.map(q => `<li><b>${esc(q.q)}</b><br>${q.answer ? `<span class="small">${esc(q.answer)}</span>` : `<span class="chip warn">Open</span> <button class="lnk" data-act="answerq" data-id="${q.id}">Answer</button>`}</li>`).join("")}</ul>` : `<p class="small muted">Lines ending in “?” become questions to ask a colleague.</p>`}
      </div>
      <div class="panel">
        <h3>Related notes</h3>
        ${rel.length ? `<ul class="list">${rel.map(r => `<li><button class="lnk" data-open="${r.note.id}" style="padding:0"><b>${esc(r.note.title)}</b></button><br><span class="small muted">${esc(secName(r.note.sectionId))}${r.note.ctx?.system ? " · " + esc(r.note.ctx.system) : ""}</span></li>`).join("")}</ul>` : `<p class="small muted">Nothing closely related yet.</p>`}
      </div>
      ${n.pageIds?.length ? `<div class="panel"><h3>Original page${n.pageIds.length > 1 ? "s" : ""}</h3><div class="thumbs" id="thumbs" data-pages="${n.pageIds.join(",")}"></div></div>` : ""}
    </aside>
  </div>`;
}
function aiButton(act, id) {
  const st = act === "aiask" ? S.aiStatus.prompt : S.aiStatus.sum;
  if (st === "unavailable") return "";
  return `<button class="btn ghost sm" data-act="${act}" data-id="${id || ""}">${act === "aiask" ? "Answer with on-device AI" : "Summarize with on-device AI"}${st !== "available" ? " (one-time model download)" : ""}</button>`;
}
function ctxInputs(prefix, c = {}) {
  const dl = f => `<datalist id="${prefix}-dl-${f}">${uniqueCtx(f).map(v => `<option value="${esc(v)}">`).join("")}</datalist>`;
  return `<div class="grid3">${CTX_FIELDS.map(([k, l, ph]) => {
    if (k === "env") return `<div class="field"><label for="${prefix}-env">${l}</label><select id="${prefix}-env">${ENVS.map(v => `<option value="${v}" ${v === (c.env || "") ? "selected" : ""}>${v || "—"}</option>`).join("")}</select></div>`;
    if (k === "status") return `<div class="field"><label for="${prefix}-status">${l}</label><select id="${prefix}-status">${STATUSES.map(v => `<option ${v === (c.status || "Confirmed") ? "selected" : ""}>${v}</option>`).join("")}</select></div>`;
    return `<div class="field"><label for="${prefix}-${k}">${l}</label><input id="${prefix}-${k}" list="${prefix}-dl-${k}" placeholder="${esc(ph)}" value="${esc(c[k] || "")}">${dl(k)}</div>`;
  }).join("")}</div>`;
}
function readCtx(prefix) { const o = {}; for (const [k] of CTX_FIELDS) { const el = document.getElementById(`${prefix}-${k}`); if (el) o[k] = el.value.trim(); } return o; }
function sectionSelect(id, cur) {
  return `<select id="${id}">${sortedSections().map(s => `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${esc(s.name)}</option>`).join("")}<option value="__new">+ New section…</option></select>`;
}
function editNoteHtml(n) {
  return `<section class="book"><form class="stack" id="editform" style="max-width:860px">
    <div class="row spread"><h2>Edit note</h2><div class="row"><button type="button" class="btn ghost" data-act="canceledit">Cancel</button><button class="btn pink" type="submit">Save</button></div></div>
    <div class="grid2">
      <div class="field"><label for="ed-title">Title</label><input id="ed-title" value="${esc(n.title)}" required></div>
      <div class="grid2"><div class="field"><label for="ed-sec">Section</label>${sectionSelect("ed-sec", n.sectionId)}</div>
        <div class="field"><label for="ed-date">Date written</label><input id="ed-date" type="date" value="${esc(n.date || "")}"></div></div>
    </div>
    <div class="field" id="ed-newsec-wrap" hidden><label for="ed-newsec">New section name</label><input id="ed-newsec"></div>
    <div class="field"><label for="ed-body">Note</label><textarea id="ed-body" class="transcript" style="min-height:280px">${esc(n.body)}</textarea>
      <span class="small muted">Use “- ” for bullets, “## ” for sub-headings, **bold** for key terms. Words in ⟦ ⟧ were hard to read; fix and remove the brackets. Lines ending in “?” become questions, lines starting with “TODO:” become action items.</span></div>
    <h3 class="subhead">Where this applies</h3>
    ${ctxInputs("ed", n.ctx)}
    <div class="field"><label for="ed-tags">Tags (comma separated)</label><input id="ed-tags" value="${esc((n.tags || []).join(", "))}"></div>
  </form></section>`;
}

/* ============ capture ============ */
function viewCapture() {
  const c = S.cap;
  if (c.stage === "edit") return captureEdit();
  if (c.stage === "file") return captureFile();
  return `<div class="cap">
    <section class="panel">
      <h3>Add today's pages</h3>
      <label class="drop" id="drop" for="photos">
        <h3>Drop photos of your pages</h3>
        <span class="muted">or tap to choose · JPG, PNG or WebP · several at once is fine</span>
        <input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>
      </label>
      ${c.shots.length ? `<div class="shots">${c.shots.map((s, i) => `<div class="shot"><img src="${s.url}" alt="Page ${i + 1}" style="transform:rotate(${s.rotate}deg)">
        <div class="row spread"><button class="lnk" data-act="rot" data-i="${i}" aria-label="Rotate page ${i + 1}">↻ Rotate</button><button class="lnk danger" data-act="rmshot" data-i="${i}" aria-label="Remove page ${i + 1}">✕</button></div>
        ${s.status ? `<div class="bar" aria-label="Reading progress"><i style="width:${Math.round((s.progress || 0) * 100)}%"></i></div><span class="small muted">${esc(s.status)}</span>` : ""}</div>`).join("")}</div>` : ""}
      <div class="row">
        <button class="btn pink" data-act="runocr" ${!c.shots.length || c.busy ? "disabled" : ""}>${c.busy ? "Reading on this device…" : "Read handwriting"}</button>
        ${c.shots.length && !c.busy ? `<button class="btn ghost" data-act="skipocr">Type it myself instead</button>` : ""}
      </div>
      <div class="field" style="margin-top:6px"><label for="pasted">Or paste text</label>
        <textarea id="pasted" placeholder="Paste text copied from your phone's Live Text, or type your notes here.">${esc(c.pasted)}</textarea></div>
      <div class="row"><button class="btn" data-act="usepasted" ${c.busy ? "disabled" : ""}>Use this text</button></div>
    </section>
    <aside class="side">
      <div class="panel">
        <h3>How reading works</h3>
        <ol class="steps">
          <li>Text is recognized <b>on this device</b>. Photos and text never leave your browser.</li>
          <li>Words it isn't sure about are marked ⟦like this⟧ so you can check them against the photo.</li>
          <li>You split the page into topics, then file each one into your sections with context.</li>
        </ol>
      </div>
      <div class="panel">
        <h3>Best accuracy on iPhone</h3>
        <p class="small">The built-in recognizer is good with neat print but weak on joined-up handwriting. Your iPhone's Live Text reads handwriting much better, and it also runs on the device:</p>
        <ol class="steps small"><li>Open the photo in Photos (or point the Camera at the page).</li><li>Tap the Live Text icon, then Select All → Copy.</li><li>Paste into “Or paste text” here. Add the photo too if you want it kept with the note.</li></ol>
      </div>
      <div class="panel"><h3>Photo tips</h3><p class="small">One page per photo, flat, in daylight, filling the frame. Dark pen beats pencil.</p></div>
    </aside>
  </div>`;
}
function captureEdit() {
  const c = S.cap;
  return `<section class="book"><div class="stack">
    <div class="row spread"><div><h2>Check the text</h2><p class="muted small">Fix anything misread, then mark where each topic starts.</p></div>
      <div class="row"><button class="btn ghost" data-act="capback">Back</button><button class="btn pink" data-act="tofile">Next: file notes →</button></div></div>
    <div class="ribbon info"><span>Put <b>---</b> on its own line wherever a new topic starts. Each part becomes its own note. “Suggest breaks” guesses from headings.</span></div>
    ${c.shots.map((s, i) => {
      const unsure = (s.text.match(/⟦/g) || []).length;
      return `<div class="pageedit">
        <div class="stack"><span class="lbl">Page ${i + 1}${s.confidence != null ? ` · recognizer confidence ${s.confidence}%` : ""}</span>
          ${s.url ? `<div class="photo" id="ph-${i}"><img src="${s.url}" alt="Page ${i + 1}" data-zoom="${i}" style="transform:rotate(${s.rotate}deg)"></div><span class="small muted">Tap the photo to zoom.</span>` : `<p class="muted small">Typed or pasted text.</p>`}</div>
        <div class="stack">
          <div class="row spread"><span class="chip ${unsure ? "warn" : ""}">${unsure ? plural(unsure, "word") + " to check" : "No unsure words"}</span>
            <div class="row">${unsure ? `<button class="btn ghost sm" data-act="nextunsure" data-i="${i}">Next unsure word</button>` : ""}<button class="btn ghost sm" data-act="splits" data-i="${i}">Suggest breaks</button></div></div>
          <textarea class="inp transcript" id="tx-${i}" data-tx="${i}" aria-label="Text of page ${i + 1}">${esc(s.text)}</textarea>
          ${s.confidence != null && s.confidence < 55 ? `<p class="small err" style="font-weight:600">This page was hard to read. It may be faster to retype the key points, or use Live Text on your phone and paste.</p>` : ""}
        </div></div>`;
    }).join("")}
  </div></section>`;
}
function captureFile() {
  const c = S.cap;
  const kept = c.drafts.filter(d => d.include).length;
  return `<section class="book"><div class="stack">
    <div class="row spread"><div><h2>File ${plural(c.drafts.length, "note")}</h2><p class="muted small">Pick a section and say where each note applies. Suggestions come from what's already in each section.</p></div>
      <div class="row"><button class="btn ghost" data-act="capback2">Back</button><button class="btn pink" data-act="savedrafts" ${kept ? "" : "disabled"}>Save ${plural(kept, "note")}</button></div></div>
    ${c.drafts.length > 1 ? `<div class="ribbon info"><span>Same context for all? Fill in the first note, then copy it to the rest.</span><button class="btn sm" data-act="ctxall">Copy first note's context to all</button></div>` : ""}
    ${c.drafts.map((d, i) => `<div class="draft ${d.include ? "" : "off"}">
      <div class="row spread"><label class="row small" style="font-weight:800"><input type="checkbox" data-dinc="${i}" ${d.include ? "checked" : ""}> Keep note ${i + 1}</label>
        <span class="mono">${d.pageIndex != null ? "from page " + (d.pageIndex + 1) : ""}</span></div>
      <div class="grid2">
        <div class="field"><label for="d${i}-title">Title</label><input id="d${i}-title" data-d="${i}" data-k="title" value="${esc(d.title)}"></div>
        <div class="field"><label for="d${i}-sec">Section</label>
          <select id="d${i}-sec" data-dsec="${i}">${sortedSections().map(s => `<option value="${s.id}" ${s.id === d.sectionId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}<option value="__new" ${d.sectionId === "__new" ? "selected" : ""}>+ New section…</option></select>
          ${d.sectionId === "__new" || !S.doc.sections.length ? `<input id="d${i}-newsec" class="inp" data-d="${i}" data-k="newSection" placeholder="New section name, e.g. Release Process" value="${esc(d.newSection || "")}" style="margin-top:6px">` : ""}
          ${d.suggest?.length ? `<div class="meta" style="margin-top:4px"><span class="small muted">Suggested:</span>${d.suggest.map(s => `<button class="chip" style="--tc:${secColor(s.id)}" data-pick="${i}" data-sid="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}
        </div>
      </div>
      <div class="field"><label for="d${i}-body">Note</label><textarea id="d${i}-body" data-d="${i}" data-k="body">${esc(d.body)}</textarea></div>
      <details ${i === 0 ? "open" : ""}><summary class="lbl" style="cursor:pointer">Where this applies</summary><div style="margin-top:8px">${ctxInputs("d" + i, d.ctx)}</div></details>
      <div class="field"><label for="d${i}-tags">Tags</label><input id="d${i}-tags" data-d="${i}" data-k="tags" value="${esc(d.tags)}" placeholder="comma separated"></div>
      ${T.extractQuestions(d.body).length || T.extractTodos(d.body).length ? `<p class="small muted">Found ${plural(T.extractQuestions(d.body).length, "question")} and ${plural(T.extractTodos(d.body).length, "action item")}; they'll go to Follow-ups.</p>` : ""}
    </div>`).join("")}
  </div></section>`;
}
async function addShots(files) {
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast(`${f.name}: use a JPG, PNG or WebP photo. On iPhone, set Camera to “Most Compatible”.`); continue; }
    S.cap.shots.push({ file: f, url: URL.createObjectURL(f), rotate: 0, text: "", status: "", progress: 0 });
  }
  render();
}
async function runOcr() {
  const c = S.cap; c.busy = true; render();
  for (const s of c.shots) {
    try {
      s.status = "Preparing photo…"; s.progress = 0.05; render();
      const { photo, cleaned } = await ocr.prepareImage(s.file, s.rotate);
      s.photo = photo;
      s.status = "Loading recognizer…"; render();
      const res = await ocr.recognize(cleaned, m => {
        if (m.status === "recognizing text") { s.status = "Reading…"; s.progress = m.progress; }
        else if (/load/.test(m.status)) { s.status = "Loading recognizer (first time only)…"; }
        const bar = document.querySelector(`.shot:nth-child(${c.shots.indexOf(s) + 1}) .bar i`); if (bar) bar.style.width = Math.round((m.progress || 0) * 100) + "%";
      });
      s.text = res.text; s.confidence = res.confidence; s.status = res.text ? `Done · ${res.unsure} unsure word${res.unsure === 1 ? "" : "s"}` : "No text found"; s.progress = 1;
    } catch (e) {
      console.error(e); s.status = e.message === "image_unreadable" ? "Couldn't open this photo" : "Couldn't read this page"; s.text = s.text || "";
      if (!s.photo) try { s.photo = (await ocr.prepareImage(s.file, s.rotate)).photo; } catch {}
    }
    render();
  }
  c.busy = false; c.stage = "edit"; render(); scrollTo(0, 0);
}
async function skipOcr() {
  for (const s of S.cap.shots) { try { s.photo = (await ocr.prepareImage(s.file, s.rotate)).photo; } catch {} s.text = s.text || ""; s.confidence = null; }
  S.cap.stage = "edit"; render();
}
function toFile() {
  const c = S.cap; const drafts = [];
  c.shots.forEach((s, pi) => {
    for (const part of T.splitNotes(s.text)) drafts.push(makeDraft(part, pi));
  });
  if (!drafts.length) { toast("There's no text yet. Type or paste what the page says first."); return; }
  c.drafts = drafts; c.stage = "file"; render(); scrollTo(0, 0);
}
function makeDraft(part, pageIndex) {
  const suggest = S.doc.sections.length ? T.suggestSections(part.title + " " + part.body, S.doc.notes, S.doc.sections, idf()) : [];
  return { title: part.title, body: part.body, pageIndex, include: true, tags: "", ctx: { status: /⟦/.test(part.body) ? "Needs verification" : "Confirmed" },
    sectionId: suggest[0]?.id || S.doc.sections[0]?.id || "__new", newSection: "", suggest };
}
async function saveDrafts() {
  const c = S.cap;
  c.drafts.forEach((d, i) => { d.ctx = readCtx("d" + i); });
  const keep = c.drafts.filter(d => d.include);
  if (keep.some(d => d.sectionId === "__new" && !d.newSection.trim())) { toast("Name the new section for each note that needs one."); return; }
  const btn = document.querySelector('[data-act="savedrafts"]'); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const pageIds = {};
    for (const pi of new Set(keep.map(d => d.pageIndex).filter(x => x != null))) {
      const s = c.shots[pi]; if (!s?.photo) continue;
      const id = uid(); pageIds[pi] = id;
      await vault.put("page:" + id, { photo: s.photo, text: s.text, confidence: s.confidence, createdAt: nowIso() });
    }
    const date = today();
    for (const d of keep) {
      const sectionId = d.sectionId === "__new" ? ensureSection(d.newSection) : d.sectionId;
      const id = uid();
      const note = { id, sectionId, title: d.title.trim() || "Untitled note", body: d.body.trim(), tags: d.tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean),
        ctx: d.ctx, todos: T.extractTodos(d.body).map(text => ({ text, done: false })), pageIds: pageIds[d.pageIndex] ? [pageIds[d.pageIndex]] : [],
        date, pinned: false, order: S.doc.notes.length, createdAt: nowIso(), updatedAt: nowIso() };
      S.doc.notes.push(note); syncQuestions(note);
    }
    c.shots.forEach(s => s.url && URL.revokeObjectURL(s.url));
    S.cap = { stage: "input", shots: [], drafts: [], busy: false, pasted: "" };
    commit({ render: false }); await flush();
    toast(`Saved ${plural(keep.length, "note")}.`); go("notebook", { sec: "__all", q: "" });
  } catch (e) { console.error(e); toast("Couldn't save. Your browser storage may be full."); if (btn) { btn.disabled = false; btn.textContent = "Save"; } }
}
function syncQuestions(n) {
  for (const q of T.extractQuestions(n.body)) {
    if (!S.doc.questions.some(x => x.noteId === n.id && x.q === q)) S.doc.questions.push({ id: uid(), q, answer: "", noteId: n.id, status: "open", createdAt: nowIso() });
  }
}

/* ============ ask ============ */
function viewAsk() {
  const a = S.ask; let results = "";
  if (a.ran && a.q.trim()) {
    const idfn = idf();
    const lines = T.answerLines(a.q, S.doc.notes, idfn, 6);
    const hits = index().search(a.q).slice(0, 8);
    const qToks = T.tokens(a.q);
    const terms = S.doc.glossary.filter(g => a.q.toLowerCase().includes(g.term.toLowerCase()) || hits.some(h => h.kind === "term" && h.ref === g.id));
    const qa = hits.filter(h => h.kind === "question").map(h => S.doc.questions.find(q => q.id === h.ref)).filter(q => q?.answer);
    const noteHits = hits.filter(h => h.kind === "note").map(h => noteById(h.ref)).filter(Boolean).slice(0, 5);
    const nothing = !lines.length && !terms.length && !qa.length && !noteHits.length;
    results = `
      ${terms.length ? `<div class="panel"><h3>Definitions</h3><ul class="list">${terms.map(g => `<li><b>${esc(g.term)}</b>${g.system ? ` <span class="chip line">${esc(g.system)}</span>` : ""}: ${esc(g.meaning)}</li>`).join("")}</ul></div>` : ""}
      ${lines.length ? `<div class="stack"><h3 class="subhead">What your notes say</h3>${lines.map(l => `<div class="hitline"><div class="body">${md(l.line, { hl: qToks })}</div>
        <div class="meta"><button class="lnk" data-open="${l.note.id}" style="padding:0"><b>${esc(l.note.title)}</b></button><span class="chip" style="--tc:${secColor(l.note.sectionId)}">${esc(secName(l.note.sectionId))}</span>${l.note.ctx?.system ? `<span class="chip line">${esc(l.note.ctx.system)}</span>` : ""}${l.note.ctx?.env ? `<span class="chip line">${esc(l.note.ctx.env)}</span>` : ""}${l.note.ctx?.status === "Needs verification" ? `<span class="chip warn">Needs verification</span>` : ""}</div></div>`).join("")}</div>` : ""}
      ${qa.length ? `<div class="panel"><h3>Answered questions</h3><ul class="list">${qa.map(q => `<li><b>${esc(q.q)}</b><br><span class="small">${esc(q.answer)}</span></li>`).join("")}</ul></div>` : ""}
      ${noteHits.length ? `<div class="panel"><h3>Notes to read</h3><ul class="list">${noteHits.map(n => `<li><button class="lnk" data-open="${n.id}" style="padding:0"><b>${esc(n.title)}</b></button> <span class="small muted">${esc(secName(n.sectionId))}</span></li>`).join("")}</ul></div>` : ""}
      ${aiButton("aiask") && !nothing ? `<div class="panel"><h3>Written answer</h3>${aiButton("aiask")}<div id="aiout" class="body">${a.aiText ? md(a.aiText) : ""}</div></div>` : ""}
      <div class="ribbon ${nothing ? "" : "info"}"><span>${nothing ? "Your notes don't cover this yet." : "Not what you needed?"} Save it as a question to ask someone.</span><button class="btn sm" data-act="asklater">Add to Follow-ups</button></div>`;
  }
  return `<section class="book"><div class="stack" style="max-width:820px">
    <div><h2>Ask your notes</h2><p class="muted small">Finds the exact lines that answer your question, with where they apply. Everything runs on this device.</p></div>
    <form id="askform" class="stack">
      <div class="field"><label for="askq">Question</label><input id="askq" class="inp" value="${esc(a.q)}" placeholder="When is the CAB cutoff?" autocomplete="off"></div>
      <div class="row"><button class="btn pink" type="submit">Find answer</button>
        ${S.doc.notes.length ? ["What do I need before a prod release?", "Who owns the data definitions?", "What does UAT sign-off need?"].map(s => `<button type="button" class="pill small" data-askq="${esc(s)}">${esc(s)}</button>`).join("") : ""}</div>
    </form>
    ${results}
  </div></section>`;
}

/* ============ follow-ups ============ */
function viewFollowups() {
  const qs = S.doc.questions, open = qs.filter(q => q.status === "open"), done = qs.filter(q => q.status !== "open");
  const todos = []; for (const n of S.doc.notes) (n.todos || []).forEach((t, i) => todos.push({ n, t, i }));
  const tab = (k, l) => `<button class="pill" data-fu="${k}" aria-current="${S.fu === k}" style="${S.fu === k ? "background:var(--ink);color:var(--paper);border-color:var(--ink)" : ""}">${l}</button>`;
  const qItem = q => { const n = noteById(q.noteId); return `<div class="qa"><div class="row spread"><span class="q">${esc(q.q)}</span>${q.status === "open" ? `<span class="chip warn">Open</span>` : `<span class="chip" style="--tc:var(--t2)">Answered</span>`}</div>
    ${n ? `<span class="small muted">From <button class="lnk" data-open="${n.id}" style="padding:0">${esc(n.title)}</button></span>` : ""}
    ${q.answer ? `<div class="body small">${md(q.answer)}</div>` : ""}
    <div class="row"><button class="lnk" data-act="answerq" data-id="${q.id}">${q.answer ? "Edit answer" : "Answer"}</button><button class="lnk danger" data-act="delq" data-id="${q.id}">Remove</button></div></div>`; };
  return `<section class="book"><div class="stack" style="max-width:860px">
    <div class="row spread"><div><h2>Follow-ups</h2><p class="muted small">Questions to ask your team, and things you said you'd do.</p></div><button class="btn pink" data-act="addq">+ Question</button></div>
    <div class="row">${tab("questions", `Questions · ${open.length} open`)}${tab("todos", `Action items · ${todos.filter(x => !x.t.done).length}`)}</div>
    ${S.fu === "questions" ? (qs.length ? `${open.map(qItem).join("")}${done.length ? `<h3 class="subhead" style="margin-top:10px">Answered</h3>${done.map(qItem).join("")}` : ""}` : `<div class="empty"><h3>No questions yet</h3><p class="muted">Lines in your notes that end in “?” show up here automatically.</p></div>`)
      : (todos.length ? `<ul class="todos">${todos.sort((a, b) => a.t.done - b.t.done).map(({ n, t, i }) => `<li class="${t.done ? "done" : ""}"><label><input type="checkbox" ${t.done ? "checked" : ""} data-todo="${n.id}" data-i="${i}"><span>${esc(t.text)}</span></label>
          <span class="small muted" style="margin-left:26px">from <button class="lnk" data-open="${n.id}" style="padding:0">${esc(n.title)}</button></span></li>`).join("")}</ul>`
        : `<div class="empty"><h3>No action items</h3><p class="muted">Start a line with “TODO:” or “[ ]” and it lands here.</p></div>`)}
  </div></section>`;
}

/* ============ glossary ============ */
function viewGlossary() {
  const q = S.glossQ.trim().toLowerCase();
  const list = [...S.doc.glossary].filter(g => !q || (g.term + " " + g.meaning + " " + (g.system || "")).toLowerCase().includes(q)).sort((a, b) => a.term.localeCompare(b.term));
  const undef = T.undefinedTerms(S.doc.notes, S.doc.glossary).slice(0, 18);
  const uses = g => S.doc.notes.filter(n => (n.title + " " + n.body).includes(g.term)).length;
  return `<section class="book"><div class="stack" style="max-width:900px">
    <div class="row spread"><div><h2>Glossary</h2><p class="muted small">Team acronyms and jargon. Defined terms are underlined in every note; tap one to see what it means.</p></div><button class="btn pink" data-act="addterm">+ Term</button></div>
    ${undef.length ? `<div class="panel"><h3>Used in your notes, not defined yet</h3><div class="meta">${undef.map(t => `<button class="chip warn" data-define="${esc(t.term)}">+ ${esc(t.term)} <span class="mono">×${t.count}</span></button>`).join("")}</div></div>` : ""}
    <label class="search" style="flex:0 1 auto;max-width:360px"><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg><input id="glossq" type="search" placeholder="Find a term…" value="${esc(S.glossQ)}"></label>
    ${list.length ? `<div class="cols">${list.map(g => `<div class="card" id="term-${g.id}"><div class="row spread"><h4>${esc(g.term)}</h4><span class="mono">${uses(g)} note${uses(g) === 1 ? "" : "s"}</span></div>
      ${g.system ? `<span class="chip line">applies to ${esc(g.system)}</span>` : ""}<p class="small">${esc(g.meaning)}</p>
      <div class="row"><button class="lnk" data-act="editterm" data-id="${g.id}">Edit</button><button class="lnk" data-act="termnotes" data-term="${esc(g.term)}">Notes using it</button><button class="lnk danger" data-act="delterm" data-id="${g.id}">Delete</button></div></div>`).join("")}</div>`
      : `<div class="empty"><h3>${S.doc.glossary.length ? "No match" : "No terms yet"}</h3><p class="muted">Add acronyms like CAB, UAT or your system names once, and they explain themselves everywhere.</p></div>`}
  </div></section>`;
}
function openTermForm(g = {}, preset = "") {
  openModal(`<form id="termform" class="stack"><h2>${g.id ? "Edit term" : "Define a term"}</h2>
    <div class="field"><label for="tm-term">Term</label><input id="tm-term" value="${esc(g.term || preset)}" required></div>
    <div class="field"><label for="tm-meaning">What it means here</label><textarea id="tm-meaning" required placeholder="In our team, CAB is the Change Advisory Board that approves prod changes every Tuesday.">${esc(g.meaning || "")}</textarea></div>
    <div class="field"><label for="tm-system">Applies to (system or team, optional)</label><input id="tm-system" list="tm-dl" value="${esc(g.system || "")}"><datalist id="tm-dl">${uniqueCtx("system").map(v => `<option value="${esc(v)}">`).join("")}</datalist></div>
    <input type="hidden" id="tm-id" value="${esc(g.id || "")}">
    <div class="row end"><button type="button" class="btn ghost" data-act="closemodal">Cancel</button><button class="btn pink" type="submit">Save term</button></div></form>`);
  $(g.id || preset ? "#tm-meaning" : "#tm-term").focus();
}

/* ============ context map ============ */
function viewContext() {
  const by = new Map();
  for (const n of S.doc.notes) { const k = n.ctx?.system || ""; if (!by.has(k)) by.set(k, []); by.get(k).push(n); }
  const systems = [...by.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const none = by.get("") || [];
  const chips = (ns, f) => [...new Set(ns.map(n => n.ctx?.[f]).filter(Boolean))].map(v => `<span class="chip line">${esc(v)}</span>`).join("") || `<span class="small muted">—</span>`;
  return `<section class="book"><div class="stack">
    <div><h2>Context map</h2><p class="muted small">What applies to what: every system you've taken notes on, with its teams, processes, environments, terms and open questions.</p></div>
    ${systems.length ? `<div class="cols">${systems.map(sys => {
      const ns = by.get(sys); const terms = S.doc.glossary.filter(g => g.system === sys);
      const oq = S.doc.questions.filter(q => q.status === "open" && ns.some(n => n.id === q.noteId)).length;
      const verify = ns.filter(n => n.ctx?.status === "Needs verification").length;
      return `<div class="card"><div class="row spread"><h4>${esc(sys)}</h4><span class="mono">${plural(ns.length, "note")}</span></div>
        <div><span class="lbl">Teams</span><div class="meta">${chips(ns, "team")}</div></div>
        <div><span class="lbl">Processes</span><div class="meta">${chips(ns, "process")}</div></div>
        <div><span class="lbl">Environments</span><div class="meta">${chips(ns, "env")}</div></div>
        ${terms.length ? `<div><span class="lbl">Terms</span><div class="meta">${terms.map(g => `<button class="chip" data-term="${esc(g.term)}" style="--tc:var(--t4)">${esc(g.term)}</button>`).join("")}</div></div>` : ""}
        <div class="meta">${oq ? `<span class="chip warn">${plural(oq, "open question")}</span>` : ""}${verify ? `<span class="chip warn">${verify} to verify</span>` : ""}</div>
        <ul class="list small">${ns.slice(0, 6).map(n => `<li><button class="lnk" data-open="${n.id}" style="padding:0">${esc(n.title)}</button> <span class="muted">${esc(n.ctx?.env || "")}</span></li>`).join("")}${ns.length > 6 ? `<li><button class="lnk" data-act="filtersys" data-sys="${esc(sys)}" style="padding:0">All ${ns.length} notes →</button></li>` : ""}</ul>
      </div>`; }).join("")}</div>` : ""}
    ${none.length ? `<div class="panel"><h3>No system set · ${none.length}</h3><p class="small muted">These notes don't say what they apply to yet. Adding a system makes them show up here and in Ask results.</p>
      <ul class="list">${none.slice(0, 20).map(n => `<li class="row spread"><button class="lnk" data-open="${n.id}" style="padding:0">${esc(n.title)}</button><button class="btn ghost sm" data-act="edit" data-id="${n.id}">Add context</button></li>`).join("")}</ul></div>` : ""}
    ${!S.doc.notes.length ? `<div class="empty"><h3>Nothing to map yet</h3><p class="muted">Add notes and tag them with a system to see them here.</p></div>` : ""}
  </div></section>`;
}

/* ============ settings ============ */
function viewSettings() {
  const st = S.doc.settings;
  return `<section class="book"><div class="stack" style="max-width:760px">
    <h2>Settings & security</h2>
    <div class="panel"><h3>How your data is kept</h3>
      <ul style="margin:0;padding-left:18px" class="small">
        <li>Stored only in this browser on this device, in IndexedDB.</li>
        <li>Encrypted with AES-256-GCM. The key comes from your passphrase (PBKDF2, 600,000 rounds) and exists only in memory while unlocked.</li>
        <li>The app makes no network requests after it loads. There's no account, server, analytics or AI service.</li>
        <li>Clearing this site's data in your browser deletes your notebook. Keep a backup.</li>
      </ul>
      <div id="storageinfo" class="small muted"></div>
    </div>
    <div class="panel"><h3>Auto-lock</h3>
      <div class="field" style="max-width:260px"><label for="autolock">Lock after inactivity</label><select id="autolock">${[[5, "5 minutes"], [10, "10 minutes"], [30, "30 minutes"], [60, "1 hour"], [0, "Never (not recommended)"]].map(([v, l]) => `<option value="${v}" ${v === st.autoLockMin ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
    <div class="panel"><h3>Backup</h3>
      <p class="small">A backup file holds your notebook still encrypted. You need your passphrase to open it. Use it to move to another device or browser.</p>
      <div class="row"><button class="btn" data-act="export">Download encrypted backup</button><button class="btn ghost" data-act="importbk">Restore from backup…</button></div>
      <input type="file" id="importfile" accept=".carryover,application/json" hidden></div>
    <div class="panel"><h3>Change passphrase</h3>
      <form id="pwform" class="stack" autocomplete="off">
        <div class="grid3"><div class="field"><label for="pw-old">Current</label><input id="pw-old" type="password" required autocomplete="current-password"></div>
        <div class="field"><label for="pw-new">New (10+ characters)</label><input id="pw-new" type="password" minlength="10" required autocomplete="new-password"></div>
        <div class="field"><label for="pw-new2">New again</label><input id="pw-new2" type="password" required autocomplete="new-password"></div></div>
        <div class="row"><button class="btn" type="submit">Change passphrase</button><span class="err" id="pwerr"></span></div></form></div>
    <div class="panel"><h3>On-device AI</h3>
      <p class="small">Written summaries and answers: ${S.aiStatus.sum === "unavailable" && S.aiStatus.prompt === "unavailable" ? "not available in this browser. Carryover uses its own built-in summaries instead, which pick out your most important lines." : "available here through Chrome's built-in model, which runs on your device."}</p></div>
    <div class="panel"><h3>Sections</h3><button class="btn ghost" data-act="managesections">Rename, recolor and reorder sections</button></div>
    <div class="panel" style="border:1.5px solid var(--bad)"><h3>Erase everything</h3>
      <p class="small">Deletes every note, page photo and setting from this device. This can't be undone.</p>
      <div class="row"><button class="btn danger" data-act="erase">Erase notebook…</button></div></div>
  </div></section>`;
}

/* ============ product brief ============ */
function viewBrief() {
  const scanned = S.doc.notes.filter(n => n.pageIds?.length).length;
  const withCtx = S.doc.notes.filter(n => n.ctx?.system).length;
  const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "–";
  return `<section class="book"><div class="brief">
    <div><h2>Product <em>brief</em></h2><p class="muted small">v1 · local-first · written from the PM seat</p></div>
    <section><h3><span class="num">1</span>Problem</h3><p>New joiners take knowledge transfer on paper, a fresh page each day. After a month, the answer to “how do we release?” is spread across pages and weeks with no index, and half the notes don't say which system they're about.</p></section>
    <section><h3><span class="num">2</span>Principles</h3><ul>
      <li><b>Private by construction.</b> KT notes are sensitive. Data never leaves the device, so there's nothing to leak and nothing to approve.</li>
      <li><b>You organize; the app suggests.</b> Sections are yours. Suggestions only save clicks.</li>
      <li><b>Context is first-class.</b> Every note says what system, team, process and environment it applies to.</li>
      <li><b>Honest about uncertainty.</b> Unclear words stay marked until you fix them.</li></ul></section>
    <section><h3><span class="num">3</span>Key decisions</h3><div class="tbl"><table>
      <tr><th>Decision</th><th>Chosen</th><th>Trade-off</th></tr>
      <tr><td>Hosting</td><td>Static site on GitHub Pages</td><td>Free and simple, but no server means no sync</td></tr>
      <tr><td>Storage</td><td>Encrypted IndexedDB + encrypted backup file</td><td>Lost passphrase = lost notes; one device at a time</td></tr>
      <tr><td>Handwriting</td><td>On-device recognizer + phone Live Text paste</td><td>Weaker than cloud AI on cursive; review step compensates</td></tr>
      <tr><td>Summaries & answers</td><td>Extractive (your own lines), optional on-device AI</td><td>Less fluent, but never invents facts</td></tr>
    </table></div></section>
    <section><h3><span class="num">4</span>Success metrics</h3>
      <p>No analytics by design. These are computed on your device, for you:</p>
      <div class="cols">
        <div class="card"><h4>${S.doc.notes.length}</h4><span class="small muted">notes captured</span></div>
        <div class="card"><h4>${pct(withCtx, S.doc.notes.length)}</h4><span class="small muted">notes with context (target 80%)</span></div>
        <div class="card"><h4>${scanned}</h4><span class="small muted">notes from photos</span></div>
        <div class="card"><h4>${S.doc.questions.filter(q => q.status !== "open").length}/${S.doc.questions.length}</h4><span class="small muted">questions answered</span></div>
      </div>
      <p class="small muted">North star if this became a product: notes looked up per week per user. Capturing is only worth it if notes get found again.</p></section>
    <section><h3><span class="num">5</span>Roadmap</h3><div class="cols">
      <div class="card"><h4>Next</h4><span class="small">Installable offline app, iOS share-sheet import, bulk move and merge sections.</span></div>
      <div class="card"><h4>Later</h4><span class="small">Optional end-to-end-encrypted sync between your own devices; weekly review of notes to verify.</span></div>
      <div class="card"><h4>Maybe</h4><span class="small">Export a section as a KT pack for the next new joiner.</span></div></div></section>
    <section><h3><span class="num">6</span>Risks</h3><ul>
      <li><b>Employer policy.</b> Some companies don't allow work notes on personal devices at all, encrypted or not. Check before use.</li>
      <li><b>Device loss or cleared browser data.</b> Mitigated by encrypted backups; the app reminds you.</li>
      <li><b>Handwriting accuracy.</b> Mitigated by review, the kept photo, and the “to check” list.</li></ul></section>
  </div></section>`;
}

/* ============ modals ============ */
function openModal(html, wide) { const m = $("#modal"); m.innerHTML = `<div class="sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; }
function closeModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

function openSectionForm(sec) {
  const s = sec || { name: "", color: (S.doc.sections.length % 8) + 1, description: "" };
  openModal(`<form id="secform" class="stack"><h2>${sec ? "Edit section" : "New section"}</h2>
    <div class="field"><label for="sf-name">Name</label><input id="sf-name" value="${esc(s.name)}" required placeholder="e.g. Release Process"></div>
    <div class="field"><label for="sf-desc">What goes here (optional)</label><input id="sf-desc" value="${esc(s.description || "")}" placeholder="Also helps suggest this section for new notes"></div>
    <div class="field"><span class="lbl">Tab color</span><div class="swatches">${[1, 2, 3, 4, 5, 6, 7, 8].map(c => `<button type="button" style="--tc:var(--t${c})" data-swatch="${c}" aria-pressed="${c === s.color}" aria-label="Color ${c}"></button>`).join("")}</div></div>
    <input type="hidden" id="sf-color" value="${s.color}"><input type="hidden" id="sf-id" value="${esc(sec?.id || "")}">
    <div class="row spread">${sec ? `<button type="button" class="lnk danger" data-act="delsection" data-id="${sec.id}">Delete section</button>` : "<span></span>"}
      <div class="row"><button type="button" class="btn ghost" data-act="closemodal">Cancel</button><button class="btn pink" type="submit">Save</button></div></div></form>`);
  $("#sf-name").focus();
}
function openManageSections() {
  const secs = sortedSections();
  openModal(`<h2>Arrange sections</h2><p class="small muted">Order here is the order of your tabs.</p>
    <div class="stack">${secs.map((s, i) => `<div class="secrow"><span class="chip" style="--tc:var(--t${s.color})">&nbsp;</span>
      <div><b>${esc(s.name)}</b> <span class="mono">${S.doc.notes.filter(n => n.sectionId === s.id).length}</span></div>
      <div class="row"><button class="btn ghost sm" data-act="secup" data-id="${s.id}" ${i ? "" : "disabled"} aria-label="Move up">↑</button><button class="btn ghost sm" data-act="secdown" data-id="${s.id}" ${i < secs.length - 1 ? "" : "disabled"} aria-label="Move down">↓</button><button class="btn ghost sm" data-act="editsection" data-id="${s.id}">Edit</button></div></div>`).join("") || `<p class="muted">No sections yet.</p>`}</div>
    <div class="row spread"><button class="btn ghost" data-act="newsection">+ New section</button><button class="btn" data-act="closemodal">Done</button></div>`);
}
function confirmDeleteSection(id) {
  const s = secById(id); const n = S.doc.notes.filter(x => x.sectionId === id).length;
  const others = sortedSections().filter(x => x.id !== id);
  openModal(`<h2>Delete “${esc(s.name)}”?</h2>
    ${n ? `<p>It has ${plural(n, "note")}. Move them to:</p><select id="delsec-to" class="inp">${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}<option value="__unsorted">Unsorted</option></select>` : `<p>This section is empty.</p>`}
    <div class="row end"><button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn danger" data-act="dodelsection" data-id="${id}">Delete section</button></div>`);
}
function openQuestionForm(noteId, preset = "", qid = null) {
  const q = qid ? S.doc.questions.find(x => x.id === qid) : null;
  openModal(`<form id="qform" class="stack"><h2>${q ? "Answer" : "Question to ask"}</h2>
    <div class="field"><label for="qf-q">Question</label><input id="qf-q" value="${esc(q?.q || preset)}" required></div>
    <div class="field"><label for="qf-a">Answer${q ? "" : " (if you already know it)"}</label><textarea id="qf-a" placeholder="Who told you, and what they said">${esc(q?.answer || "")}</textarea></div>
    ${!q ? `<div class="field"><label for="qf-note">Related note (optional)</label><select id="qf-note"><option value="">None</option>${S.doc.notes.map(n => `<option value="${n.id}" ${n.id === noteId ? "selected" : ""}>${esc(n.title)}</option>`).join("")}</select></div>` : ""}
    <input type="hidden" id="qf-id" value="${esc(qid || "")}">
    <div class="row end"><button type="button" class="btn ghost" data-act="closemodal">Cancel</button><button class="btn pink" type="submit">Save</button></div></form>`);
  $(q ? "#qf-a" : "#qf-q").focus();
}
async function openPage(pageId) {
  openModal(`<h2>Original page</h2><p class="muted">Decrypting…</p>`, true);
  const p = await vault.get("page:" + pageId).catch(() => null);
  openModal(`<div class="row spread"><h2>Original page</h2><button class="btn ghost" data-act="closemodal">Close</button></div>
    ${p?.photo ? `<img src="${p.photo}" alt="Photo of the notebook page" style="border-radius:10px">` : `<p class="muted">This photo wasn't saved.</p>`}
    ${p?.text ? `<details><summary class="lbl" style="cursor:pointer">Text as first recognized</summary><pre class="small" style="white-space:pre-wrap">${esc(p.text)}</pre></details>` : ""}`, true);
}
function summarySection() {
  const sec = secById(S.sec); const ns = S.doc.notes.filter(n => n.sectionId === sec.id); const idfn = idf();
  const bySys = new Map(); for (const n of ns) { const k = n.ctx?.system || "General"; if (!bySys.has(k)) bySys.set(k, []); bySys.get(k).push(n); }
  const terms = S.doc.glossary.filter(g => ns.some(n => (n.title + " " + n.body).includes(g.term)));
  const oq = S.doc.questions.filter(q => q.status === "open" && ns.some(n => n.id === q.noteId));
  const todo = ns.flatMap(n => (n.todos || []).filter(t => !t.done).map(t => t.text));
  const verify = ns.filter(n => n.ctx?.status === "Needs verification" || unresolved(n));
  openModal(`<div class="row spread"><h2>${esc(sec.name)} · cheat sheet</h2><button class="btn ghost" data-act="closemodal">Close</button></div>
    <p class="small muted">The most important lines from ${plural(ns.length, "note")}, grouped by system.</p>
    ${[...bySys].map(([sys, list]) => `<div class="panel"><h3>${esc(sys)}</h3>${list.map(n => { const s = T.summarize(n.body.replace(/[⟦⟧]/g, ""), idfn, { max: 3, glossaryTerms: S.doc.glossary.map(g => g.term) });
      return `<div><button class="lnk" data-open="${n.id}" style="padding:0"><b>${esc(n.title)}</b></button>${n.ctx?.env ? ` <span class="chip line">${esc(n.ctx.env)}</span>` : ""}<ul style="margin:4px 0 8px;padding-left:18px" class="small">${s.points.map(p => `<li>${md(p).replace(/^<p>|<\/p>$/g, "")}</li>`).join("")}</ul></div>`; }).join("")}</div>`).join("")}
    ${terms.length ? `<div class="panel"><h3>Terms</h3><ul class="list small">${terms.map(g => `<li><b>${esc(g.term)}</b>: ${esc(g.meaning)}</li>`).join("")}</ul></div>` : ""}
    ${oq.length || todo.length || verify.length ? `<div class="panel"><h3>Still open</h3><ul class="small" style="margin:0;padding-left:18px">${oq.map(q => `<li>Ask: ${esc(q.q)}</li>`).join("")}${todo.map(t => `<li>To do: ${esc(t)}</li>`).join("")}${verify.map(n => `<li>Verify: ${esc(n.title)}</li>`).join("")}</ul></div>` : ""}
    ${aiButton("aisumsec", sec.id)}<div id="aiout" class="body"></div>`, true);
}

/* ============ quick lookup palette ============ */
let palSel = 0, palResults = [];
function openPalette() {
  const p = $("#palette"); p.hidden = false;
  p.innerHTML = `<div class="box" role="dialog" aria-label="Quick lookup"><input id="palq" placeholder="Look up a note, term or answer…" autocomplete="off" aria-label="Look up"><div class="results" id="palres" role="listbox"></div></div>`;
  $("#palq").focus(); palUpdate("");
}
function palUpdate(q) {
  const box = $("#palres"); if (!box) return;
  if (!q.trim()) {
    const recent = [...S.doc.notes].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 6);
    palResults = recent.map(n => ({ kind: "note", ref: n.id, title: n.title, sub: secName(n.sectionId) }));
  } else palResults = index().search(q).slice(0, 12);
  palSel = 0;
  const icon = { note: "Note", term: "Term", question: "Q&A" };
  box.innerHTML = palResults.length ? (q.trim() ? "" : `<p class="small muted" style="padding:6px 12px">Recently edited</p>`) + palResults.map((r, i) => `<button class="res" role="option" aria-selected="${i === palSel}" data-pal="${i}"><b><span class="kind">${icon[r.kind]}</span>${esc(r.title)}</b><span class="muted">${esc(r.sub || "")}</span></button>`).join("")
    : `<p class="muted" style="padding:14px">${q.trim() ? "No matches. Try fewer words." : "No notes yet."}</p>`;
}
function palPick(i) {
  const r = palResults[i]; if (!r) return; $("#palette").hidden = true;
  if (r.kind === "note") go("note", { noteId: r.ref });
  else if (r.kind === "term") { const g = S.doc.glossary.find(x => x.id === r.ref); S.glossQ = g?.term || ""; go("glossary"); }
  else { const q = S.doc.questions.find(x => x.id === r.ref); if (q?.noteId && noteById(q.noteId)) go("note", { noteId: q.noteId }); else go("followups", { fu: "questions" }); }
}

/* ============ term popover ============ */
function showTerm(btn, term) {
  document.querySelectorAll(".pop").forEach(p => p.remove());
  const g = S.doc.glossary.find(x => x.term === term); if (!g) return;
  const pop = document.createElement("div"); pop.className = "pop"; pop.setAttribute("role", "tooltip");
  pop.innerHTML = `<h4>${esc(g.term)}</h4>${g.system ? `<span class="chip line">${esc(g.system)}</span>` : ""}<p class="small" style="margin-top:6px">${esc(g.meaning)}</p><button class="lnk" data-act="termnotes" data-term="${esc(g.term)}" style="padding:4px 0 0">Notes using it →</button>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = r.bottom + scrollY + 6 + "px";
}

/* ============ after render ============ */
async function afterRender() {
  const th = $("#thumbs");
  if (th) {
    const ids = th.dataset.pages.split(",");
    for (const id of ids) {
      const p = await vault.get("page:" + id).catch(() => null);
      if (!document.body.contains(th)) return;
      if (p?.photo) th.insertAdjacentHTML("beforeend", `<button data-page="${id}" aria-label="Open original page"><img src="${p.photo}" alt=""></button>`);
    }
  }
  if (S.view === "settings") {
    const u = await vault.usage(); const persisted = await navigator.storage?.persisted?.().catch(() => false);
    const el = $("#storageinfo"); if (el) el.textContent = `${u ? `Using ${(u.usage / 1048576).toFixed(1)} MB. ` : ""}${persisted ? "Storage is marked persistent, so the browser won't clear it on its own." : "Storage isn't marked persistent yet; the browser could clear it when space runs low. Keep a backup."}`;
  }
}

/* ============ examples ============ */
function loadExamples() {
  const secs = [["Release Process", 1, "How changes get to production"], ["SQL & Data", 5, "Tables, joins, data quirks"], ["Stakeholders", 2, "Who to ask for what"], ["Jira & Agile", 4, "Stories, refinement, ceremonies"]];
  const ids = secs.map(([name, color, description], i) => { const id = uid(); S.doc.sections.push({ id, name, color, description, order: S.doc.sections.length + i }); return id; });
  const d = off => { const x = new Date(); x.setDate(x.getDate() - off); return x.toISOString().slice(0, 10); };
  const notes = [
    [0, "How a change gets to prod", "- Every prod change needs a change ticket with **test evidence** attached\n- CAB meets Tuesdays; submit by Monday noon\n- Deploy windows: Thursday evening only unless emergency\n- Rollback plan required even for config changes\n- Who approves emergency changes?\nTODO: shadow next Thursday's deploy", { system: "Trade Reporting", team: "Release Mgmt", process: "Release", env: "Prod", source: "KT session 2", status: "Confirmed" }, 9],
    [0, "UAT sign-off", "- UAT runs in the UAT env with masked prod data\n- Business owner signs off in the change ticket, not by email\n- Defects found in UAT must be linked to the story\n- Sign-off needed **before** CAB submission", { system: "Trade Reporting", team: "Business Owners", process: "UAT", env: "UAT", source: "Priya", status: "Needs verification" }, 6],
    [1, "Where position data lives", "- Positions come from the daily snapshot table, not the live one\n- Join on **account_id + as_of_date**, never account_id alone\n- Snapshot lands around 6:30am ET, so earlier reports show yesterday\n- Is there a late-snapshot alert?\nTODO: request read access to the snapshot schema", { system: "Snowflake", team: "Data Platform", process: "Daily reporting", env: "Prod", source: "KT session 1", status: "Confirmed" }, 12],
    [1, "Recon job basics", "- Recon batch runs at 2am ET\n- Failures page the on-call; check the recon dashboard first\n- Most failures are late upstream files, rerun after they land\n- Never rerun twice without telling the data team", { system: "Recon Batch", team: "Data Platform", process: "Reconciliation", env: "Prod", source: "Marcus", status: "Confirmed" }, 4],
    [2, "Who to ask for what", "- Requirements sign-off: product owner for the reporting stream\n- Data definitions: data governance office hours on Wednesdays\n- Access requests go through the entitlements portal, not email\n- Write a follow-up after every decision meeting", { system: "", team: "", process: "Onboarding", env: "Any", source: "Manager 1:1", status: "Confirmed" }, 14],
    [3, "Writing a good story", "## Definition of ready\n- As a / I want / so that\n- Acceptance criteria as Given / When / Then\n- Data sources named, with sample rows\n- Sized in refinement, not before", { system: "Jira", team: "Scrum team", process: "Refinement", env: "Any", source: "Scrum master", status: "Confirmed" }, 10],
  ];
  for (const [si, title, body, ctx, off] of notes) {
    const n = { id: uid(), sectionId: ids[si], title, body, tags: ["example"], ctx, todos: T.extractTodos(body).map(text => ({ text, done: false })), pageIds: [], date: d(off), pinned: false, order: S.doc.notes.length, createdAt: nowIso(), updatedAt: nowIso() };
    S.doc.notes.push(n); syncQuestions(n);
  }
  S.doc.glossary.push({ id: uid(), term: "CAB", meaning: "Change Advisory Board. Approves production changes; meets Tuesdays.", system: "Trade Reporting" },
    { id: uid(), term: "UAT", meaning: "User acceptance testing. Business users test before release.", system: "" });
  commit(); toast("Example notes added. They're tagged #example.");
}

/* ============ events ============ */
document.addEventListener("click", async e => {
  if (!e.target.closest(".pop") && !e.target.closest(".term")) document.querySelectorAll(".pop").forEach(p => p.remove());
  const t = e.target;
  const term = t.closest(".term"); if (term) { e.preventDefault(); showTerm(term, term.dataset.term); return; }
  const pal = t.closest("[data-pal]"); if (pal) { palPick(+pal.dataset.pal); return; }
  if (t.id === "palette") { t.hidden = true; return; }
  if (!S.doc) { if (t.closest('[data-act="restore"]')) $("#restorefile").click(); if (t.closest('[data-act="dorestore"]')) { confirmedRestore = true; closeModal(); try { await vault.importBackup(pendingRestore); toast("Backup restored. Unlock it with that backup's passphrase."); } catch { toast("That backup couldn't be restored."); } confirmedRestore = false; showLock("unlock"); } if (t.closest('[data-act="closemodal"]')) closeModal(); return; }
  const v = t.closest("[data-view]"); if (v) { closeModal(); go(v.dataset.view); return; }
  const op = t.closest("[data-open]"); if (op) { closeModal(); document.querySelectorAll(".pop").forEach(p => p.remove()); go("note", { noteId: op.dataset.open }); return; }
  const sc = t.closest("[data-sec]"); if (sc) { S.sec = sc.dataset.sec; S.groupBy = "section"; go("notebook"); return; }
  const pg = t.closest("[data-page]"); if (pg) { openPage(pg.dataset.page); return; }
  const df = t.closest("[data-define]"); if (df) { openTermForm({}, df.dataset.define); return; }
  const tm = t.closest("button[data-term]"); if (tm && !tm.classList.contains("term") && !tm.dataset.act) { const g = S.doc.glossary.find(x => x.term === tm.dataset.term); showTerm(tm, g?.term); return; }
  const sw = t.closest("[data-swatch]"); if (sw) { $("#sf-color").value = sw.dataset.swatch; document.querySelectorAll("[data-swatch]").forEach(b => b.setAttribute("aria-pressed", b === sw)); return; }
  const fu = t.closest("[data-fu]"); if (fu) { S.fu = fu.dataset.fu; render(); return; }
  const aq = t.closest("[data-askq]"); if (aq) { S.ask = { q: aq.dataset.askq, ran: true, aiText: "", aiBusy: false }; render(); return; }
  const pick = t.closest("[data-pick]"); if (pick) { S.cap.drafts[+pick.dataset.pick].sectionId = pick.dataset.sid; render(); return; }
  const zoom = t.closest("[data-zoom]"); if (zoom) { zoom.parentElement.classList.toggle("zoom"); return; }
  const a = t.closest("[data-act]"); if (!a) return;
  const id = a.dataset.id, act = a.dataset.act;
  switch (act) {
    case "lock": doLock(); break;
    case "palette": openPalette(); break;
    case "closemodal": closeModal(); break;
    case "examples": loadExamples(); break;
    case "clearfilters": S.q = ""; S.filters = { system: "", env: "", status: "" }; render(); break;
    case "newsection": openSectionForm(); break;
    case "editsection": openSectionForm(secById(id)); break;
    case "managesections": openManageSections(); break;
    case "secup": case "secdown": {
      const secs = sortedSections(); const i = secs.findIndex(s => s.id === id); const j = act === "secup" ? i - 1 : i + 1;
      if (j < 0 || j >= secs.length) break; [secs[i], secs[j]] = [secs[j], secs[i]]; secs.forEach((s, k) => (s.order = k)); commit({ render: false }); render(); openManageSections(); break;
    }
    case "delsection": confirmDeleteSection(id); break;
    case "dodelsection": {
      const to = $("#delsec-to")?.value; const target = to === "__unsorted" ? ensureSection("Unsorted") : to;
      S.doc.notes.forEach(n => { if (n.sectionId === id) n.sectionId = target; });
      S.doc.sections = S.doc.sections.filter(s => s.id !== id); if (S.sec === id) S.sec = "__all"; closeModal(); commit(); toast("Section deleted."); break;
    }
    case "summarysec": summarySection(); break;
    case "edit": go("note", { noteId: id, editing: true }); break;
    case "canceledit": S.editing = false; render(); break;
    case "pin": { const n = noteById(id); n.pinned = !n.pinned; commit(); break; }
    case "delnote": openModal(`<h2>Delete this note?</h2><p>“${esc(noteById(id).title)}” and its questions will be removed from this device. This can't be undone.</p><div class="row end"><button class="btn ghost" data-act="closemodal">Keep it</button><button class="btn danger" data-act="dodelnote" data-id="${id}">Delete</button></div>`); break;
    case "dodelnote": {
      const n = noteById(id); for (const p of n.pageIds || []) if (!S.doc.notes.some(x => x.id !== id && x.pageIds?.includes(p))) vault.remove("page:" + p);
      S.doc.notes = S.doc.notes.filter(x => x.id !== id); S.doc.questions = S.doc.questions.filter(q => q.noteId !== id);
      closeModal(); commit({ render: false }); go("notebook"); toast("Note deleted."); break;
    }
    case "viewpage": openPage(id); break;
    case "addq": openQuestionForm(id || null); break;
    case "answerq": openQuestionForm(null, "", id); break;
    case "delq": S.doc.questions = S.doc.questions.filter(q => q.id !== id); commit(); break;
    case "asklater": openQuestionForm(null, S.ask.q); break;
    case "addterm": openTermForm(); break;
    case "editterm": openTermForm(S.doc.glossary.find(g => g.id === id)); break;
    case "delterm": S.doc.glossary = S.doc.glossary.filter(g => g.id !== id); commit(); toast("Term deleted."); break;
    case "termnotes": document.querySelectorAll(".pop").forEach(p => p.remove()); S.q = a.dataset.term; S.sec = "__all"; S.groupBy = "section"; S.filters = { system: "", env: "", status: "" }; go("notebook"); break;
    case "filtersys": S.filters = { system: a.dataset.sys, env: "", status: "" }; S.sec = "__all"; go("notebook"); break;
    case "rot": { const s = S.cap.shots[+a.dataset.i]; s.rotate = (s.rotate + 90) % 360; render(); break; }
    case "rmshot": { const s = S.cap.shots.splice(+a.dataset.i, 1)[0]; URL.revokeObjectURL(s.url); render(); break; }
    case "runocr": runOcr(); break;
    case "skipocr": skipOcr(); break;
    case "usepasted": {
      const txt = ($("#pasted")?.value || "").trim(); if (!txt) { toast("Paste or type some text first."); break; }
      S.cap.pasted = ""; S.cap.shots.push({ url: null, text: txt, rotate: 0, confidence: null }); S.cap.stage = "edit"; render(); break;
    }
    case "capback": S.cap.stage = "input"; S.cap.shots = S.cap.shots.filter(s => s.file); render(); break;
    case "capback2": S.cap.stage = "edit"; render(); break;
    case "nextunsure": {
      const ta = $("#tx-" + a.dataset.i); const from = ta.selectionEnd || 0; let i = ta.value.indexOf("⟦", from); if (i < 0) i = ta.value.indexOf("⟦");
      if (i >= 0) { const j = ta.value.indexOf("⟧", i); ta.focus(); ta.setSelectionRange(i, j + 1); const lh = 21.6; ta.scrollTop = Math.max(0, ta.value.slice(0, i).split("\n").length * lh - 80); } break;
    }
    case "splits": { const i = +a.dataset.i; S.cap.shots[i].text = T.suggestSplits(S.cap.shots[i].text); render(); toast("Added --- where topics seem to change. Adjust as needed."); break; }
    case "tofile": toFile(); break;
    case "ctxall": { const c0 = readCtx("d0"); S.cap.drafts.forEach((d, i) => { d.ctx = i ? { ...c0 } : c0; }); render(); toast("Context copied to every note."); break; }
    case "savedrafts": saveDrafts(); break;
    case "export": {
      const data = await vault.exportBackup();
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `carryover-backup-${today()}.carryover`;
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      S.doc.settings.lastBackup = nowIso(); commit({ render: false }); toast("Encrypted backup downloaded."); break;
    }
    case "importbk": $("#importfile").click(); break;
    case "erase": openModal(`<h2>Erase everything?</h2><p>Type <b>ERASE</b> to delete every note, photo and setting on this device.</p><input id="erase-confirm" class="inp" autocomplete="off"><div class="row end"><button class="btn ghost" data-act="closemodal">Cancel</button><button class="btn danger" data-act="doerase">Erase</button></div>`); $("#erase-confirm").focus(); break;
    case "doerase": if ($("#erase-confirm").value.trim() === "ERASE") { await vault.eraseEverything(); closeModal(); clearInterval(lockTimer); showLock("create"); toast("Notebook erased."); } else toast("Type ERASE to confirm."); break;
    case "dorestore": { closeModal(); await flush().catch(() => {}); try { await vault.importBackup(pendingRestore); toast("Backup restored. Unlock it with that backup's passphrase."); } catch { toast("That backup couldn't be restored."); } showLock("unlock"); break; }
    case "aisumnote": case "aisumsec": case "aiask": runAi(act, id, a); break;
  }
});

async function runAi(act, id, btn) {
  const out = $("#aiout"); btn.disabled = true; out.innerHTML = `<p class="muted small">Working on this device…</p>`;
  try {
    let text;
    const prog = l => { out.innerHTML = `<p class="muted small">Downloading the on-device model… ${Math.round(l * 100)}%</p>`; };
    if (act === "aisumnote") { const n = noteById(id); text = await ai.aiSummarize(n.body.replace(/[⟦⟧]/g, ""), n.title, prog); }
    else if (act === "aisumsec") { const ns = S.doc.notes.filter(n => n.sectionId === id); text = await ai.aiSummarize(ns.map(n => `${n.title}\n${n.body}`).join("\n\n").replace(/[⟦⟧]/g, ""), secName(id), prog); }
    else { const lines = T.answerLines(S.ask.q, S.doc.notes, idf(), 12); text = await ai.aiAnswer(S.ask.q, lines.map(l => `[${l.note.title}] ${l.line}`).join("\n"), prog); S.ask.aiText = text; }
    out.innerHTML = md(text, { terms: false }) + `<p class="small muted">Written by Chrome's on-device model. Check it against your notes.</p>`;
  } catch (e) { console.error(e); out.innerHTML = `<p class="small err">On-device AI isn't ready in this browser. The summary above is still available.</p>`; }
  btn.disabled = false;
}

document.addEventListener("submit", async e => {
  e.preventDefault(); const f = e.target;
  if (f.id === "editform") {
    const n = noteById(S.noteId); let sectionId = $("#ed-sec").value;
    if (sectionId === "__new") { const nm = $("#ed-newsec").value.trim(); if (!nm) { toast("Name the new section."); return; } sectionId = ensureSection(nm); }
    const body = $("#ed-body").value; const oldTodos = n.todos || [];
    const todoTexts = [...new Set([...oldTodos.map(t => t.text).filter(t => body.includes(t)), ...T.extractTodos(body)])];
    Object.assign(n, { title: $("#ed-title").value.trim() || "Untitled note", sectionId, date: $("#ed-date").value || n.date, body, ctx: readCtx("ed"),
      tags: $("#ed-tags").value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
      todos: todoTexts.map(text => ({ text, done: !!oldTodos.find(t => t.text === text)?.done })), updatedAt: nowIso() });
    syncQuestions(n); S.editing = false; commit(); toast("Saved.");
  } else if (f.id === "secform") {
    const name = $("#sf-name").value.trim(); if (!name) return;
    const sid = $("#sf-id").value;
    if (S.doc.sections.some(s => s.id !== sid && s.name.toLowerCase() === name.toLowerCase())) { toast("You already have a section with that name."); return; }
    if (sid) Object.assign(secById(sid), { name, description: $("#sf-desc").value.trim(), color: +$("#sf-color").value });
    else { const id = uid(); S.doc.sections.push({ id, name, description: $("#sf-desc").value.trim(), color: +$("#sf-color").value, order: S.doc.sections.length }); }
    closeModal(); commit(); toast("Section saved.");
  } else if (f.id === "termform") {
    const term = $("#tm-term").value.trim(), meaning = $("#tm-meaning").value.trim(), system = $("#tm-system").value.trim(), gid = $("#tm-id").value;
    if (!term || !meaning) return;
    if (gid) Object.assign(S.doc.glossary.find(g => g.id === gid), { term, meaning, system });
    else if (S.doc.glossary.some(g => g.term.toLowerCase() === term.toLowerCase())) { toast("That term is already defined."); return; }
    else S.doc.glossary.push({ id: uid(), term, meaning, system });
    closeModal(); commit(); toast("Term saved.");
  } else if (f.id === "qform") {
    const qid = $("#qf-id").value, q = $("#qf-q").value.trim(), ans = $("#qf-a").value.trim(); if (!q) return;
    if (qid) Object.assign(S.doc.questions.find(x => x.id === qid), { q, answer: ans, status: ans ? "answered" : "open", answeredAt: ans ? nowIso() : null });
    else S.doc.questions.push({ id: uid(), q, answer: ans, noteId: $("#qf-note").value || null, status: ans ? "answered" : "open", createdAt: nowIso() });
    closeModal(); commit(); toast(ans ? "Answer saved." : "Added to Follow-ups.");
  } else if (f.id === "askform") {
    S.ask = { q: $("#askq").value, ran: true, aiText: "", aiBusy: false }; render();
  } else if (f.id === "pwform") {
    const err = $("#pwerr"); err.textContent = "";
    const o = $("#pw-old").value, n1 = $("#pw-new").value, n2 = $("#pw-new2").value;
    if (n1.length < 10) { err.textContent = "Use at least 10 characters."; return; }
    if (n1 !== n2) { err.textContent = "The new passphrases don't match."; return; }
    try { await flush(); await vault.changePassphrase(o, n1); f.reset(); toast("Passphrase changed. Download a fresh backup."); }
    catch (x) { err.textContent = x.message === "wrong_passphrase" ? "Current passphrase is wrong." : "Couldn't change the passphrase."; }
  }
});

document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "photos") { addShots([...t.files]); t.value = ""; return; }
  if (t.id === "groupby") { S.groupBy = t.value; if (t.value !== "section") S.sec = "__all"; render(); return; }
  if (t.dataset.filter) { S.filters[t.dataset.filter] = t.value; render(); return; }
  if (t.dataset.todo) { const n = noteById(t.dataset.todo); n.todos[+t.dataset.i].done = t.checked; commit(); return; }
  if (t.dataset.move) { noteById(t.dataset.move).sectionId = t.value; commit(); toast(`Moved to ${secName(t.value)}.`); return; }
  if (t.id === "ed-sec") { $("#ed-newsec-wrap").hidden = t.value !== "__new"; return; }
  if (t.dataset.dsec) { const d = S.cap.drafts[+t.dataset.dsec]; S.cap.drafts.forEach((x, i) => (x.ctx = readCtx("d" + i))); d.sectionId = t.value; render(); return; }
  if (t.dataset.dinc) { S.cap.drafts.forEach((x, i) => (x.ctx = readCtx("d" + i))); S.cap.drafts[+t.dataset.dinc].include = t.checked; render(); return; }
  if (t.id === "autolock") { S.doc.settings.autoLockMin = +t.value; commit({ render: false }); toast("Auto-lock updated."); return; }
  if (t.id === "importfile") { const f = t.files[0]; if (!f) return; try { pendingRestore = JSON.parse(await f.text()); if (pendingRestore?.format !== "carryover-backup") throw 0; openConfirmRestore(); } catch { toast("That file isn't a Carryover backup."); } t.value = ""; }
});

document.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "q") { S.q = t.value; render(); return; }
  if (t.id === "glossq") { S.glossQ = t.value; render(); return; }
  if (t.id === "palq") { palUpdate(t.value); return; }
  if (t.id === "pasted") { S.cap.pasted = t.value; return; }
  if (t.dataset.tx != null) { S.cap.shots[+t.dataset.tx].text = t.value; return; }
  if (t.dataset.d != null) { S.cap.drafts[+t.dataset.d][t.dataset.k] = t.value; return; }
});

document.addEventListener("keydown", e => {
  const pal = $("#palette");
  if (!pal.hidden) {
    if (e.key === "Escape") { pal.hidden = true; return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); palSel = (palSel + (e.key === "ArrowDown" ? 1 : -1) + palResults.length) % Math.max(1, palResults.length); document.querySelectorAll(".res").forEach((r, i) => { r.setAttribute("aria-selected", i === palSel); if (i === palSel) r.scrollIntoView({ block: "nearest" }); }); return; }
    if (e.key === "Enter" && e.target.id === "palq") { e.preventDefault(); palPick(palSel); return; }
    return;
  }
  if (e.key === "Escape") { if (!$("#modal").hidden) closeModal(); document.querySelectorAll(".pop").forEach(p => p.remove()); return; }
  if (!S.doc) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing && $("#modal").hidden)) { e.preventDefault(); openPalette(); }
});

/* drag & drop: notes onto tabs (move) or onto notes (reorder); photos onto the drop zone */
let dragId = null;
document.addEventListener("dragstart", e => { const n = e.target.closest?.("[data-drag]"); if (n) { dragId = n.dataset.drag; n.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); } });
document.addEventListener("dragend", () => { dragId = null; document.querySelectorAll(".dragging,.drop,.dropbefore").forEach(x => x.classList.remove("dragging", "drop", "dropbefore")); });
document.addEventListener("dragover", e => {
  const zone = e.target.closest?.("#drop"); if (zone && !dragId) { e.preventDefault(); zone.classList.add("over"); return; }
  if (!dragId) return;
  const tab = e.target.closest?.("[data-droptab]"); const card = e.target.closest?.("[data-drag]");
  document.querySelectorAll(".drop,.dropbefore").forEach(x => x.classList.remove("drop", "dropbefore"));
  if (tab) { e.preventDefault(); tab.classList.add("drop"); } else if (card && card.dataset.drag !== dragId) { e.preventDefault(); card.classList.add("dropbefore"); }
});
document.addEventListener("dragleave", e => { const zone = e.target.closest?.("#drop"); if (zone) zone.classList.remove("over"); });
document.addEventListener("drop", e => {
  const zone = e.target.closest?.("#drop");
  if (zone && !dragId) { e.preventDefault(); zone.classList.remove("over"); addShots([...e.dataTransfer.files]); return; }
  if (!dragId) return;
  const tab = e.target.closest?.("[data-droptab]"); const card = e.target.closest?.("[data-drag]"); const n = noteById(dragId);
  if (tab) { e.preventDefault(); n.sectionId = tab.dataset.droptab; commit(); toast(`Moved to ${secName(n.sectionId)}.`); }
  else if (card && card.dataset.drag !== dragId) {
    e.preventDefault(); const target = noteById(card.dataset.drag);
    const list = S.doc.notes.filter(x => x.sectionId === target.sectionId && x.id !== n.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    n.sectionId = target.sectionId; list.splice(list.indexOf(target), 0, n); list.forEach((x, i) => (x.order = i)); commit();
  }
  dragId = null;
});

addEventListener("pagehide", () => { if (S.doc && vault.isUnlocked()) vault.put("doc", S.doc); });

/* ============ boot ============ */
if (!window.isSecureContext || !crypto?.subtle || !window.indexedDB) {
  $("#root").innerHTML = `<div class="lock"><div class="lockcard"><div class="lockmark">Carry<em>over</em></div><p>This browser can't run Carryover securely. Open it over https in a current version of Safari, Chrome, Edge or Firefox, and not in a private window.</p></div></div>`;
} else showLock();
