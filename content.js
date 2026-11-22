// Chat Memory v3 - content script = thin bridge on the chat page.
// The dock UI lives in an extension iframe (dock.html), so the website cannot read, intercept or steal focus from what you type.
// The dock talks to this script ONLY through chrome.runtime (background relay) - web pages cannot listen to or forge that channel.
(() => {
  if (window.__cmBridge) return; window.__cmBridge = 1;
  const host = location.hostname;
  const SITE = /claude\.ai/.test(host) ? 'claude' : /gemini\.google/.test(host) ? 'gemini' : /chatgpt|openai/.test(host) ? 'chatgpt' : 'demo';
  const site = () => window.__cmSite || SITE; // __cmSite lets the website demo switch platforms
  const vis = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const txt = (e) => (e.innerText || e.textContent || '').trim();
  const innermost = (els) => els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  const all = (s) => [...document.querySelectorAll(s)];
  const M = (role, el) => ({ role, text: txt(el) });

  // ---- how each platform's messages are found (several layouts, first one that matches wins) ----
  const FIND = {
    chatgpt() {
      let L = all('[data-content-search-unit-key]');                 // newer ChatGPT layout (key = turn:index:role)
      if (L.length) return { s: 'ChatGPT layout A', msgs: L.map((e) => M(/:user$/.test(e.getAttribute('data-content-search-unit-key')) ? 'You' : 'AI', e)) };
      L = all('[data-turn-key]');                                    // grouped layout: a user bubble + assistant blocks per turn
      if (L.length) { const out = []; L.forEach((t) => { const u = t.querySelector('[data-user-message-bubble]'); if (u) out.push(M('You', u)); t.querySelectorAll('[data-markdown-text-style="assistant-message"]').forEach((a) => out.push(M('AI', a))); }); if (out.length) return { s: 'ChatGPT layout B', msgs: out }; }
      L = all('[data-message-author-role]');                         // classic layout
      if (L.length) return { s: 'ChatGPT classic', msgs: L.map((e) => M(e.dataset.messageAuthorRole === 'user' ? 'You' : 'AI', e)) };
      L = all('article[data-testid^="conversation-turn"]');          // article layout (role from the hidden heading)
      if (L.length) return { s: 'ChatGPT articles', msgs: L.map((a) => { const h = a.querySelector('h5.sr-only, h6.sr-only'); return M(h && /^you/i.test(h.textContent.trim()) ? 'You' : 'AI', a); }) };
      return { s: 'none', msgs: [] };
    },
    claude() { return { s: 'Claude', msgs: innermost(all('[data-testid="user-message"], .font-claude-message, [data-is-streaming]')).map((e) => M(e.matches('[data-testid="user-message"]') ? 'You' : 'AI', e)) }; },
    gemini() { return { s: 'Gemini', msgs: all('user-query, model-response').map((e) => M(e.tagName === 'USER-QUERY' ? 'You' : 'AI', e)) }; },
    demo() { return { s: 'demo', msgs: all('#cm-demo-chat [data-role]').map((e) => M(e.dataset.role === 'user' ? 'You' : 'AI', e)) }; },
  };
  // ---- where text is inserted: first VISIBLE match (ChatGPT can keep a hidden textarea next to the real editor) ----
  const BOX = {
    chatgpt: ['div#prompt-textarea[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', '#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    claude: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]'],
    gemini: ['rich-textarea .ql-editor', 'div[contenteditable="true"]'],
    demo: ['#cm-demo-box'],
  };
  const findBox = () => { for (const s of BOX[site()]) { const el = all(s).find(vis); if (el) return el; } return null; };
  function insert(text) {
    const el = findBox(); if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const s = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, s) + text + el.value.slice(s);
      el.dispatchEvent(new Event('input', { bubbles: true })); return true;
    }
    if (!document.execCommand('insertText', false, text)) { el.textContent += text; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    return true;
  }
  const composerEmpty = () => { const el = findBox(); return !!el && !(el.value ?? el.innerText ?? '').trim(); };


  // ---- layout-independent capture: does not rely on ANY site class names / attributes ----
  // Finds the biggest visible scrolling/main region of the page (the conversation) and reads its text, minus our own UI and the input box.
  function genericText() {
    const bad = (e) => e === hostEl || hostEl.contains(e);
    const cands = [...document.querySelectorAll('main,[role="main"],[role="log"],div,section')].filter((e) => {
      if (bad(e) || !vis(e) || e.clientHeight < 150 || e.clientWidth < 280) return false;
      const t = e.tagName; if (t === 'MAIN' || e.getAttribute('role') === 'main' || e.getAttribute('role') === 'log') return true;
      const o = getComputedStyle(e).overflowY; return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 40;
    });
    let best = null, bl = 0;
    for (const e of cands) { const l = txt(e).length; if (l > bl) { bl = l; best = e; } }
    const root = best || document.querySelector('main') || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('textarea,input,button,nav,aside,script,style,noscript,[contenteditable="true"],[aria-hidden="true"],svg,[role="navigation"]').forEach((n) => n.remove());
    const raw = (root.innerText || '').trim();
    let t = (clone.innerText || clone.textContent || '').trim();
    if (t.length < raw.length * 0.4) t = raw; // detached clone lost layout; fall back to the live text
    return t.replace(/\n{3,}/g, '\n\n').slice(0, 200000);
  }
  function scan() {
    let x = { s: 'none', msgs: [] };
    try { x = FIND[site()](); } catch (e) {}
    const msgs = x.msgs.filter((t) => t.text), g = genericText();
    const total = msgs.reduce((a, m) => a + m.text.length, 0);
    // Structured (You/AI) result wins only when it clearly covers the conversation; otherwise the layout-independent text is used.
    if (msgs.length >= 2 && total >= g.length * 0.35) return { msgs, layout: x.s };
    if (!g.trim()) return { msgs, layout: x.s };
    return { msgs: [{ role: 'Chat', text: g }], layout: 'auto (works even if the site layout changed)' };
  }
  const cleanTitle = () => (document.title || '').replace(/\s*[-|\u2013]\s*(ChatGPT|Claude|Gemini|Google Gemini).*$/i, '').replace(/^(ChatGPT|Claude|Gemini)$/i, '').trim();

  // ---- highlight: remember the last selection (also snapshotted the instant you press the Memory tab) ----
  let lastSel = '';
  const snap = () => { const s = String(getSelection() || ''); if (s.trim()) lastSel = s; };
  ['selectionchange', 'mouseup', 'keyup', 'pointerup', 'contextmenu'].forEach((ev) => document.addEventListener(ev, snap, true));

  // ---- the circle (like Grammarly) + the iframe ----
  const hostEl = document.createElement('div'); hostEl.id = 'cm-host'; document.documentElement.appendChild(hostEl);
  const sh = hostEl.attachShadow({ mode: 'closed' });
  sh.innerHTML = `<style>
    #tab{position:fixed;right:18px;bottom:96px;width:50px;height:50px;z-index:2147483646;padding:0;border:1px solid #ffffff22;border-radius:50%;background:radial-gradient(circle at 30% 25%,#2b2b3a,#0b0b12 70%);color:#fff;cursor:pointer;display:grid;place-items:center;box-shadow:0 4px 16px #000a,0 0 0 2px #5b4bf588;touch-action:none;user-select:none}
    #tab:hover{box-shadow:0 4px 18px #000c,0 0 0 3px #8b7dff}
    #tab svg{width:26px;height:26px;pointer-events:none}
    #tab.glow{animation:g 1.6s ease-in-out infinite}@keyframes g{50%{box-shadow:0 0 0 7px #5b4bf544,0 0 20px #8b7dff}}
    iframe{position:fixed;right:0;top:4vh;width:380px;max-width:96vw;height:min(88vh,660px);border:1px solid #dfe1ea;border-radius:12px 0 0 12px;box-shadow:0 8px 30px #2a2f4a55;background:#fff;z-index:2147483647;color-scheme:light}
  </style><button id="tab" title="Chat Memory (click to open, drag to move)" aria-label="Chat Memory"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 0-4 12.7V18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 3z"/><path d="M9.5 21h5M10 9.5l2 2 2-2"/></svg></button><iframe title="Chat Memory" allow="clipboard-write" hidden></iframe>`;
  const f = sh.querySelector('iframe'), tab = sh.querySelector('#tab');
  let mounted = false;
  function toggle(open) {
    f.hidden = !open; if (!open) return; tab.classList.remove('glow');
    if (!mounted) { mounted = true; f.src = chrome.runtime.getURL('dock.html'); } else f.focus(); // focus event makes the dock refresh and focus its first field
  }
  // drag the circle anywhere; a click (no movement) opens the dock. Position is remembered.
  const POS = 'cm_pos'; let drag = null, moved = false;
  const place = (x, y) => { tab.style.right = 'auto'; tab.style.bottom = 'auto'; tab.style.left = Math.max(4, Math.min(innerWidth - 54, x)) + 'px'; tab.style.top = Math.max(4, Math.min(innerHeight - 54, y)) + 'px'; };
  try { chrome.storage.local.get(POS).then((r) => { const p = r && r[POS]; if (p) place(p.x * innerWidth, p.y * innerHeight); }); } catch (e) {}
  tab.addEventListener('pointerdown', (e) => { snap(); const r = tab.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY }; moved = false; tab.setPointerCapture(e.pointerId); }, true);
  tab.addEventListener('pointermove', (e) => { if (!drag) return; if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 5) moved = true; if (moved) place(e.clientX - drag.dx, e.clientY - drag.dy); });
  tab.addEventListener('pointerup', () => { if (drag && moved) { const r = tab.getBoundingClientRect(); try { chrome.storage.local.set({ [POS]: { x: r.left / innerWidth, y: r.top / innerHeight } }); } catch (e) {} } drag = null; });
  tab.addEventListener('mousedown', (e) => { snap(); e.preventDefault(); }); // keep the page's selection intact
  tab.onclick = () => { if (moved) { moved = false; return; } toggle(f.hidden); };

  // ---- requests from the dock (relayed by background.js) ----
  chrome.runtime.onMessage.addListener((m, _sender, send) => {
    if (!m || !m.cmpage) return;
    const a = m.args || {}; let r = {};
    try {
      if (m.op === 'scan') r = scan();
      else if (m.op === 'meta') r = { site: site(), title: cleanTitle(), host };
      else if (m.op === 'pageText') r = { text: ((document.querySelector('main') || document.body).innerText || '').slice(0, 60000) };
      else if (m.op === 'selection') { snap(); r = { text: lastSel }; }
      else if (m.op === 'insert') r = { done: insert(String(a.text || '')) };
      else if (m.op === 'close') toggle(false);
    } catch (e) { r = { error: String(e) }; }
    send(r);
  });
  setInterval(() => { tab.classList.toggle('glow', f.hidden && composerEmpty()); }, 3000);
})();
