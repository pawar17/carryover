// Encrypted local vault.
// Everything is stored in this browser's IndexedDB, encrypted with AES-GCM-256.
// The key is derived from your passphrase with PBKDF2-SHA-256 (600,000 iterations)
// and only ever lives in memory while the app is unlocked. Nothing is sent over the network.

const DB_NAME = "carryover";
const DB_VERSION = 1;
const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

let key = null; // CryptoKey, in memory only while unlocked

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function bytesToB64(bytes) { // chunked, safe for large buffers
  let s = ""; const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function deriveKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptWith(k, id, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, k, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: bytesToB64(ct) };
}
async function decryptWith(k, id, rec) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv), additionalData: enc.encode(id) }, k, unb64(rec.ct));
  return JSON.parse(dec.decode(pt));
}

export async function hasVault() {
  const m = await tx("meta", "readonly", s => reqP(s.get("vault")));
  return !!m;
}

export async function create(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(pass, salt, ITERATIONS);
  const check = await encryptWith(k, "check", "carryover-ok");
  await tx("meta", "readwrite", s => s.put({ v: 1, salt: b64(salt), iter: ITERATIONS, check, createdAt: new Date().toISOString() }, "vault"));
  key = k;
}

export async function unlock(pass) {
  const m = await tx("meta", "readonly", s => reqP(s.get("vault")));
  if (!m) throw new Error("no_vault");
  const k = await deriveKey(pass, unb64(m.salt), m.iter);
  try { await decryptWith(k, "check", m.check); } catch { throw new Error("wrong_passphrase"); }
  key = k;
}

export function lock() { key = null; }
export const isUnlocked = () => !!key;

export async function put(id, obj) {
  if (!key) throw new Error("locked");
  const rec = await encryptWith(key, id, obj);
  await tx("records", "readwrite", s => s.put(rec, id));
}
export async function get(id) {
  if (!key) throw new Error("locked");
  const rec = await tx("records", "readonly", s => reqP(s.get(id)));
  return rec ? decryptWith(key, id, rec) : null;
}
export async function remove(id) {
  await tx("records", "readwrite", s => s.delete(id));
}

// Re-encrypt every record under a new passphrase.
export async function changePassphrase(oldPass, newPass) {
  await unlock(oldPass);
  const oldKey = key;
  const all = await tx("records", "readonly", async s => {
    const kr = reqP(s.getAllKeys()), vr = reqP(s.getAll()); const keys = await kr; const vals = await vr;
    return keys.map((k, i) => [k, vals[i]]);
  });
  const plain = [];
  for (const [id, rec] of all) plain.push([id, await decryptWith(oldKey, id, rec)]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey(newPass, salt, ITERATIONS);
  const out = [];
  for (const [id, obj] of plain) out.push([id, await encryptWith(k, id, obj)]);
  const check = await encryptWith(k, "check", "carryover-ok");
  await tx("records", "readwrite", s => { for (const [id, rec] of out) s.put(rec, id); });
  await tx("meta", "readwrite", s => s.put({ v: 1, salt: b64(salt), iter: ITERATIONS, check, createdAt: new Date().toISOString() }, "vault"));
  key = k;
}

// Backup = the encrypted records exactly as stored. Useless without the passphrase.
export async function exportBackup() {
  const meta = await tx("meta", "readonly", s => reqP(s.get("vault")));
  const records = await tx("records", "readonly", async s => {
    const kr = reqP(s.getAllKeys()), vr = reqP(s.getAll()); const keys = await kr; const vals = await vr;
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  });
  return { format: "carryover-backup", v: 1, exportedAt: new Date().toISOString(), meta, records };
}
export async function importBackup(data) {
  if (data?.format !== "carryover-backup" || !data.meta || !data.records) throw new Error("bad_backup");
  await tx("records", "readwrite", s => { s.clear(); for (const [id, rec] of Object.entries(data.records)) s.put(rec, id); });
  await tx("meta", "readwrite", s => s.put(data.meta, "vault"));
  key = null;
}

export async function eraseEverything() {
  key = null;
  await tx("records", "readwrite", s => s.clear());
  await tx("meta", "readwrite", s => s.clear());
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
export async function usage() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
