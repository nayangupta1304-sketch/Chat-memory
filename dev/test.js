require('./shim.js'); require('../background.js');
let ORIGIN = 'https://a.test';
const call = (type, p = {}) => chrome.runtime.sendMessage({ type, origin: ORIGIN, ...p });
const eq = (a, b, m) => { if (a !== b) { console.error('FAIL', m, '| got:', a, '| want:', b); process.exit(1); } console.log('ok  ', m); };
const PW = 'Correct-Horse#9Battery', BPW = 'Backup!Pass#5577xy', NEW = 'Brand-New#Gate42xyz', THIRD = 'Third#Vault77qk!z';
(async () => {
  eq((await call('status')).exists, false, 'fresh: no vault');
  // ---- strong passwords are enforced (and the message says what to add) ----
  const weak = await call('setup', { pw: 'short' });
  eq(weak.ok, false, 'short password rejected');
  eq(/uppercase/i.test(weak.error) && /symbol/i.test(weak.error) && /number/i.test(weak.error) && /12 characters/.test(weak.error), true, 'message lists what is missing (length, uppercase, number, symbol)');
  eq((await call('setup', { pw: 'passwordpassword1!A' })).ok, false, 'common word "password" rejected even when long');
  eq((await call('setup', { pw: 'Abcd1234!xyzQ' })).ok, false, 'easy sequence (abcd / 1234) rejected');
  eq((await call('setup', { pw: 'aaaBBB111!!!zz' })).ok, false, 'characters repeated 3x rejected');
  eq((await call('setup', { pw: PW })).ok, true, 'strong password accepted');
  const f = (await call('mutate', { m: { op: 'addFolder', name: 'Project X' } })).r;
  await call('mutate', { m: { op: 'addItem', name: 'Decisions', folder: f, text: 'We use Manifest V3.', summary: 'MV3' } });
  eq(JSON.stringify(await chrome.storage.local.get('cm_vault')).includes('Manifest'), false, 'plaintext NOT in storage');

  // ---- per-tab / per-site unlock ----
  eq((await call('status')).unlocked, true, 'site A unlocked after setup');
  ORIGIN = 'https://b.test'; eq((await call('status')).unlocked, false, 'site B (another tab/site) is NOT unlocked');
  eq((await call('load')).ok, false, 'site B cannot read the vault without the password');
  eq((await call('mutate', { m: { op: 'addItem', name: 'x', text: 'y' } })).ok, false, 'site B cannot write either');
  eq((await call('unlock', { pw: PW })).ok, true, 'site B unlocks with the password');
  eq((await call('load')).ok, true, 'site B can read after its own unlock');
  ORIGIN = 'https://c.test'; eq((await call('status')).unlocked, false, 'site C still locked (unlocking B did not open C)');
  ORIGIN = 'https://a.test'; eq((await call('status')).unlocked, true, 'site A stays unlocked');

  // ---- import any file type: password re-check first ----
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3, 255, 254, 253]); const b64 = bytes.toString('base64');
  eq((await call('addFile', { name: 'scan', text: '', file: { name: 'scan.pdf', mime: 'application/pdf', size: bytes.length, b64 } })).ok, false, 'addFile refused WITHOUT password re-check');
  eq((await call('reauth', { pw: 'Wrong-Pass#11aa' })).ok, false, 'wrong password at import refused...');
  eq((await call('status')).fails, 1, '...and counted as a strike');
  eq((await call('reauth', { pw: PW })).ok, true, 'correct password at import accepted');
  const af = await call('addFile', { name: 'scan', folder: f, text: 'hello pdf', file: { name: 'scan.pdf', mime: 'application/pdf', size: bytes.length, b64 } });
  eq(af.ok, true, 'binary file (pdf/any type) imported after password');
  eq((await call('getFile', { id: af.id })).b64, b64, 'original bytes come back identical');
  eq(JSON.stringify(await chrome.storage.local.get(null)).includes(b64), false, 'file bytes are NOT stored in plaintext');
  ORIGIN = 'https://b.test'; eq((await call('addFile', { name: 'z', file: { name: 'z.bin', b64 } })).ok, false, 'another tab cannot reuse the password re-check'); ORIGIN = 'https://a.test';

  // ---- export (incl. file) needs the vault password again + a STRONG backup password ----
  eq((await call('exportBackup', { pw: PW, bpw: 'x' })).ok, false, 'export: weak backup password rejected');
  const bad = await call('exportBackup', { pw: 'Nope-Nope#1234x', bpw: BPW });
  eq(/1 attempt left/.test(bad.error), true, 'export: WRONG vault password refused and counted as strike 1');
  const file = (await call('exportBackup', { pw: PW, bpw: BPW })).file;
  eq(file.includes('Manifest') || file.includes(b64), false, 'plaintext NOT in export file');
  eq((await call('status')).fails, 0, 'correct password resets the strike counter');
  // ---- two strikes erase the vault (and the stored files) ----
  await call('lock'); eq((await call('load')).ok, false, 'load refused while locked');
  const w1 = await call('unlock', { pw: 'wrong one' }); eq(/1 attempt left/.test(w1.error), true, 'unlock: first wrong password warns');
  const w2 = await call('unlock', { pw: 'wrong two' }); eq(w2.wiped, true, 'unlock: SECOND wrong password erases the vault');
  const st = await call('status'); eq(st.exists + ':' + st.wiped, 'false:true', 'vault gone, wiped flag set');
  const left = JSON.stringify(await chrome.storage.local.get(null)); eq(left.includes('"cm_vault"') || left.includes('cm_f_'), false, 'no vault record or file blob left in storage');
  eq((await call('unlock', { pw: PW })).ok, false, 'even the RIGHT password cannot open an erased vault');
  // ---- restore from backup needs the BACKUP password + a strong new password ----
  eq((await call('restoreBackup', { text: file, pw: PW, newPw: NEW })).ok, false, 'restore: vault password does NOT open the backup');
  eq((await call('restoreBackup', { text: file, pw: BPW, newPw: 'weakpass' })).ok, false, 'restore: weak new vault password rejected');
  eq((await call('restoreBackup', { text: '\uFEFF  ' + file + '\n', pw: BPW, newPw: NEW })).items, 2, 'restore works (BOM/whitespace tolerant, any file name)');
  const d1 = (await call('load')).data; eq(d1.items.find((i) => i.name === 'Decisions').text, 'We use Manifest V3.', 'restored text intact');
  const rid = d1.items.find((i) => i.file).id; eq((await call('getFile', { id: rid })).b64, b64, 'restored backup brought the imported FILE back byte-for-byte');
  eq((await call('status')).wiped, false, 'wiped flag cleared after restore');
  // ---- import: both passwords, merge, into folder ----
  const bf = (await call('exportBackup', { pw: NEW, bpw: BPW })).file;
  eq((await call('importBackup', { text: bf, pw: BPW, vpw: 'wrong' })).ok, false, 'import: wrong vault password refused');
  eq((await call('importBackup', { text: bf, pw: 'wrong backup pw', vpw: NEW })).ok, false, 'import: wrong BACKUP password refused');
  eq((await call('status')).exists, true, 'wrong BACKUP password does not erase the vault');
  eq((await call('importBackup', { text: bf, pw: BPW, vpw: NEW })).items, 0, 'import twice adds no duplicates');
  const t = JSON.parse(bf); t.vault.box.ct = t.vault.box.ct.slice(0, -4) + 'AAAA';
  eq((await call('importBackup', { text: JSON.stringify(t), pw: BPW, vpw: NEW })).ok, false, 'tampered file rejected (GCM tag)');
  eq((await call('importBackup', { text: 'hello, not json', pw: BPW, vpw: NEW })).ok, false, 'non-backup file gives a clear error');
  chrome.__wipe(); await call('setup', { pw: THIRD });
  const tf = (await call('mutate', { m: { op: 'addFolder', name: 'Target' } })).r;
  const r2 = await call('importBackup', { text: bf, pw: BPW, vpw: THIRD, into: tf });
  const d2 = (await call('load')).data; eq(r2.items + ':' + r2.folders + ':' + (d2.items[0].folder === tf), '2:0:true', 'import INTO chosen folder, no new folders');
  const fid = d2.items.find((i) => i.file).id; eq((await call('getFile', { id: fid })).b64, b64, 'imported backup carries the attached file too');
  await call('mutate', { m: { op: 'delItem', id: fid } }); eq(JSON.stringify(await chrome.storage.local.get(null)).includes('cm_f_' + fid), false, 'deleting an item deletes its stored file');
  // ---- idle lock ----
  chrome.__idle('idle'); await new Promise((r) => setTimeout(r, 50)); eq((await call('status')).unlocked, false, 'chrome.idle "idle" locks the vault (all tabs)');
  console.log('ALL PASSED'); process.exit(0);
})();
