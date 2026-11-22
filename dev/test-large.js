// Tests for v3.1: any-format import, chunked files, streaming .cmbak backup. Run: node dev/test-large.js
require('./shim.js'); require('../background.js'); const F = require('../backupfmt.js'); const crypto = require('crypto');
const call = (type, p = {}) => chrome.runtime.sendMessage({ type, origin: 'https://a.test', ...p });
const eq = (a, b, m) => { if (a !== b) { console.error('FAIL', m, '| got:', a, '| want:', b); process.exit(1); } console.log('ok  ', m); };
const PW = 'Correct-Horse#9Battery', BPW = 'Backup!Pass#5577xy', NEW = 'Brand-New#Gate42xyz';
const b64 = (u) => Buffer.from(u).toString('base64');
async function streamOut(pw, bpw) { // what the dock does for "Large backup"
  const b = await call('exportBegin', { pw, bpw }); if (!b.ok) return b;
  const parts = [Buffer.from(b.head, 'base64')]; let from = 0;
  for (;;) { const r = await call('exportNext', { from }); if (!r.ok) return r; parts.push(Buffer.from(r.b64, 'base64')); from = r.next; if (r.done) break; }
  return { ok: true, file: Buffer.concat(parts) };
}
async function streamIn(file, args) { // what the dock does for importing a .cmbak (frames cut at arbitrary feed boundaries, whole frames only)
  const f = F.sniff(new Uint8Array(file.subarray(0, 4096))); if (!f || f.kind !== 'bin') return { ok: false, error: 'not bin' };
  const r0 = await call('impBegin', { head: b64(file.subarray(0, f.dataStart)), ...args }); if (!r0.ok) return r0;
  let p = f.dataStart, batch = [];
  const flush = async () => { if (!batch.length) return { ok: true }; const r = await call('impFeed', { b64: b64(Buffer.concat(batch)) }); batch = []; return r; };
  while (p < file.length) { const len = file.readUInt32BE(p); batch.push(file.subarray(p, p + 4 + len)); p += 4 + len; if (batch.length >= 3) { const r = await flush(); if (!r.ok) return r; } }
  const r = await flush(); if (!r.ok) return r; return call('impEnd');
}
(async () => {
  await call('setup', { pw: PW });
  const fo = (await call('mutate', { m: { op: 'addFolder', name: 'Claude' } })).r;
  await call('mutate', { m: { op: 'addItem', name: 'Chat A', folder: fo, text: 'Secret roadmap alpha', summary: 'rm' } });

  // ---- multi-chunk upload through fileBegin/fileChunk/fileEnd (5 MB => 3 chunks of 2 MB) + chunked download ----
  const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
  eq((await call('fileBegin', { name: 'big', file: { name: 'big.bin', size: big.length } })).ok, false, 'fileBegin refused without password re-check');
  eq((await call('reauth', { pw: PW })).ok, true, 'password re-check');
  const fb = await call('fileBegin', { name: 'big', folder: fo, text: 'extracted', file: { name: 'big.bin', mime: 'application/octet-stream', size: big.length } });
  eq(fb.ok, true, 'fileBegin ok');
  for (let o = 0; o < big.length; o += 2 * 1024 * 1024) eq((await call('fileChunk', { id: fb.id, b64: b64(big.subarray(o, o + 2 * 1024 * 1024)) })).ok, true, 'chunk at ' + o);
  eq((await call('fileEnd', { id: fb.id })).ok, true, 'fileEnd ok');
  let d = (await call('load')).data, big1 = d.items.find((i) => i.id === fb.id);
  eq(big1.file.chunks + ':' + big1.file.size, '3:' + big.length, 'stored as 3 chunks with exact size');
  const got = []; for (let n = 0; n < 3; n++) got.push(Buffer.from((await call('getChunk', { id: fb.id, n })).b64, 'base64'));
  eq(Buffer.concat(got).equals(big), true, 'chunked download returns identical bytes');
  eq(JSON.stringify(await chrome.storage.local.get(null)).includes(b64(big.subarray(0, 600))), false, 'no plaintext chunk in storage');
  const ab = await call('fileBegin', { name: 'x', file: { name: 'x', size: 5 } }); await call('fileChunk', { id: ab.id, b64: b64(Buffer.from('hello')) }); await call('fileAbort', { id: ab.id });
  eq((await call('fileEnd', { id: ab.id })).ok, false, 'aborted upload cannot be finished');
  eq((await call('load')).usage.quota, 25 * 1024 ** 3, 'usage reports the 25 GB quota');
  eq((await call('fileBegin', { name: 'huge', file: { name: 'h', size: 5 * 1024 ** 3 } })).ok, false, 'file over the per-file cap refused');

  // ---- single-file exports in every wrapper, imported back under ANY file name ----
  const small = (await call('exportBackup', { pw: PW, bpw: BPW, fmt: 'json' }));
  eq(small.ok, true, 'json export of a 5 MB vault works');
  const txt = (await call('exportBackup', { pw: PW, bpw: BPW, fmt: 'txt' })).file;
  eq(/^-----BEGIN CHAT MEMORY BACKUP-----/.test(txt) && !txt.includes('roadmap'), true, 'txt export is armored and encrypted');
  eq(F.sniff(Buffer.from(txt)).kind + ',' + F.sniff(Buffer.from(small.file)).kind, 'json,json', 'both wrappers recognised by content');
  eq(F.sniff(Buffer.from(Buffer.from(small.file).toString('base64'))).kind, 'json', 'bare base64 of the json is recognised too');
  eq(F.sniff(Buffer.from('just some notes, not a backup')), null, 'a normal file is NOT a backup (imported as a plain file instead)');
  eq(F.sniff(Buffer.from('{"title":"chatgpt conversations.json","mapping":{}}')), null, 'other JSON is NOT a backup');
  for (const [wrapper, name] of [[txt, 'notes.txt'], [small.file, 'photo.png'], ['junk before ' + small.file + ' junk after', 'whatever']]) {
    chrome.__wipe(); await call('setup', { pw: NEW });
    const r = await call('importBackup', { b64: b64(Buffer.from(wrapper)), pw: BPW, vpw: NEW }); eq(r.ok && r.items === 2, true, 'import works for file named "' + name + '"');
  }
  d = (await call('load')).data; const re = d.items.find((i) => i.file);
  const back = Buffer.concat(await Promise.all([0, 1, 2].map(async (n) => Buffer.from((await call('getChunk', { id: re.id, n })).b64, 'base64'))));
  eq(back.equals(big), true, 'file inside the imported backup is byte-identical (re-chunked)');
  eq((await call('importBackup', { b64: b64(Buffer.from(txt)), pw: 'Wrong#Pass1234xx', vpw: NEW })).ok, false, 'wrong backup password refused for txt too');

  // ---- Large backup (.cmbak) stream: export -> import (merge) -> restore after wipe ----
  chrome.__wipe(); await call('setup', { pw: PW });
  const f2 = (await call('mutate', { m: { op: 'addFolder', name: 'Gemini' } })).r;
  for (let k = 0; k < 7; k++) await call('mutate', { m: { op: 'addItem', name: 'Chat ' + k, folder: f2, text: 'conversation number ' + k + ' '.repeat(1) + 'x'.repeat(1000), summary: '' } });
  await call('reauth', { pw: PW }); await call('addFile', { name: 'pdf', folder: f2, text: 'pdf text', file: { name: 'a.pdf', mime: 'application/pdf', size: big.length, b64: b64(big) } });
  eq((await streamOut('Nope-Nope#1234x', BPW)).ok, false, 'large export: wrong vault password refused');
  eq((await streamOut(PW, 'weak')).ok, false, 'large export: weak backup password refused');
  const bin = await streamOut(PW, BPW); eq(bin.ok, true, 'large export streams');
  eq(bin.file.slice(0, 6).toString(), 'CMBK1\n', 'file starts with the CMBK1 magic');
  eq(bin.file.includes(Buffer.from('conversation number')), false, 'no plaintext in the .cmbak');
  eq(F.sniff(new Uint8Array(bin.file.subarray(0, 4096))).kind, 'bin', 'recognised by content, name irrelevant');
  const tooBig = await call('exportBackup', { pw: PW, bpw: BPW, fmt: 'json' }); eq(tooBig.ok, true, 'json still allowed under the single-file cap');
  // merge into a vault that already has some of it
  chrome.__wipe(); await call('setup', { pw: NEW }); await call('mutate', { m: { op: 'addItem', name: 'mine', text: 'mine' } });
  eq((await streamIn(bin.file, { pw: BPW, vpw: 'wrong' })).ok, false, 'large import: wrong vault password refused');
  eq((await streamIn(bin.file, { pw: 'Wrong#Pass1234xx', vpw: NEW })).ok, false, 'large import: wrong backup password refused (and vault not erased)');
  eq((await call('status')).exists, true, 'vault survives wrong backup password');
  const ri = await streamIn(bin.file, { pw: BPW, vpw: NEW }); eq(ri.ok + ':' + ri.items + ':' + ri.folders, 'true:8:1', 'large import merged 8 items + 1 folder');
  d = (await call('load')).data; const pf = d.items.find((i) => i.file);
  const g2 = []; for (let n = 0; n < pf.file.chunks; n++) g2.push(Buffer.from((await call('getChunk', { id: pf.id, n })).b64, 'base64'));
  eq(Buffer.concat(g2).equals(big), true, 'large import: attached file byte-identical');
  eq(d.items.some((i) => i.name === 'mine'), true, 'existing items untouched');
  eq((await streamIn(bin.file, { pw: BPW, vpw: NEW })).items, 0, 'importing again adds nothing');
  // truncated / tampered
  chrome.__wipe(); await call('setup', { pw: NEW });
  eq((await streamIn(bin.file.subarray(0, bin.file.length - 40), { pw: BPW, vpw: NEW })).ok, false, 'truncated .cmbak rejected');
  const tam = Buffer.from(bin.file); tam[tam.length - 500] ^= 1; eq((await streamIn(tam, { pw: BPW, vpw: NEW })).ok, false, 'tampered .cmbak rejected');
  eq((await call('load')).data.items.length, 0, 'rejected imports leave no items behind');
  eq(Object.keys(await chrome.storage.local.get(null)).some((k) => k.startsWith('cm_f_')), false, 'and no orphan file chunks');
  // restore into a brand-new vault straight from a .cmbak
  chrome.__wipe();
  const rr = await streamIn(bin.file, { pw: BPW, restore: true, newPw: NEW }); eq(rr.ok + ':' + rr.items, 'true:8', 'restore from .cmbak into a fresh vault');
  eq((await call('status')).unlocked, true, 'restored vault is unlocked for this tab');
  chrome.__wipe(); eq((await streamIn(bin.file, { pw: BPW, restore: true, newPw: 'weak' })).ok, false, 'restore: weak new vault password refused');
  console.log('ALL LARGE TESTS PASSED'); process.exit(0);
})();
