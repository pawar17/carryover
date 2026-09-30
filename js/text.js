// On-device text tools. No network, no AI service: plain statistics over your own notes.

const STOP = new Set(("a an and are as at be been but by can could did do does for from had has have how i if in into is it its just me my of on or our so than that the their them then there these they this to too up us was we were what when where which who why will with you your yes no not also get got use used using via per etc e g ie eg need needs one two new make made should would may might must very much more most some any all each every only same other such own over under about after before again further once here out off down while during both few nor dont doesnt isnt cant wont ok").split(" "));

export function tokens(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9_\-\.]*[a-z0-9]|[a-z0-9]/g) || [])
    .filter(t => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

// Build document frequencies over the corpus once; reuse for scoring.
export function buildIdf(docs) {
  const df = new Map(); const N = Math.max(1, docs.length);
  for (const d of docs) for (const t of new Set(tokens(d))) df.set(t, (df.get(t) || 0) + 1);
  const idf = t => Math.log(1 + N / (1 + (df.get(t) || 0)));
  return { idf, N };
}
export function vector(text, idf) {
  const tf = new Map(); for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  const v = new Map(); let norm = 0;
  for (const [t, c] of tf) { const w = (1 + Math.log(c)) * idf(t); v.set(t, w); norm += w * w; }
  norm = Math.sqrt(norm) || 1; for (const [t, w] of v) v.set(t, w / norm);
  return v;
}
export function cosine(a, b) {
  let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of x) { const w2 = y.get(t); if (w2) s += w * w2; }
  return s;
}

// Break a note body into "units": bullet lines or sentences.
export function units(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim(); if (!line || line === "---") continue;
    const clean = line.replace(/^([-*•]|\d+[.)]|#+)\s*/, "");
    if (/^([-*•]|\d+[.)])/.test(line) || clean.length < 160) { out.push(clean); continue; }
    for (const s of clean.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

const SIGNAL = /\b(must|always|never|required|require|deadline|before|after|only|don't|do not|owner|approval|sign.?off|prod|production|critical|important|note|remember|rule|by \w+day|cutoff|sla|escalat)\w*/i;

// Extractive summary: the most informative lines, kept in original order.
export function summarize(text, idf, { max = 5, glossaryTerms = [] } = {}) {
  const us = units(text);
  if (us.length <= max) return { points: us, keyTerms: keyTerms(text, idf) };
  const gset = glossaryTerms.map(t => t.toLowerCase());
  const scored = us.map((u, i) => {
    const toks = tokens(u); if (!toks.length) return { u, i, s: 0 };
    let s = toks.reduce((a, t) => a + idf(t), 0) / Math.sqrt(toks.length);
    if (SIGNAL.test(u)) s *= 1.35;
    if (/\d/.test(u)) s *= 1.1;
    if (/\*\*.+\*\*/.test(u)) s *= 1.25;
    if (gset.some(g => u.toLowerCase().includes(g))) s *= 1.15;
    if (i === 0) s *= 1.1;
    return { u, i, s };
  });
  const top = [...scored].sort((a, b) => b.s - a.s).slice(0, max).sort((a, b) => a.i - b.i);
  return { points: top.map(x => x.u), keyTerms: keyTerms(text, idf) };
}
export function keyTerms(text, idf, n = 6) {
  const tf = new Map(); for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return [...tf].map(([t, c]) => [t, c * idf(t)]).sort((a, b) => b[1] - a[1]).slice(0, n).map(x => x[0]);
}

// Suggest sections for new text by similarity to what's already filed there.
export function suggestSections(text, notes, sections, idf) {
  const v = vector(text, idf); const scores = [];
  for (const sec of sections) {
    const docs = notes.filter(n => n.sectionId === sec.id);
    const blob = sec.name + " " + (sec.description || "") + " " + docs.map(n => n.title + " " + n.body + " " + (n.tags || []).join(" ")).join(" ");
    let s = cosine(v, vector(blob, idf));
    if (tokens(sec.name).some(t => tokens(text).includes(t))) s += 0.15;
    scores.push({ id: sec.id, name: sec.name, score: s });
  }
  return scores.sort((a, b) => b.score - a.score).filter(x => x.score > 0.05).slice(0, 3);
}

export function related(note, notes, idf, n = 4) {
  const v = vector(note.title + " " + note.body, idf);
  return notes.filter(x => x.id !== note.id)
    .map(x => ({ note: x, s: cosine(v, vector(x.title + " " + x.body, idf)) + (x.ctx?.system && x.ctx.system === note.ctx?.system ? 0.1 : 0) }))
    .filter(x => x.s > 0.08).sort((a, b) => b.s - a.s).slice(0, n);
}

// Find the best-matching lines across notes for a question (extractive answer).
export function answerLines(question, notes, idf, n = 6) {
  const q = vector(question, idf); const out = [];
  for (const note of notes) for (const u of units(note.body)) {
    const s = cosine(q, vector(u + " " + note.title, idf)); if (s > 0.12) out.push({ note, line: u, s });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, n);
}

// Acronyms and jargon that appear in notes but aren't in the glossary yet.
export function undefinedTerms(notes, glossary) {
  const known = new Set(glossary.map(g => g.term.toLowerCase()));
  const count = new Map();
  for (const n of notes) for (const m of (n.title + "\n" + n.body).matchAll(/\b[A-Z][A-Z0-9&]{1,7}s?\b/g)) {
    const t = m[0].replace(/s$/, "");
    if (t.length < 2 || known.has(t.toLowerCase()) || /^(TODO|OK|NB|FYI|AM|PM|ET|EOD|ASAP|II|III|IV)$/.test(t)) continue;
    count.set(t, (count.get(t) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([term, c]) => ({ term, count: c }));
}

// Lines that are questions (to ask a colleague later) and lines that are to-dos.
export function extractQuestions(body) {
  return units(body).filter(u => /\?\s*$/.test(u) || /^q:\s*/i.test(u)).map(u => u.replace(/^q:\s*/i, ""));
}
export function extractTodos(body) {
  const out = [];
  for (const raw of String(body || "").split("\n")) {
    const l = raw.trim();
    const m = l.match(/^(?:[-*•]\s*)?(?:\[ \]|todo[:\s-]+|ai[:\s-]+|action[:\s-]+|follow.?up[:\s-]+)(.+)/i);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// Suggest where a day's page changes topic: headings, lines ending in ":", ALL-CAPS lines.
export function suggestSplits(text) {
  const lines = String(text || "").split("\n"); const out = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    const heading = t && i > 0 && t.length <= 48 && !/^[-*•\d]/.test(t) && !/\?\s*$/.test(t) && !/^(todo|ai|action|follow.?up|q)\b/i.test(t) &&
      (/:\s*$/.test(t) || /^#+\s/.test(t) || (t === t.toUpperCase() && /[A-Z]/.test(t)) || (/^[A-Z]/.test(t) && !/[.,;]$/.test(t) && lines[i - 1]?.trim() === ""));
    if (heading && out[out.length - 1] !== "---") out.push("---");
    out.push(l);
  });
  return out.join("\n").replace(/^(\s*---\s*\n)+/, "");
}
export function splitNotes(text) {
  const chunks = String(text || "").split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean);
  // a lone first line (usually the date or "KT with …") belongs with what follows
  if (chunks.length > 1 && !chunks[0].includes("\n")) chunks[1] = chunks[1].replace(/^([^\n]*)/, "$1\n" + chunks.shift());
  return chunks.map(chunk => {
    const lines = chunk.split("\n"); let first = lines[0].replace(/^#+\s*|:\s*$/g, "").replace(/^[-*•]\s*/, "").trim();
    const isHeading = first.length <= 60 && lines.length > 1;
    return { title: isHeading ? first : first.split(/\s+/).slice(0, 7).join(" "), body: isHeading ? lines.slice(1).join("\n").trim() : chunk };
  });
}
