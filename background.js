// Chat Memory v3 - background service worker.
// Holds ALL crypto. The content script (running inside chatgpt/claude/gemini pages) never sees the key.
// v3: every tab/site must enter the vault password itself (per-tab unlock), strong passwords are enforced here,
//     any file type can be stored (encrypted) after a password re-check, and backups carry those files too.
if (typeof importScripts === 'function') importScripts('pwcheck.js', 'backupfmt.js'); else { require('./pwcheck.js'); require('./backupfmt.js'); }
const VAULT = 'cm_vault', SETS = 'cm_settings', SIGNAL = 'cm_signal', SKEY = 'cm_key', FAILS = 'cm_fails', WIPED = 'cm_wiped';
const AUTH = 'cm_auth', REAUTH = 'cm_reauth', BLOB = 'cm_f_';
const MAX_TRIES = 2; // wrong vault passwords allowed in a row before the vault is erased
const ITER = 600000; // PBKDF2-SHA256 iterations
const MAX_FILE = 4 * 1024 * 1024 * 1024; // bytes per imported file (streamed in chunks, never held whole in memory)
const QUOTA = 25 * 1024 * 1024 * 1024;   // total vault size cap: 25 GB (manifest has unlimitedStorage)
const CHUNK = 2 * 1024 * 1024;           // files are encrypted and stored in 2 MB chunks
const MAX_SINGLE = 20 * 1024 * 1024;     // largest vault a single-file .json/.txt backup may hold (Chrome message limit is 64 MB); bigger => .cmbak stream
const REAUTH_MS = 3 * 60 * 1000; // after typing the password for an import, files can be added for 3 minutes
const enc = new TextEncoder(), dec = new TextDecoder();

function toB64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b; };
const cat = (arr) => { let n = 0; arr.forEach((a) => { n += a.length; }); const o = new Uint8Array(n); let p = 0; arr.forEach((a) => { o.set(a, p); p += a.length; }); return o; };
async function deriveRaw(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
}
const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // fresh IV on every write
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: toB64(iv), ct: toB64(ct) };
}
async function open(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch (e) {}

const getLocal = async (k) => (await chrome.storage.local.get(k))[k];
const getSession = async (k) => (await chrome.storage.session.get(k))[k];
const getSettings = async () => Object.assign({ autoLockMin: 15 }, await getLocal(SETS));
const signal = (s) => chrome.storage.local.set({ [SIGNAL]: s + ':' + Date.now() });

// ---- per-tab unlock: the key lives in session storage, but a tab may only USE it after typing the password in THAT tab ----
// ctx = { id: '<tabId>|<site origin>' }. A different tab, a different site, or a new tab => the password is asked again.
const ctxOf = (msg, sender) => ({ id: String((sender && sender.tab && sender.tab.id) ?? 'x') + '|' + String((msg && msg.origin) || '') });
async function authedSet() { return (await getSession(AUTH)) || {}; }
async function authorize(ctx) { const a = await authedSet(); a[ctx.id] = Date.now(); await chrome.storage.session.set({ [AUTH]: a }); }
async function isAuthed(ctx) { return !!(await getSession(SKEY)) && !!(await authedSet())[ctx.id]; }
async function curKey(ctx) {
  if (!(await isAuthed(ctx))) return null;
  const k = await getSession(SKEY);
  return k ? aesKey(fromB64(k)) : null;
}
try {
  if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(async (tabId) => {
    const a = await authedSet(); let ch = false;
    for (const k of Object.keys(a)) if (k.startsWith(tabId + '|')) { delete a[k]; ch = true; }
    if (ch) await chrome.storage.session.set({ [AUTH]: a });
  });
} catch (e) {}

// ---- auto-lock: chrome.alarms (inactivity timer) + chrome.idle (OS idle / screen lock) ----
async function arm() {
  const { autoLockMin } = await getSettings();
  await chrome.alarms.create('cm-lock', { delayInMinutes: Math.max(0.5, autoLockMin) }); // Chrome floors alarms at 30s
  try { chrome.idle.setDetectionInterval(Math.max(15, autoLockMin * 60)); } catch (e) {}
}
async function lock() {
  EXP = null; IMP = null; for (const k of Object.keys(PEND)) delete PEND[k];
  await chrome.storage.session.remove([SKEY, AUTH, REAUTH]);
  await chrome.alarms.clear('cm-lock');
  await signal('locked');
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'cm-lock') lock(); });
chrome.idle.onStateChanged.addListener((s) => { if (s === 'idle' || s === 'locked') lock(); });

// ---- two-strikes protection: the counter lives in chrome.storage.local so restarting the browser does not reset it ----
async function wipe() {
  const all = await chrome.storage.local.get(null);
  const blobs = Object.keys(all || {}).filter((k) => k.startsWith(BLOB));
  await chrome.storage.local.remove([VAULT, FAILS, ...blobs]);
  await chrome.storage.session.remove([SKEY, AUTH, REAUTH]);
  await chrome.alarms.clear('cm-lock');
  await chrome.storage.local.set({ [WIPED]: Date.now() });
  await signal('wiped');
}
async function verify(pw) { // checks the VAULT password; every wrong try counts toward the wipe
  const v = await getLocal(VAULT); if (!v) throw new Error('No vault yet');
  const raw = await deriveRaw(pw || '', fromB64(v.kdf.salt), v.kdf.iter);
  try { await open(await aesKey(raw), v.box); }
  catch (e) {
    const n = ((await getLocal(FAILS)) || 0) + 1;
    if (n >= MAX_TRIES) { await wipe(); throw Object.assign(new Error('Wrong password twice. The vault was erased. Restore it from your encrypted backup.'), { wiped: true }); }
    await chrome.storage.local.set({ [FAILS]: n });
    throw new Error('Wrong password. ' + (MAX_TRIES - n) + ' attempt left: one more wrong password ERASES the vault.');
  }
  await chrome.storage.local.remove(FAILS);
  return raw;
}
function needStrong(pw, what) {
  const r = CMPW.check(pw);
  if (!r.ok) throw new Error(what + ': ' + CMPW.explain(pw));
}
const LARGE_MSG = 'This is a Large backup (.cmbak). Use the Import button in the dock: it streams this kind of file automatically.';
const NOT_BACKUP = 'This file is not a Chat Memory backup.';
async function decryptBackup({ text, b64 }, pw) { // the BACKUP password is separate and never triggers the wipe. The file name / extension never matters: the content is sniffed.
  const bytes = b64 ? CMFMT.b64ToBytes(b64) : enc.encode(String(text || ''));
  const f = bytes && CMFMT.sniff(bytes);
  if (!f) throw new Error(NOT_BACKUP);
  if (f.kind !== 'json') throw new Error(LARGE_MSG);
  const b = f.env, iter = b.vault.kdf.iter; if (!(iter >= 100000 && iter <= 5000000)) throw new Error('Unsupported backup');
  try { return await open(await aesKey(await deriveRaw(pw || '', fromB64(b.vault.kdf.salt), iter)), b.vault.box); }
  catch (e) { throw new Error('Wrong backup password, or the file was modified'); }
}
const cleanFile = (f) => (f && f.name ? { name: String(f.name).slice(0, 200), mime: String(f.mime || 'application/octet-stream').slice(0, 120), size: Number(f.size) || 0, ...(f.chunks != null ? { chunks: Number(f.chunks) } : {}) } : null);
const cleanItem = (i) => { const o = { id: String(i.id), name: String(i.name), folder: i.folder || null, text: String(i.text || ''), summary: String(i.summary || ''), ts: i.ts || Date.now() }; const f = cleanFile(i.file); if (f) o.file = f; return o; };

// ---- vault operations ----
let chain = Promise.resolve(); // serialise read-modify-write so two tabs can't clobber each other
const serial = (fn) => (chain = chain.then(fn, fn));

async function readData(ctx) {
  const key = await curKey(ctx), v = await getLocal(VAULT);
  if (!key || !v) throw new Error('locked');
  return { key, v, data: await open(key, v.box) };
}
async function writeData(key, v, data) {
  v.box = await seal(key, data);
  await chrome.storage.local.set({ [VAULT]: v });
}
// ---- encrypted file store: every file is split into 2 MB chunks, each sealed with its own AES-GCM IV (key cm_f_<id>_<n>) ----
async function sealBytes(key, u8, aad) { const iv = crypto.getRandomValues(new Uint8Array(12)), p = { name: 'AES-GCM', iv }; if (aad) p.additionalData = aad; return { iv, ct: new Uint8Array(await crypto.subtle.encrypt(p, key, u8)) }; }
async function openBytes(key, iv, ct, aad) { const p = { name: 'AES-GCM', iv }; if (aad) p.additionalData = aad; return new Uint8Array(await crypto.subtle.decrypt(p, key, ct)); }
const chunkKey = (id, n) => BLOB + id + '_' + n;
async function putChunk(key, id, n, u8) { const b = await sealBytes(key, u8); await chrome.storage.local.set({ [chunkKey(id, n)]: { iv: toB64(b.iv), ct: toB64(b.ct) } }); }
const blobKeys = (it) => !it.file ? [] : it.file.chunks == null ? [BLOB + it.id] : Array.from({ length: it.file.chunks }, (_, n) => chunkKey(it.id, n));
async function getChunkBytes(key, it, n) {
  if (it.file.chunks == null) { const box = await getLocal(BLOB + it.id); if (!box) return null; return fromB64((await open(key, box)).b64); } // files saved by v3.0
  const box = await getLocal(chunkKey(it.id, n)); if (!box) return null;
  return openBytes(key, fromB64(box.iv), fromB64(box.ct));
}
async function storeBytes(key, id, u8) { let n = 0, o = 0; do { await putChunk(key, id, n++, u8.subarray(o, o + CHUNK)); o += CHUNK; } while (o < u8.length); return n; }
async function wholeFile(key, it) { const parts = []; for (let n = 0; n < (it.file.chunks == null ? 1 : it.file.chunks); n++) { const b = await getChunkBytes(key, it, n); if (b == null) return null; parts.push(b); } return cat(parts); }
const usageOf = (d) => d.items.reduce((a, i) => a + (i.file ? i.file.size : 0) + i.text.length + i.summary.length, 0);
const uid = () => crypto.randomUUID();

function mutate(d, m) {
  if (m.op === 'addFolder') { const f = { id: uid(), name: String(m.name || 'Folder').slice(0, 80) }; d.folders.push(f); return f.id; }
  if (m.op === 'delFolder') { d.folders = d.folders.filter((f) => f.id !== m.id); d.items.forEach((i) => { if (i.folder === m.id) i.folder = null; }); }
  if (m.op === 'addItem') { const it = { id: uid(), name: m.name || 'Untitled', folder: m.folder || null, text: m.text || '', summary: m.summary || '', ts: Date.now() }; d.items.push(it); return it.id; }
  if (m.op === 'delItem') d.items = d.items.filter((i) => i.id !== m.id);
  if (m.op === 'editItem') { const it = d.items.find((i) => i.id === m.id); const p = m.patch || {}; if (it) for (const k of ['name', 'folder', 'text', 'summary']) if (k in p) it[k] = p[k]; }
}
async function needReauth(ctx) { // set by H.reauth (password typed for an import) - valid for a few minutes, for this tab only
  const r = await getSession(REAUTH);
  if (!r || r.id !== ctx.id || r.until < Date.now()) throw new Error('Please enter your vault password to import files.');
}

const PEND = {}; let EXP = null, IMP = null; // in-flight uploads / large export / large import (service-worker memory; an interrupted one just has to be restarted)
const renew = async (ctx) => chrome.storage.session.set({ [REAUTH]: { id: ctx.id, until: Date.now() + REAUTH_MS } });
async function impCleanup() { const I = IMP; IMP = null; if (!I) return; const ks = []; for (const id of I.ids) { for (let n = 0; n < (I.chunks[id] || 0); n++) ks.push(chunkKey(id, n)); } if (ks.length) await chrome.storage.local.remove(ks); }

const H = {
  async status(m, ctx) { return { exists: !!(await getLocal(VAULT)), unlocked: await isAuthed(ctx), settings: await getSettings(), fails: (await getLocal(FAILS)) || 0, wiped: !!(await getLocal(WIPED)) }; },

  async setup({ pw }, ctx) {
    if (await getLocal(VAULT)) throw new Error('A vault already exists');
    needStrong(pw, 'Vault password');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const raw = await deriveRaw(pw, salt, ITER), key = await aesKey(raw);
    const v = { v: 1, kdf: { name: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt) } };
    await writeData(key, v, { folders: [], items: [] });
    await chrome.storage.local.remove([FAILS, WIPED]);
    await chrome.storage.session.set({ [SKEY]: toB64(raw) });
    await authorize(ctx);
    await arm(); await signal('unlocked'); return {};
  },

  unlock: ({ pw }, ctx) => serial(async () => {
    const raw = await verify(pw);
    await chrome.storage.session.set({ [SKEY]: toB64(raw) });
    await authorize(ctx); // ONLY this tab/site is opened; other tabs still have to type the password
    await arm(); await signal('unlocked'); return {};
  }),

  async lock() { await lock(); return {}; },
  async touch(m, ctx) { if (await isAuthed(ctx)) await arm(); return {}; },
  async setSettings({ autoLockMin }, ctx) {
    await chrome.storage.local.set({ [SETS]: { autoLockMin: Number(autoLockMin) || 15 } });
    if (await isAuthed(ctx)) await arm(); return {};
  },

  load: (m, ctx) => serial(async () => { const { data } = await readData(ctx); await arm(); return { data, usage: { used: usageOf(data), quota: QUOTA } }; }),
  mutate: ({ m }, ctx) => serial(async () => {
    const { key, v, data } = await readData(ctx); const old = m.op === 'delItem' ? data.items.find((i) => i.id === m.id) : null;
    const r = mutate(data, m); await writeData(key, v, data);
    if (old && old.file) await chrome.storage.local.remove(blobKeys(old));
    await arm(); return { r };
  }),

  // Password re-check before any file import from the computer. Wrong password counts toward the two-strikes erase.
  reauth: ({ pw }, ctx) => serial(async () => {
    if (!(await isAuthed(ctx))) throw new Error('locked');
    await verify(pw);
    await chrome.storage.session.set({ [REAUTH]: { id: ctx.id, until: Date.now() + REAUTH_MS } });
    return {};
  }),

  // ---- any file type, any size: stored encrypted in 2 MB chunks. The dock sends one chunk per message (fileBegin -> fileChunk x N -> fileEnd).
  // The password re-check stays valid while chunks keep arriving (each chunk renews it), so a multi-GB import cannot time out half way.
  fileBegin: ({ name, folder, text, file }, ctx) => serial(async () => {
    await needReauth(ctx); const { data } = await readData(ctx);
    const size = Number(file && file.size) || 0; if (size > MAX_FILE) throw new Error('File is larger than ' + (MAX_FILE / 1073741824) + ' GB');
    if (usageOf(data) + size > QUOTA) throw new Error('Vault storage is full (' + (QUOTA / 1073741824) + ' GB limit). Delete something or export a backup first.');
    const id = uid(); PEND[id] = { ctx: ctx.id, name, folder, text, n: 0, bytes: 0, file: { name: String(file.name || name || 'file').slice(0, 200), mime: String(file.mime || 'application/octet-stream').slice(0, 120) } };
    await renew(ctx); return { id };
  }),
  fileChunk: ({ id, b64 }, ctx) => serial(async () => {
    await needReauth(ctx); const p = PEND[id]; if (!p || p.ctx !== ctx.id) throw new Error('Upload was interrupted. Please import the file again.');
    const key = await curKey(ctx), u8 = fromB64(b64); if (p.bytes + u8.length > MAX_FILE) throw new Error('File is too large');
    await putChunk(key, id, p.n++, u8); p.bytes += u8.length; await renew(ctx); await arm(); return {};
  }),
  fileEnd: ({ id }, ctx) => serial(async () => {
    const p = PEND[id]; if (!p || p.ctx !== ctx.id) throw new Error('Upload was interrupted. Please import the file again.');
    const { key, v, data } = await readData(ctx), fo = p.folder && data.folders.some((f) => f.id === p.folder) ? p.folder : null;
    data.items.push({ id, name: String(p.name || p.file.name || 'Imported file').slice(0, 200), folder: fo, text: String(p.text || '').slice(0, 2000000), summary: '', ts: Date.now(), file: { ...p.file, size: p.bytes, chunks: p.n } });
    await writeData(key, v, data); delete PEND[id]; await arm(); return { id };
  }),
  fileAbort: ({ id }, ctx) => serial(async () => { const p = PEND[id]; if (p && p.ctx === ctx.id) { await chrome.storage.local.remove(Array.from({ length: p.n }, (_, n) => chunkKey(id, n))); delete PEND[id]; } return {}; }),
  // small files in one message (kept for simple callers / tests)
  addFile: ({ name, folder, text, file }, ctx) => serial(async () => {
    await needReauth(ctx);
    const { key, v, data } = await readData(ctx);
    if (!file || typeof file.b64 !== 'string') throw new Error('No file data');
    if (file.b64.length > Math.ceil(MAX_SINGLE * 4 / 3) + 8) throw new Error('File is too big for one message. Import it from the Library tab (it is streamed in chunks).');
    if (usageOf(data) + file.b64.length * 0.75 > QUOTA) throw new Error('Vault storage is full');
    const fo = folder && data.folders.some((f) => f.id === folder) ? folder : null, bytes = fromB64(file.b64), id = uid();
    const n = await storeBytes(key, id, bytes);
    data.items.push({ id, name: String(name || file.name || 'Imported file').slice(0, 200), folder: fo, text: String(text || '').slice(0, 2000000), summary: '', ts: Date.now(),
      file: { name: String(file.name || name || 'file').slice(0, 200), mime: String(file.mime || 'application/octet-stream').slice(0, 120), size: bytes.length, chunks: n } });
    await writeData(key, v, data); await arm(); return { id };
  }),

  // download: one chunk at a time so a multi-GB file never has to sit in memory
  getChunk: ({ id, n }, ctx) => serial(async () => {
    const { key, data } = await readData(ctx); const it = data.items.find((i) => i.id === id); if (!it || !it.file) throw new Error('No attached file');
    const b = await getChunkBytes(key, it, n); if (b == null) throw new Error('The stored file is missing');
    return { b64: toB64(b), chunks: it.file.chunks == null ? 1 : it.file.chunks, name: it.file.name, mime: it.file.mime, size: it.file.size };
  }),
  getFile: ({ id }, ctx) => serial(async () => {
    const { key, data } = await readData(ctx);
    const it = data.items.find((i) => i.id === id); if (!it || !it.file) throw new Error('No attached file');
    if (it.file.size > MAX_SINGLE) throw new Error('File is too big for one message; use the Download button (chunked).');
    const b = await wholeFile(key, it); if (b == null) throw new Error('The stored file is missing');
    return { b64: toB64(b), name: it.file.name, mime: it.file.mime };
  }),

  // ---- Export, single file (.json or .txt): vault password re-check + a separate strong BACKUP password. For vaults up to ~20 MB.
  exportBackup: ({ pw, bpw, fmt }, ctx) => serial(async () => {
    const { key, data } = await readData(ctx); await verify(pw);
    needStrong(bpw, 'Backup password');
    const used = usageOf(data);
    if (used > MAX_SINGLE) throw new Error('This vault is ' + Math.round(used / 1048576) + ' MB: too big for one .json/.txt file. Choose "Large backup (.cmbak)", which streams any size up to 25 GB.');
    const files = {};
    for (const i of data.items) if (i.file) { const b = await wholeFile(key, i); if (b != null) files[i.id] = toB64(b); }
    const salt = crypto.getRandomValues(new Uint8Array(16)), bkey = await aesKey(await deriveRaw(bpw, salt, ITER));
    const items = data.items.map((i) => { const c = { ...i }; if (c.file) { c.file = { ...c.file }; delete c.file.chunks; } return c; });
    const vault = { v: 1, kdf: { name: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt) }, box: await seal(bkey, { folders: data.folders, items, files }) };
    const json = JSON.stringify({ app: 'chat-memory', format: 3, exportedAt: new Date().toISOString(), vault });
    if (fmt === 'txt') { const b = toB64(enc.encode(json)); return { file: '-----BEGIN CHAT MEMORY BACKUP-----\n' + b.replace(/(.{76})/g, '$1\n') + '\n-----END CHAT MEMORY BACKUP-----\n' }; }
    return { file: json };
  }),

  // ---- Export, Large backup (.cmbak): a stream of independently encrypted frames, built a few MB at a time. Frame index is bound as AAD,
  // so frames cannot be reordered, dropped or truncated unnoticed. Needs vault password + backup password like every other export.
  exportBegin: ({ pw, bpw }, ctx) => serial(async () => {
    const { key, data } = await readData(ctx); await verify(pw); needStrong(bpw, 'Backup password');
    const salt = crypto.getRandomValues(new Uint8Array(16)), bkey = await aesKey(await deriveRaw(bpw, salt, ITER));
    const tasks = [{ t: 1 }]; data.items.forEach((i) => tasks.push({ t: 2, i }));
    for (const i of data.items) if (i.file) for (let n = 0; n < (i.file.chunks == null ? 1 : i.file.chunks); n++) tasks.push({ t: 3, i, n });
    tasks.push({ t: 255 });
    EXP = { ctx: ctx.id, key, bkey, data, tasks, chunks: tasks.filter((x) => x.t === 3).length, until: Date.now() + 6 * 3600 * 1000 };
    const hdr = enc.encode(JSON.stringify({ app: 'chat-memory', format: 4, exportedAt: new Date().toISOString(), kdf: { name: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt) }, chunk: CHUNK }));
    return { head: toB64(cat([enc.encode(CMFMT.MAGIC), u32(hdr.length), hdr])), total: tasks.length };
  }),
  exportNext: ({ from }, ctx) => serial(async () => {
    const E = EXP; if (!E || E.ctx !== ctx.id || E.until < Date.now()) throw new Error('Export was interrupted. Please start the export again.');
    const key = await curKey(ctx); if (!key) throw new Error('locked');
    const out = []; let size = 0, i = from;
    while (i < E.tasks.length && size < 3 * 1048576) {
      const t = E.tasks[i]; let pt;
      if (t.t === 1) pt = cat([Uint8Array.of(1), enc.encode(JSON.stringify({ folders: E.data.folders }))]);
      else if (t.t === 2) { const c = { ...t.i }; if (c.file) { c.file = { ...c.file }; delete c.file.chunks; } pt = cat([Uint8Array.of(2), enc.encode(JSON.stringify(c))]); }
      else if (t.t === 3) { const b = await getChunkBytes(key, t.i, t.n); if (b == null) throw new Error('A stored file is missing: "' + t.i.name + '"'); pt = cat([Uint8Array.of(3), enc.encode(t.i.id), u32(t.n), b]); }
      else pt = cat([Uint8Array.of(255), enc.encode(JSON.stringify({ items: E.data.items.length, folders: E.data.folders.length, chunks: E.chunks, frames: E.tasks.length }))]);
      const f = await sealBytes(E.bkey, pt, u32(i)), body = cat([f.iv, f.ct]);
      out.push(u32(body.length), body); size += body.length; i++;
    }
    const done = i >= E.tasks.length; if (done) EXP = null; await arm();
    return { b64: toB64(cat(out)), next: i, done };
  }),
  exportAbort: () => { EXP = null; return {}; },

  // ---- Import of a backup in ANY wrapper (.json / .txt / .cmbak, any file name). Merges by id, never overwrites, optional target folder.
  // Single-file backups: vault password re-check + the backup's own password.
  importBackup: ({ text, b64, pw, vpw, into }, ctx) => serial(async () => {
    const { key, v, data } = await readData(ctx); await verify(vpw);
    const inc = await decryptBackup({ text, b64 }, pw);
    const fIds = new Set(data.folders.map((f) => f.id)), iIds = new Set(data.items.map((i) => i.id));
    let nf = 0, ni = 0;
    const target = into && fIds.has(into) ? into : null;
    if (!target) for (const f of inc.folders || []) if (!fIds.has(f.id)) { data.folders.push({ id: String(f.id), name: String(f.name) }); fIds.add(f.id); nf++; }
    for (const i of inc.items || []) if (!iIds.has(i.id)) {
      const c = cleanItem(i); c.folder = target || (fIds.has(c.folder) ? c.folder : null); delete (c.file || {}).chunks;
      if (c.file) { const b = inc.files && inc.files[c.id]; if (typeof b === 'string') c.file.chunks = await storeBytes(key, c.id, fromB64(b)); else delete c.file; }
      data.items.push(c); ni++;
    }
    if (usageOf(data) > QUOTA) throw new Error('Vault storage would exceed 25 GB');
    await writeData(key, v, data); return { folders: nf, items: ni };
  }),

  // Streaming import of a .cmbak: impBegin (passwords) -> impFeed x N (whole frames, ~3 MB each) -> impEnd. Same call chain restores a backup into a NEW vault (restore:true).
  impBegin: ({ head, pw, vpw, into, restore, newPw }, ctx) => serial(async () => {
    let key = null, kv = null, data = null, raw = null, nv = null;
    if (restore) { if (await getLocal(VAULT)) throw new Error('A vault already exists. Use Import instead.'); needStrong(newPw, 'New vault password'); }
    else { const r = await readData(ctx); key = r.key; kv = r.v; data = r.data; await verify(vpw); }
    let h; try { const f = CMFMT.sniff(fromB64(head)); h = f && f.kind === 'bin' && f.header; } catch (e) {}
    if (!h) throw new Error(NOT_BACKUP);
    const iter = h.kdf.iter; if (!(iter >= 100000 && iter <= 5000000)) throw new Error('Unsupported backup');
    const bkey = await aesKey(await deriveRaw(pw || '', fromB64(h.kdf.salt), iter));
    if (restore) { const salt = crypto.getRandomValues(new Uint8Array(16)); raw = await deriveRaw(newPw, salt, ITER); key = await aesKey(raw); nv = { v: 1, kdf: { name: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt) } }; data = { folders: [], items: [] }; }
    IMP = { ctx: ctx.id, restore: !!restore, key, kv: kv || nv, raw, bkey, idx: 0, folders: [], items: [], ids: new Set(), have: new Set(data.items.map((i) => i.id)), chunks: {}, bytes: 0, base: usageOf(data), into: into || null, end: null, until: Date.now() + 6 * 3600 * 1000 };
    return {};
  }),
  impFeed: ({ b64 }, ctx) => serial(async () => {
    const I = IMP; if (!I || I.ctx !== ctx.id || I.until < Date.now()) throw new Error('Import was interrupted. Please start it again.');
    const u = fromB64(b64), dv = new DataView(u.buffer, u.byteOffset, u.byteLength); let p = 0;
    try {
      while (p + 4 <= u.length) {
        const len = dv.getUint32(p, false); p += 4; if (p + len > u.length || len < 29) throw new Error('This backup file is damaged');
        let pt; try { pt = await openBytes(I.bkey, u.subarray(p, p + 12), u.subarray(p + 12, p + len), u32(I.idx)); }
        catch (e) { throw new Error(I.idx === 0 ? 'Wrong backup password, or the file was modified' : 'Backup file is damaged or was modified (frame ' + I.idx + ')'); }
        p += len; I.idx++; const t = pt[0], body = pt.subarray(1);
        if (t === 1) I.folders = (JSON.parse(dec.decode(body)).folders || []);
        else if (t === 2) { const it = JSON.parse(dec.decode(body)); if (!I.have.has(it.id)) { I.items.push(cleanItem(it)); I.ids.add(String(it.id)); I.have.add(it.id); } }
        else if (t === 3) { const id = dec.decode(body.subarray(0, 36)), n = new DataView(body.buffer, body.byteOffset + 36, 4).getUint32(0, false);
          if (I.ids.has(id)) { const c = body.subarray(40); I.bytes += c.length; if (I.base + I.bytes > QUOTA) throw new Error('Vault storage would exceed 25 GB'); await putChunk(I.key, id, n, c); I.chunks[id] = Math.max(I.chunks[id] || 0, n + 1); } }
        else if (t === 255) I.end = JSON.parse(dec.decode(body));
      }
    } catch (e) { await impCleanup(); throw e; }
    return { frames: I.idx };
  }),
  impEnd: (m, ctx) => serial(async () => {
    const I = IMP; if (!I || I.ctx !== ctx.id) throw new Error('Import was interrupted. Please start it again.');
    if (!I.end || I.end.frames !== I.idx) { await impCleanup(); throw new Error('This backup file is incomplete (it was cut short). Nothing was imported.'); }
    let data, key = I.key, v = I.kv;
    if (I.restore) data = { folders: [], items: [] }; else data = (await readData(ctx)).data;
    const fIds = new Set(data.folders.map((f) => f.id)); let nf = 0;
    const target = I.into && fIds.has(I.into) ? I.into : null;
    if (!target) for (const f of I.folders) if (!fIds.has(String(f.id))) { data.folders.push({ id: String(f.id), name: String(f.name) }); fIds.add(String(f.id)); nf++; }
    for (const c of I.items) { c.folder = target || (fIds.has(c.folder) ? c.folder : null); if (c.file) { if (I.chunks[c.id]) c.file.chunks = I.chunks[c.id]; else delete c.file; } data.items.push(c); }
    await writeData(key, v, data);
    if (I.restore) { await chrome.storage.local.remove([FAILS, WIPED]); await chrome.storage.session.set({ [SKEY]: toB64(I.raw) }); await authorize(ctx); await arm(); await signal('unlocked'); }
    IMP = null; return { items: I.items.length, folders: nf };
  }),
  impAbort: (m, ctx) => serial(async () => { await impCleanup(); return {}; }),

  // Restore: only when NO vault exists (fresh install, new computer, or after an erase). Needs the backup password.
  restoreBackup: ({ text, b64, pw, newPw }, ctx) => serial(async () => {
    if (await getLocal(VAULT)) throw new Error('A vault already exists. Use Import instead.');
    needStrong(newPw, 'New vault password');
    const inc = await decryptBackup({ text, b64 }, pw);
    const salt = crypto.getRandomValues(new Uint8Array(16)), raw = await deriveRaw(newPw, salt, ITER), key = await aesKey(raw);
    const v = { v: 1, kdf: { name: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt) } };
    const data = { folders: (inc.folders || []).map((f) => ({ id: String(f.id), name: String(f.name) })), items: (inc.items || []).map(cleanItem) };
    for (const c of data.items) if (c.file) { delete c.file.chunks; const b = inc.files && inc.files[c.id]; if (typeof b === 'string') c.file.chunks = await storeBytes(key, c.id, fromB64(b)); else delete c.file; }
    await writeData(key, v, data); await chrome.storage.local.remove([FAILS, WIPED]);
    await chrome.storage.session.set({ [SKEY]: toB64(raw) });
    await authorize(ctx);
    await arm(); await signal('unlocked'); return { items: data.items.length, folders: data.folders.length };
  }),

  // Relay for the dock iframe -> the chat page. Goes through chrome.runtime, which web pages cannot listen to or forge.
  async page({ op, args }, ctx, sender) {
    const tab = sender && sender.tab; if (!tab) throw new Error('Open the dock from a chat page');
    let r; try { r = await chrome.tabs.sendMessage(tab.id, { cmpage: 1, op, args }, { frameId: 0 }); }
    catch (e) { throw new Error('Could not reach the page. Reload this chat tab and try again.'); }
    return r || {};
  },
};

// Only OUR dock page (dock.html) may talk to the vault. Web pages cannot send chrome.runtime messages at all.
const DOCK = chrome.runtime.getURL ? chrome.runtime.getURL('dock.html') : '';
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const fn = H[msg && msg.type];
  if (!fn) return false;
  if (DOCK && !(sender && sender.url && sender.url.startsWith(DOCK))) { send({ ok: false, error: 'Not allowed' }); return false; }
  const ctx = ctxOf(msg, sender);
  Promise.resolve().then(() => fn(msg, ctx, sender)).then((r) => send({ ok: true, ...r }), (e) => send({ ok: false, error: e.message, wiped: !!e.wiped }));
  return true;
});
