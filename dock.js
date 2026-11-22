// Chat Memory v3 - the dock UI. Runs inside the extension's own iframe (dock.html), so the chat website can never see what you type.
// It never holds the key: all encrypt/decrypt happens in the service worker (background.js).
(() => {
  if (window.__cmDock) return; window.__cmDock = 1;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ORIGIN = (location.ancestorOrigins && location.ancestorOrigins[0]) || ''; // which site this dock is open on (each site/tab needs its own unlock)
  const call = async (type, p = {}) => {
    try { const r = await chrome.runtime.sendMessage({ type, origin: ORIGIN, ...p }); return r || { ok: false, error: 'No response' }; }
    catch (e) { return { ok: false, error: 'Extension was reloaded - refresh this page.' }; }
  };
  const rpc = (op, args = {}) => call('page', { op, args }); // dock -> background -> chat page (chrome.runtime only; pages cannot listen or forge)

  // ---------- helpers: summarise / insert ----------
  function extractive(t, n = 5) {
    const sents = t.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [t];
    if (sents.length <= n) return sents.map((s) => s.trim()).join(' ');
    const stop = new Set('the a an and or of to in is are was were it this that for on with as be by at from you your we they he she not but if so do does did have has had can will would should could'.split(' '));
    const words = (s) => (s.toLowerCase().match(/[a-z']{3,}/g) || []).filter((w) => !stop.has(w));
    const f = {}; words(t).forEach((w) => { f[w] = (f[w] || 0) + 1; });
    return sents.map((s, i) => ({ i, s: s.trim(), v: words(s).reduce((a, w) => a + f[w], 0) / Math.sqrt(s.length + 1) }))
      .sort((a, b) => b.v - a.v).slice(0, n).sort((a, b) => a.i - b.i).map((x) => '- ' + x.s).join('\n');
  }
  async function summarise(text) {
    text = text.slice(0, 12000);
    try { // Chrome built-in on-device AI (Gemini Nano) when this browser/page context exposes it
      if ('Summarizer' in self) {
        const o = { type: 'key-points', format: 'plain-text', length: 'medium' };
        if ((await Summarizer.availability(o)) !== 'unavailable') {
          const r = await (await Summarizer.create(o)).summarize(text);
          if (r && r.trim().length > 20 && !/not available/i.test(r)) return { text: r.trim(), by: 'on-device AI' };
        }
      }
    } catch (e) {}
    return { text: extractive(text), by: 'local extractive' };
  }
  const $ = (s) => document.querySelector(s), sh = document;
  const esc2 = esc;
  const modal = (html, setup) => new Promise((res) => {
    const m = $('#modal'); m.innerHTML = '<div class="mb">' + html + '</div>'; m.hidden = false;
    setup(m, (v) => { m.hidden = true; m.innerHTML = ''; res(v); });
  });
  const askConfirm = (msg) => modal('<p>' + esc2(msg) + '</p><div class="row"><button id="mn">Cancel</button><button class="pri" id="my">Yes</button></div>', (m, d) => { m.querySelector('#mn').onclick = () => d(false); m.querySelector('#my').onclick = () => d(true); });
  const meterHtml = (id) => `<div id="lab_${id}" style="font-size:11px;font-weight:700"></div><div class="pwbar"><i id="bar_${id}"></i></div><div class="dim" id="hint_${id}" style="font-size:11px"></div><ul class="rules" id="rules_${id}"></ul><label class="dim" style="font-size:11px;display:block;margin:0 0 8px"><input type="checkbox" id="show_${id}" style="width:auto;margin:0 4px 0 0">Show password</label>`;
  function meterUpdate(root, id, pw, bad) {
    const r = CMPW.check(pw), bar = root.querySelector('#bar_' + id);
    const lab = root.querySelector('#lab_' + id); lab.textContent = pw ? ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'][r.score] : ''; lab.style.color = ['#c62828', '#c62828', '#e08a00', '#7cb518', '#12805c'][r.score];
    const sw = root.querySelector('#show_' + id); if (sw) sw.onchange = () => { const ids = [id === 'p1' ? 'p1' : id === 'rn' ? 'rn' : 'f_' + id, id === 'p1' ? 'p2' : id === 'b1' ? 'f_b2' : null].filter(Boolean); ids.forEach((x) => { const e = root.querySelector('#' + x); if (e) e.type = sw.checked ? 'text' : 'password'; }); };
    bar.style.width = (r.score * 25) + '%'; bar.style.background = ['#c62828', '#c62828', '#e08a00', '#7cb518', '#12805c'][r.score];
    root.querySelector('#rules_' + id).innerHTML = r.rules.map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? '\u2713' : '\u2717'} ${esc(x.label)}</li>`).join('');
    const h = root.querySelector('#hint_' + id);
    h.textContent = pw ? (r.ok ? 'Strong password. Nobody guessing or intercepting your data can easily crack this.' : CMPW.explain(pw)) : 'Create a strong password so nobody who intercepts your stored data can guess it.';
    h.className = pw && !r.ok && bad ? 'err' : 'dim'; return r.ok;
  }
  const askForm = (msg, fields, ok) => modal('<p>' + esc2(msg) + '</p>' + fields.map((f) => '<label class="dim">' + esc2(f.label) + '</label>' + (f.options ? '<select id="f_' + f.id + '">' + f.options.map((o) => '<option value="' + esc2(o[0]) + '">' + esc2(o[1]) + '</option>').join('') + '</select>' : '<input id="f_' + f.id + '" type="password" autocomplete="off">') + (f.strong ? meterHtml(f.id) : '')).join('') + '<div class="row"><button id="mn">Cancel</button><button class="pri" id="my">' + esc2(ok || 'OK') + '</button></div>', (m, d) => {
    const first = m.querySelector('input,select'); if (first) first.focus();
    fields.filter((f) => f.strong).forEach((f) => { const inp = m.querySelector('#f_' + f.id); meterUpdate(m, f.id, ''); inp.oninput = () => meterUpdate(m, f.id, inp.value); });
    const get = () => Object.fromEntries(fields.map((f) => [f.id, m.querySelector('#f_' + f.id).value]));
    const submit = () => { const v = get(); const weak = fields.find((f) => f.strong && !CMPW.check(v[f.id]).ok); if (weak) { meterUpdate(m, weak.id, v[weak.id], true); m.querySelector('#f_' + weak.id).focus(); return; } d(v); };
    m.querySelector('#mn').onclick = () => d(null); m.querySelector('#my').onclick = submit;
    m.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
  const askText = (msg, def) => modal('<p>' + esc2(msg) + '</p><input id="mi" value="' + esc2(def || '') + '"><div class="row"><button id="mn">Cancel</button><button class="pri" id="my">OK</button></div>', (m, d) => { const i = m.querySelector('#mi'); i.focus(); i.select(); m.querySelector('#mn').onclick = () => d(null); m.querySelector('#my').onclick = () => d(i.value); i.onkeydown = (e) => { if (e.key === 'Enter') d(i.value); }; });

  // ---------- read ANY file type for import: text, Office/OpenDocument/ePub (zip + xml), PDF (best effort); everything else is kept as the original file ----------
  const TEXT_EXT = new Set('txt md markdown csv tsv json jsonl html htm xml log yaml yml ini cfg conf toml tex srt vtt js ts jsx tsx py java c cpp h cs go rb php sh sql css scss swift kt rs r ipynb env gitignore'.split(' '));
  const extOf = (n) => (String(n).split('.').pop() || '').toLowerCase();
  const asB64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  async function inflate(u8, fmt) { const ds = new DecompressionStream(fmt); const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {}); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
  async function unzip(buf, want) {
    const u = new Uint8Array(buf), dv = new DataView(buf); let e = -1;
    for (let i = u.length - 22; i >= Math.max(0, u.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip');
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), cs = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nl)); p += 46 + nl + el + cl;
      if (!want(name)) continue;
      const ds = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), raw = u.subarray(ds, ds + cs);
      try { out.push({ name, data: method === 0 ? raw : await inflate(raw, 'deflate-raw') }); } catch (er) {}
    }
    return out;
  }
  const unent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, c) => String.fromCodePoint(+c)).replace(/&#x([0-9a-f]+);/gi, (m, c) => String.fromCodePoint(parseInt(c, 16))).replace(/&amp;/g, '&');
  const xmlText = (x) => unent(x.replace(/<\/(w:p|a:p|text:p|text:h|p|div|li|tr|row|si)>|<br\s*\/?>|<w:br\s*\/?>/gi, '\n').replace(/<\/(w:tc|a:tc|td|c)>/gi, '\t').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const utf8 = (u8) => new TextDecoder('utf-8').decode(u8);
  async function officeText(buf, ext) {
    const num = (s) => +(s.match(/(\d+)\.xml$/) || [0, 0])[1];
    if (ext === 'docx' || ext === 'dotx') return (await unzip(buf, (n) => /^word\/(document|header\d*|footer\d*|footnotes)\.xml$/.test(n))).map((e) => xmlText(utf8(e.data))).join('\n\n');
    if (ext === 'pptx') return (await unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).sort((a, b) => num(a.name) - num(b.name)).map((e, i) => '--- Slide ' + (i + 1) + ' ---\n' + xmlText(utf8(e.data))).join('\n\n');
    if (ext === 'xlsx') return (await unzip(buf, (n) => n === 'xl/sharedStrings.xml')).map((e) => xmlText(utf8(e.data))).join('\n');
    if (['odt', 'odp', 'ods'].includes(ext)) return (await unzip(buf, (n) => n === 'content.xml')).map((e) => xmlText(utf8(e.data))).join('\n');
    if (ext === 'epub') return (await unzip(buf, (n) => /\.(xhtml|html|htm)$/i.test(n))).map((e) => xmlText(utf8(e.data))).join('\n\n');
    return '';
  }
  async function pdfText(buf) { // best effort: reads text from uncompressed / Flate streams; scanned or exotic-font PDFs may give little or nothing
    const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    const out = []; const re = /stream\r?\n/g; let m, guard = 0;
    while ((m = re.exec(s)) && guard++ < 3000) {
      const end = s.indexOf('endstream', re.lastIndex); if (end < 0) break;
      const body = s.slice(re.lastIndex, end).replace(/\r?\n$/, ''); re.lastIndex = end + 9;
      const bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 255); let txt = '';
      try { txt = String.fromCharCode.apply(null, await inflate(bytes, 'deflate')); } catch (e) { txt = body; }
      if (!/\b(Tj|TJ)\b/.test(txt)) continue;
      const un = (t) => t.replace(/\\([nrtbf()\\])/g, (x, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '' }[c] ?? c)).replace(/\\(\d{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8)));
      txt.split(/\bET\b/).forEach((blk) => {
        let line = ''; blk.replace(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj/g, (x, arr, one) => { if (one != null) line += un(one); else arr.replace(/\(((?:[^)\\]|\\.)*)\)|(-?\d+\.?\d*)/g, (y, t, k) => { if (t != null) line += un(t); else if (+k < -200) line += ' '; }); return ''; });
        if (line.trim()) out.push(line.trim());
      });
    }
    const t = out.join('\n'); const letters = (t.match(/[A-Za-z\u0900-\u097F]/g) || []).length;
    return letters > 30 && letters / Math.max(1, t.length) > 0.4 ? t : '';
  }
  async function readForImport(file) {
    const ext = extOf(file.name); let text = '', how = 'stored only';
    if (file.size > 100 * 1048576) return { text: '', how: 'stored only (too large to read text from)' }; // big files are stored, not parsed
    const buf = await file.arrayBuffer(), head = new Uint8Array(buf.slice(0, 4000));
    try {
      if (['docx', 'dotx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub'].includes(ext)) { text = await officeText(buf, ext); how = 'text extracted'; }
      else if (ext === 'pdf' || file.type === 'application/pdf') { text = await pdfText(buf); how = text ? 'text extracted' : 'stored only (no readable text found)'; }
      else if (file.type.startsWith('text/') || TEXT_EXT.has(ext) || !head.includes(0)) {
        const t = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buf)); text = ext === 'rtf' ? t.replace(/\{\\\*[^}]*\}/g, '').replace(/\\par[d]?/g, '\n').replace(/\\'[0-9a-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '') : t; how = 'text read';
      }
    } catch (e) { text = ''; if (how === 'text read' || how === 'stored only') how = 'stored only'; }
    return { text: text.trim().slice(0, 2000000), how };
  }
  const fmtSize = (n) => n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const MAX_FILE = 4 * 1024 * 1024 * 1024, CH = 2 * 1024 * 1024, MAX_FRAME = 16 * 1048576;
  const readSlice = async (file, o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer());
  const u8b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const b64u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const cat = (a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; a.forEach((x) => { o.set(x, p); p += x.length; }); return o; };
  const saveBlob = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
  // Decide what a chosen file is from its CONTENT (never its name or extension): a Chat Memory backup (json / armored txt / .cmbak) or an ordinary file.
  async function identify(file) {
    const head = await readSlice(file, 0, Math.min(file.size, 70000)); let f = CMFMT.sniff(head);
    if (f && f.kind === 'bin') return f;
    if (file.size <= 40 * 1048576) { const all = await readSlice(file, 0, file.size); f = CMFMT.sniff(all); if (f && f.kind === 'json') return { kind: 'json', bytes: all }; }
    return { kind: 'file' };
  }
  // Streams a .cmbak into the service worker a few MB at a time (whole frames only), so a 25 GB backup never has to fit in memory.
  async function streamImport(file, f, args) {
    const r0 = await call('impBegin', { head: u8b64(await readSlice(file, 0, f.dataStart)), ...args }); if (!r0.ok) return r0;
    let p = f.dataStart, buf = [], size = 0; const bad = { ok: false, error: 'This backup file is damaged' };
    const flush = async () => { if (!buf.length) return { ok: true }; const r = await call('impFeed', { b64: u8b64(cat(buf)) }); buf = []; size = 0; return r; };
    while (p < file.size) {
      const lh = await readSlice(file, p, 4); if (lh.length < 4) { await call('impAbort'); return bad; }
      const len = new DataView(lh.buffer).getUint32(0, false); if (len > MAX_FRAME || p + 4 + len > file.size) { await call('impAbort'); return bad; }
      const fr = await readSlice(file, p, 4 + len); p += 4 + len; buf.push(fr); size += fr.length;
      if (size >= 3 * 1048576) { const r = await flush(); if (!r.ok) { await call('impAbort'); return r; } say('Importing backup... ' + Math.round(p / file.size * 100) + '%'); }
    }
    const r = await flush(); if (!r.ok) { await call('impAbort'); return r; }
    return call('impEnd');
  }
  // Any file, any size: sent as 2 MB encrypted chunks (needs the password re-check first).
  async function importOne(f, folder) {
    if (f.size > MAX_FILE) return { ok: false, error: 'over 4 GB' };
    let rd = { text: '' }; try { rd = await readForImport(f); } catch (e) {}
    const b = await call('fileBegin', { name: f.name.replace(/\.[^.]+$/, '') || f.name, folder, text: rd.text, file: { name: f.name, mime: f.type || 'application/octet-stream', size: f.size } }); if (!b.ok) return b;
    let o = 0; do {
      const r = await call('fileChunk', { id: b.id, b64: u8b64(await readSlice(f, o, CH)) }); if (!r.ok) { await call('fileAbort', { id: b.id }); return r; }
      o += CH; if (f.size > 8 * CH) say('Importing ' + f.name + ' ... ' + Math.round(Math.min(o, f.size) / f.size * 100) + '%');
    } while (o < f.size);
    return call('fileEnd', { id: b.id });
  }
  async function downloadFile(id) { // chunked download: never holds the whole file in memory at once
    let blob = new Blob([]), n = 0, chunks = 1, meta = null;
    do { const r = await call('getChunk', { id, n }); if (!r.ok) return r; meta = r; chunks = r.chunks; blob = new Blob([blob, b64u8(r.b64)]); n++; if (chunks > 8) say('Preparing download... ' + Math.round(n / chunks * 100) + '%'); } while (n < chunks);
    saveBlob(new Blob([blob], { type: meta.mime || 'application/octet-stream' }), meta.name); return { ok: true };
  }
  function download(b64, name, mime) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' })); a.download = name || 'file'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const S = { status: null, data: null, view: 'save', draft: { text: '', summary: '', by: '', msgs: [], name: '' }, commitId: '', commitMode: 'full', lastAuto: '', autoBusy: false };
  const say = (t, bad) => { $('#msg').innerHTML = `<span class="${bad ? 'err' : 'ok'}">${esc(t)}</span>`; };
  let lastTouch = 0;
  const touch = () => { if (Date.now() - lastTouch > 20000) { lastTouch = Date.now(); call('touch'); } };

  // force=false is used by passive triggers (window focus / storage signals): it re-draws ONLY if something really changed,
  // so the screen is never rebuilt while you are choosing a file or typing (that rebuild used to wipe the chosen file).
  let lastSig = '';
  async function refresh(force) {
    const r = await call('status');
    if (!r.ok) { S.status = null; lastSig = ''; return render(r.error); }
    let data = null, st = r; S.usage = null;
    if (r.unlocked) { const d = await call('load'); data = d.ok ? d.data : null; S.usage = d.ok ? d.usage : null; if (!d.ok) st = { ...r, unlocked: false }; }
    const sig = JSON.stringify([st, data, S.usage]);
    if (!force && sig === lastSig) return;
    lastSig = sig; S.status = st; S.data = data;
    if (!st.unlocked) S.draft = { text: '', summary: '', by: '', msgs: [], name: '' };
    render();
  }
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cm_signal) refresh(false); });

  // ---------- views ----------
  function render(err) {
    const b = $('#body'); $('#lockBtn').hidden = !(S.status && S.status.unlocked);
    if (!S.status) { b.innerHTML = `<p class="err">${esc(err || 'Could not reach extension')}</p>`; return; }
    if (!S.status.exists) return authView(b, true);
    if (!S.status.unlocked) return authView(b, false);
    b.innerHTML = `<nav>${['save', 'library', 'commit', 'settings'].map((v) => `<button data-v="${v}" class="${S.view === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</nav><div id="v"></div>`;
    b.querySelectorAll('nav button').forEach((x) => { x.onclick = () => { S.view = x.dataset.v; render(); }; });
    ({ save: saveView, library: libView, commit: commitView, settings: setView })[S.view]($('#v'));
  }

  function authView(b, setup) {
    const left = Math.max(0, 2 - (S.status.fails || 0));
    b.innerHTML = setup
      ? `${S.status.wiped ? '<p class="err"><b>Your vault was erased after two wrong passwords.</b> Create a new vault, or restore from your encrypted backup below.</p>' : ''}
         <p><b>Create your vault password</b></p><p class="dim">Everything you save is encrypted with this password (AES-256-GCM) before it is stored. <b>Two wrong passwords in a row erase the whole vault</b> and there is no password reset, so export an encrypted backup.</p>
         <input id="p1" type="password" placeholder="Password" autocomplete="new-password">${meterHtml('p1')}<input id="p2" type="password" placeholder="Repeat password" autocomplete="new-password"><button class="pri" id="go">Create vault</button>
         <details style="margin-top:12px" ${S.status.wiped ? 'open' : ''}><summary>Restore from an encrypted backup</summary><p class="dim">Choose your backup file (any file name or extension: .json, .txt, .cmbak ...), type the backup password, and choose a strong password for the restored vault.</p>
         <input id="rf" type="file"><input id="rb" type="password" placeholder="Backup password" autocomplete="off"><input id="rn" type="password" placeholder="New vault password" autocomplete="new-password">${meterHtml('rn')}<button id="rs">Restore</button></details>`
      : `<p><b>Vault is locked</b></p><p class="dim">Each browser tab and each site (ChatGPT, Claude, Gemini) asks for the vault password on its own, even if you already unlocked it somewhere else.</p><input id="p1" type="password" placeholder="Vault password" autocomplete="current-password"><button class="pri" id="go">Unlock here</button>
         <p class="${left < 2 ? 'err' : 'dim'}">${left < 2 ? 'Warning: ' + left + ' attempt left. One more wrong password ERASES the vault.' : 'You have 2 attempts. A second wrong password erases the vault (you can restore it from your encrypted backup).'}</p>`;
    if (setup) { meterUpdate(b, 'p1', ''); $('#p1').oninput = () => meterUpdate(b, 'p1', $('#p1').value); meterUpdate(b, 'rn', ''); $('#rn').oninput = () => meterUpdate(b, 'rn', $('#rn').value); }
    const go = async () => {
      const pw = $('#p1').value;
      if (setup) { if (!CMPW.check(pw).ok) { meterUpdate(b, 'p1', pw, true); return say(CMPW.explain(pw), 1); } if (pw !== $('#p2').value) return say('Passwords do not match', 1); }
      say('Working... (key derivation takes a moment)');
      const r = await call(setup ? 'setup' : 'unlock', { pw });
      if (!r.ok) { say(r.error, 1); refresh(true); return; }
      say(setup ? 'Vault created' : 'Unlocked'); refresh(true);
    };
    $('#go').onclick = go; $('#p1').onkeydown = (e) => { if (e.key === 'Enter' && !setup) go(); }; $('#p1').focus();
    const rs = $('#rs');
    if (rs) rs.onclick = async () => {
      const f = $('#rf').files[0]; if (!f) return say('Choose a backup file first', 1);
      const np = $('#rn').value; if (!CMPW.check(np).ok) { meterUpdate(b, 'rn', np, true); return say(CMPW.explain(np), 1); }
      say('Reading the file...'); const id = await identify(f);
      if (id.kind === 'file') return say('This file is not a Chat Memory backup. (A backup is the encrypted file you exported from Chat Memory, in any of its formats.)', 1);
      say('Restoring... (key derivation takes a moment)');
      const r = id.kind === 'bin' ? await streamImport(f, id, { pw: $('#rb').value, restore: true, newPw: np }) : await call('restoreBackup', { b64: u8b64(id.bytes), pw: $('#rb').value, newPw: np });
      if (!r.ok) return say(r.error, 1); say('Restored ' + r.items + ' memories'); refresh(true);
    };
  }

  const folderOpts = (sel) => `<option value="">No folder (standalone file)</option>` + S.data.folders.map((f) => `<option value="${f.id}" ${sel === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  const joinMsgs = (msgs) => msgs.map((m) => (m.role === 'Chat' ? m.text : m.role + ': ' + m.text)).join('\n\n');

  // Layout-independent capture (content.js falls back to reading the page's main region when a site's layout changed).
  async function capture() {
    const sc = await rpc('scan'); if (sc.ok === false) { say(sc.error, 1); return null; }
    const msgs = (sc.msgs || []).map((m) => ({ ...m, on: true })); if (!msgs.length) return null;
    const meta = await rpc('meta'); return { msgs, layout: sc.layout, meta: meta.ok === false ? {} : meta };
  }
  async function autoCapture() { // runs when the dock opens: fills the draft with the current chat so one tap can save it
    const d = S.draft; if (S.autoBusy || S.view !== 'save' || !S.data || (d.text && d.text !== S.lastAuto)) return;
    S.autoBusy = true; const c = await capture(); S.autoBusy = false;
    if (!c || S.view !== 'save' || (d.text && d.text !== S.lastAuto)) return;
    const t = joinMsgs(c.msgs); if (t === d.text) return; // nothing new: do not redraw (prevents a render loop)
    d.msgs = c.msgs; d.text = S.lastAuto = t; d.meta = c.meta; render();
  }
  async function quickSave() {
    say('Reading this page...'); const c = await capture();
    if (!c) return say('Nothing readable found on this page. Open a conversation, or use Highlight / paste.', 1);
    const text = joinMsgs(c.msgs.filter((m) => m.on)); say('Summarising...'); const sm = await summarise(text);
    const label = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }[c.meta.site] || 'Chats'; // sorted automatically into a folder per platform
    let folder = (S.data.folders.find((f) => f.name === label) || {}).id || null;
    if (!folder) { const r = await call('mutate', { m: { op: 'addFolder', name: label } }); if (!r.ok) return say(r.error, 1); folder = r.r; }
    const first = (c.msgs.find((m) => m.role === 'You') || c.msgs[0]).text.replace(/\s+/g, ' ').slice(0, 50);
    const name = (c.meta.title || first || 'Chat') + ' - ' + new Date().toLocaleDateString();
    const r = await call('mutate', { m: { op: 'addItem', name, folder, text, summary: sm.text } });
    if (!r.ok) return say(r.error, 1);
    S.draft = { text: '', summary: '', by: '', msgs: [], name: '' }; S.lastAuto = ''; say('Saved to "' + label + '" with a summary (' + sm.by + ')'); refresh(true);
  }

  function saveView(v) {
    const d = S.draft;
    v.innerHTML = `<button class="pri" id="qs" style="margin:0 0 8px">One tap: capture, summarise, sort &amp; save</button><p class="dim" style="margin:0 0 6px">Reads the whole conversation even if the site's layout changed, then files it in a folder named after the platform.</p>
      <div class="row"><button id="bM">Chat messages</button><button id="bP">Page text</button><button id="bS">Highlight</button></div>
      <div id="msgs"></div>
      <textarea id="txt" placeholder="Or paste / edit the text to save here">${esc(d.text)}</textarea>
      <div class="row"><button id="bSum">Summarise</button><small id="by">${esc(d.by ? 'by ' + d.by : '')}</small></div>
      <textarea id="sum" style="min-height:60px" placeholder="Summary (optional, editable)">${esc(d.summary)}</textarea>
      <input id="nm" placeholder="Name this memory" value="${esc(d.name)}">
      <select id="fo">${folderOpts('')}</select><input id="nf" placeholder="...or create a new folder">
      <button class="pri" id="save">Save (encrypted)</button>`;
    const sync = () => { d.text = $('#txt').value; d.summary = $('#sum').value; d.name = $('#nm').value; };
    ['#txt', '#sum', '#nm'].forEach((s) => { $(s).oninput = sync; });
    const drawMsgs = () => {
      $('#msgs').innerHTML = d.msgs.length > 1 || (d.msgs[0] && d.msgs[0].role !== 'Chat') ? d.msgs.map((m, i) => `<label class="m"><input type="checkbox" data-i="${i}" ${m.on ? 'checked' : ''}><span><b>${m.role}</b> ${esc(m.text.slice(0, 70))}${m.text.length > 70 ? '...' : ''}</span></label>`).join('') : '';
      $('#msgs').querySelectorAll('input').forEach((c) => { c.onchange = () => { d.msgs[c.dataset.i].on = c.checked; $('#txt').value = d.text = joinMsgs(d.msgs.filter((m) => m.on)); }; });
    };
    drawMsgs();
    $('#qs').onclick = quickSave;
    $('#bM').onclick = async () => {
      const c = await capture(); if (!c) return say('Nothing readable on this page. Use Page text, Highlight, or paste the text.', 1);
      d.msgs = c.msgs; $('#txt').value = d.text = joinMsgs(c.msgs); drawMsgs(); say(c.msgs.length + ' block(s) found (' + c.layout + ') - untick what you do not want');
    };
    $('#bP').onclick = async () => { const r = await rpc('pageText'); d.msgs = []; drawMsgs(); $('#txt').value = d.text = r.text || ''; say('Page text loaded - trim it before saving'); };
    $('#bS').onclick = async () => { const r = await rpc('selection'); if (!(r.text || '').trim()) return say('Highlight some text on the page first', 1); d.msgs = []; drawMsgs(); $('#txt').value = d.text = r.text; say('Highlight captured'); };
    $('#bSum').onclick = async () => {
      sync(); if (!d.text.trim()) return say('Nothing to summarise', 1);
      say('Summarising...'); const r = await summarise(d.text); $('#sum').value = d.summary = r.text; d.by = r.by; $('#by').textContent = 'by ' + r.by; say('Summary ready');
    };
    $('#save').onclick = async () => {
      sync(); if (!d.text.trim()) return say('Nothing to save', 1);
      let folder = $('#fo').value || null; const nf = $('#nf').value.trim();
      if (nf) { const r = await call('mutate', { m: { op: 'addFolder', name: nf } }); if (!r.ok) return say(r.error, 1); folder = r.r; }
      const r = await call('mutate', { m: { op: 'addItem', name: d.name.trim() || d.text.trim().slice(0, 30), folder, text: d.text, summary: d.summary } });
      if (!r.ok) return say(r.error, 1);
      S.draft = { text: '', summary: '', by: '', msgs: [], name: '' }; S.lastAuto = ''; say('Saved & encrypted'); refresh(true);
    };
    if (!d.text) autoCapture();
  }

  function libView(v) {
    v.innerHTML = `<input id="q" placeholder="Search all folders and files..."><div class="row"><input id="nf" placeholder="New folder name"><button id="addF" style="flex:0 0 auto">Add folder</button></div>
      <div id="impBox"><h4>Import files from your computer</h4><select id="impFolder">${folderOpts('')}</select><input id="impFiles" type="file" multiple><button id="impGo">Import into this folder</button><p class="dim">Any file type: PDF, Word, PowerPoint, Excel, text, images, video, zip... up to 4 GB each (sent in encrypted chunks). You will be asked for your vault password first. Text is read from documents so you can search it and add it to a chat; the original file is kept too, encrypted.</p></div><div id="list"></div>`;
    const itemHtml = (i, showFolder) => {
      const fo = S.data.folders.find((f) => f.id === i.folder);
      const body = i.summary || i.text || (i.file ? '(No readable text in this file. It is stored encrypted - use Download original.)' : '');
      return `<details><summary>${esc(i.name)} <small>${showFolder ? esc(fo ? fo.name : 'standalone') + ' - ' : ''}${i.file ? 'file ' + esc(i.file.name) + ' (' + fmtSize(i.file.size) + ') - ' : ''}${i.text.length} chars${i.summary ? ' - has summary' : ''}</small></summary>
        <pre>${esc(body.slice(0, 1500))}</pre>
        <div class="row"><button data-a="use" data-id="${i.id}">Add to chat</button><button data-a="sum" data-id="${i.id}">Summarise</button>${i.file ? `<button data-a="dl" data-id="${i.id}">Download original</button>` : ''}<button data-a="ren" data-id="${i.id}">Rename</button><button class="dng" data-a="del" data-id="${i.id}">Delete</button></div>
        <select data-a="mv" data-id="${i.id}">${folderOpts(i.folder).replace('No folder (standalone file)', 'Move to: standalone')}</select></details>`;
    };
    const draw = () => {
      const q = $('#q').value.trim().toLowerCase(), L = $('#list');
      if (q) {
        const hits = S.data.items.filter((i) => (i.name + ' ' + i.text + ' ' + i.summary).toLowerCase().includes(q));
        L.innerHTML = `<h4>${hits.length} result(s)</h4>` + hits.map((i) => itemHtml(i, true)).join('');
      } else {
        L.innerHTML = S.data.folders.map((f) => `<h4>${esc(f.name)}<button class="dng" data-a="delf" data-id="${f.id}">x</button></h4>` + (S.data.items.filter((i) => i.folder === f.id).map((i) => itemHtml(i)).join('') || '<small>empty</small>')).join('')
          + `<h4>Standalone files</h4>` + (S.data.items.filter((i) => !i.folder).map((i) => itemHtml(i)).join('') || '<small>none</small>');
      }
    };
    draw(); $('#q').oninput = draw;
    $('#impGo').onclick = async () => {
      const files = [...$('#impFiles').files]; if (!files.length) return say('Choose one or more files first', 1);
      const folder = $('#impFolder').value || null;
      const pf = await askForm('Importing files needs your vault password. Enter it to continue (a wrong password counts toward the two-attempt limit).', [{ id: 'pw', label: 'Your vault password' }], 'Continue');
      if (!pf) return; say('Checking password...');
      const ra = await call('reauth', { pw: pf.pw }); if (!ra.ok) { say(ra.error, 1); refresh(true); return; }
      let n = 0; const notes = [];
      for (let k = 0; k < files.length; k++) {
        const f = files[k]; say('Importing ' + (k + 1) + ' of ' + files.length + ': ' + f.name + ' ...');
        const r = await importOne(f, folder);
        if (r.ok) n++; else notes.push(f.name + ': ' + r.error);
      }
      say('Imported ' + n + ' of ' + files.length + ' file(s)' + (notes.length ? '. Problems: ' + notes.join('; ') : ''), n === 0); refresh(true);
    };
    $('#addF').onclick = async () => { const n = $('#nf').value.trim(); if (!n) return; await call('mutate', { m: { op: 'addFolder', name: n } }); refresh(true); };
    const act = async (el) => {
      const id = el.dataset.id, a = el.dataset.a, it = S.data.items.find((i) => i.id === id);
      if (a === 'use') { if (it && !it.text.trim() && !it.summary) return say('This file has no readable text to put in a chat. Use Download original.', 1); S.commitId = id; S.view = 'commit'; return render(); }
      if (a === 'dl') { say('Preparing download...'); const r = await downloadFile(id); if (!r.ok) return say(r.error, 1); return say('Original file downloaded'); }
      if (a === 'sum') { if (!it.text.trim()) return say('Nothing to summarise in this file', 1); say('Summarising...'); const r = await summarise(it.text); await call('mutate', { m: { op: 'editItem', id, patch: { summary: r.text } } }); say('Summary saved (' + r.by + ')'); return refresh(true); }
      if (a === 'ren') { const n = await askText('New name', it.name); if (n && n.trim()) { await call('mutate', { m: { op: 'editItem', id, patch: { name: n.trim() } } }); refresh(true); } return; }
      if (a === 'del') { if (await askConfirm('Delete "' + it.name + '"?')) { await call('mutate', { m: { op: 'delItem', id } }); refresh(true); } return; }
      if (a === 'delf') { if (await askConfirm('Delete this folder? Its files become standalone.')) { await call('mutate', { m: { op: 'delFolder', id } }); refresh(true); } }
    };
    $('#list').onclick = (e) => { const b = e.target.closest('button[data-a]'); if (b) act(b); };
    $('#list').onchange = async (e) => { if (e.target.dataset.a === 'mv') { await call('mutate', { m: { op: 'editItem', id: e.target.dataset.id, patch: { folder: e.target.value || null } } }); refresh(true); } };
  }

  function commitView(v) {
    const D = S.data;
    const opts = `<option value="">Choose a file or folder...</option>` + D.folders.map((f) => `<optgroup label="${esc(f.name)}"><option value="f:${f.id}">Entire folder: ${esc(f.name)}</option>${D.items.filter((i) => i.folder === f.id).map((i) => `<option value="i:${i.id}">${esc(i.name)}</option>`).join('')}</optgroup>`).join('')
      + `<optgroup label="Standalone">${D.items.filter((i) => !i.folder).map((i) => `<option value="i:${i.id}">${esc(i.name)}</option>`).join('')}</optgroup>`;
    v.innerHTML = `<select id="pick">${opts}</select>
      <div class="row"><label><input type="radio" name="md" value="full" ${S.commitMode === 'full' ? 'checked' : ''} style="width:auto"> Full text</label><label><input type="radio" name="md" value="summary" ${S.commitMode === 'summary' ? 'checked' : ''} style="width:auto"> Summary (smaller)</label></div>
      <textarea id="pv" style="min-height:140px" placeholder="Preview - you can edit before adding"></textarea>
      <button class="pri" id="add">Add to this chat</button><p class="dim">It is placed in your message box. You press send yourself.</p>`;
    const build = () => {
      const val = $('#pick').value; if (!val) return ($('#pv').value = '');
      const mode = sh.querySelector('input[name=md]:checked').value; S.commitMode = mode;
      const txt = (i) => (mode === 'summary' && i.summary ? i.summary : i.text);
      const [k, id] = val.split(':');
      $('#pv').value = k === 'i' ? 'Context from my saved memory:\n\n' + txt(D.items.find((i) => i.id === id))
        : 'Context from my saved memory:\n\n' + D.items.filter((i) => i.folder === id).map((i) => '## ' + i.name + '\n' + txt(i)).join('\n\n');
    };
    $('#pick').onchange = build; sh.querySelectorAll('input[name=md]').forEach((r) => { r.onchange = build; });
    if (S.commitId) { $('#pick').value = 'i:' + S.commitId; build(); S.commitId = ''; }
    $('#add').onclick = async () => {
      const t = $('#pv').value; if (!t.trim()) return say('Pick something first', 1);
      if ((await rpc('insert', { text: t + '\n\n' })).done) say('Added to your message box - review it, then send');
      else { try { await navigator.clipboard.writeText(t); say('Could not find the message box - copied to clipboard, paste it'); } catch (e) { say('Could not find the message box', 1); } }
    };
  }

  function setView(v) {
    const m = S.status.settings.autoLockMin;
    v.innerHTML = `<h4>Auto-lock</h4><select id="al">${[1, 5, 15, 30, 60].map((n) => `<option value="${n}" ${n === m ? 'selected' : ''}>After ${n} min of inactivity</option>`).join('')}</select>
      <p class="dim">Also locks when your computer goes idle or the screen locks, and whenever the browser closes.</p><button id="ln">Lock now (all tabs)</button>
      <h4>Storage</h4>${S.usage ? `<div class="pwbar"><i style="width:${Math.max(1, Math.min(100, S.usage.used / S.usage.quota * 100))}%;background:#5b4bf5"></i></div><small>${fmtSize(S.usage.used)} used of ${fmtSize(S.usage.quota)}</small>` : ''}
      <h4>Encrypted backup</h4><button id="ex" class="pri" style="margin-top:0">Export encrypted backup</button>
      <p class="dim">You confirm your vault password, then choose a separate strong <b>backup password</b>. Choose the format: <b>.json</b> or <b>.txt</b> (up to ~20 MB) or <b>Large backup .cmbak</b> (any size, up to 25 GB, streamed). The backup includes your saved chats AND every imported file. Keep the file and that password safe: they are the only way to restore if the vault is ever erased.</p>
      <h4>Import a backup or any file</h4><input id="fi" type="file">
      <select id="bInto"><option value="">Keep the backup's own folders</option>${S.data.folders.map((f) => `<option value="${f.id}">Put everything into: ${esc(f.name)}</option>`).join('')}</select><button id="im">Choose and import</button>
      <p class="dim">Pick any file. If it is a Chat Memory backup (.json, .txt or .cmbak, under any file name) you will be asked for the BACKUP password you chose when exporting, plus your vault password. Anything else is imported as an ordinary file. Import only adds what is missing and never overwrites.</p>
      <p class="dim">${S.data.items.length} saved, ${S.data.folders.length} folder(s).</p>`;
    $('#al').onchange = async () => { await call('setSettings', { autoLockMin: $('#al').value }); say('Auto-lock updated'); refresh(true); };
    $('#ln').onclick = () => call('lock');
    $('#ex').onclick = async () => {
      const f = await askForm('Export an encrypted backup. First confirm your vault password, then choose a strong backup password (needed to restore).', [{ id: 'pw', label: 'Vault password' }, { id: 'fmt', label: 'Format', options: [['json', 'JSON (.json) - up to ~20 MB'], ['txt', 'Text (.txt) - up to ~20 MB'], ['cmbak', 'Large backup (.cmbak) - any size, up to 25 GB']] }, { id: 'b1', label: 'New backup password', strong: true }, { id: 'b2', label: 'Repeat backup password' }], 'Export');
      if (!f) return; if (f.b1 !== f.b2) return say('Backup passwords do not match', 1);
      say('Working... (key derivation takes a moment)'); const day = new Date().toISOString().slice(0, 10);
      if (f.fmt === 'cmbak') {
        const b = await call('exportBegin', { pw: f.pw, bpw: f.b1 }); if (!b.ok) { say(b.error, 1); refresh(true); return; }
        let blob = new Blob([b64u8(b.head)]), from = 0;
        for (;;) {
          const r = await call('exportNext', { from }); if (!r.ok) { await call('exportAbort'); say(r.error, 1); return; }
          blob = new Blob([blob, b64u8(r.b64)]); from = r.next; say('Exporting... ' + Math.round(from / b.total * 100) + '%'); if (r.done) break;
        }
        saveBlob(blob, 'chat-memory-' + day + '.cmbak'); say('Large encrypted backup downloaded (' + fmtSize(blob.size) + ')'); refresh(true); return;
      }
      const r = await call('exportBackup', { pw: f.pw, bpw: f.b1, fmt: f.fmt }); if (!r.ok) { say(r.error, 1); refresh(true); return; }
      saveBlob(new Blob([r.file], { type: f.fmt === 'txt' ? 'text/plain' : 'application/json' }), 'chat-memory-' + day + (f.fmt === 'txt' ? '.cmbackup.txt' : '.cmbackup.json')); say('Encrypted backup downloaded'); refresh(true);
    };
    $('#im').onclick = async () => {
      const file = $('#fi').files[0]; if (!file) return say('Choose a file first', 1);
      say('Reading the file...'); const id = await identify(file);
      if (id.kind === 'file') { // not a backup: import it as an ordinary file, whatever its format
        const pf = await askForm('This is not a Chat Memory backup, so it will be imported as an ordinary file (any format is accepted). Enter your vault password to continue.', [{ id: 'pw', label: 'Your vault password' }], 'Import file');
        if (!pf) return; const ra = await call('reauth', { pw: pf.pw }); if (!ra.ok) { say(ra.error, 1); refresh(true); return; }
        const r = await importOne(file, $('#bInto').value || null); say(r.ok ? 'File imported' : r.error, !r.ok); refresh(true); return;
      }
      const f = await askForm('This is a Chat Memory backup. Enter the BACKUP password you chose when you exported it, and your own vault password to confirm.', [{ id: 'bp', label: 'Backup file password (set when exporting)' }, { id: 'pw', label: 'Your vault password' }], 'Import');
      if (!f) return; say('Decrypting backup...');
      const r = id.kind === 'bin' ? await streamImport(file, id, { pw: f.bp, vpw: f.pw, into: $('#bInto').value || null }) : await call('importBackup', { b64: u8b64(id.bytes), pw: f.bp, vpw: f.pw, into: $('#bInto').value || null });
      if (!r.ok) { say(r.error, 1); refresh(true); return; } say('Imported ' + r.items + ' memories and ' + r.folders + ' folders'); refresh(true);
    };
  }

  // ---------- wiring ----------
  $('#lockBtn').onclick = () => call('lock'); $('#x').onclick = () => rpc('close');
  document.addEventListener('click', touch);
  document.addEventListener('keydown', (e) => { touch(); if (e.key === 'Escape') rpc('close'); });
  const focusFirst = () => { const f = document.querySelector('#body input, #body textarea'); if (f) f.focus(); };
  // the page calls iframe.focus() each time the dock opens. Passive refresh: never rebuilds the screen unless something changed.
  window.addEventListener('focus', () => { if (!$('#modal').hidden) return; refresh(false).then(() => { if (!document.activeElement || document.activeElement === document.body) focusFirst(); autoCapture(); }); });
  refresh(true).then(focusFirst);
})();
