// Chat Memory - shared password-strength rules. Loaded by dock.html (live checklist) AND background.js (enforced there too,
// so a tampered UI cannot create a weak vault).
(function (g) {
  const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon',
    'football', 'baseball', 'abc123', 'trustno1', 'sunshine', 'princess', 'login', 'master', 'hello', 'freedom', 'whatever',
    'chatmemory', 'chat memory', 'chatgpt', 'claude', 'gemini', 'hackify'];
  const SEQ = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const MIN = 12;

  function hasSequence(p) {
    const s = p.toLowerCase();
    for (const q of SEQ) for (let i = 0; i + 4 <= q.length; i++) {
      const part = q.slice(i, i + 4);
      if (s.includes(part) || s.includes(part.split('').reverse().join(''))) return true;
    }
    return false;
  }

  // Returns { ok, score (0-4), rules: [{ok, label}], missing: [text] }
  function check(pw) {
    pw = pw || '';
    const lower = pw.toLowerCase();
    const rules = [
      { ok: pw.length >= MIN, label: 'At least ' + MIN + ' characters', need: 'make it at least ' + MIN + ' characters long (now ' + pw.length + ')' },
      { ok: /[a-z]/.test(pw), label: 'A lowercase letter (a-z)', need: 'add a lowercase letter' },
      { ok: /[A-Z]/.test(pw), label: 'An uppercase letter (A-Z)', need: 'add an UPPERCASE letter' },
      { ok: /[0-9]/.test(pw), label: 'A number (0-9)', need: 'add a number' },
      { ok: /[^A-Za-z0-9\s]/.test(pw), label: 'A symbol (! @ # $ % & * ?)', need: 'add a symbol such as ! @ # $ % & * ?' },
      { ok: !/(.)\1\1/.test(pw), label: 'No character repeated 3 times in a row', need: 'remove characters repeated 3 times in a row (like "aaa")' },
      { ok: !hasSequence(pw), label: 'No easy sequences (1234, abcd, qwerty)', need: 'avoid easy sequences like 1234, abcd or qwerty' },
      { ok: !COMMON.some((w) => lower.includes(w.replace(/\s/g, ''))) && !COMMON.some((w) => lower.includes(w)), label: 'No common words (password, qwerty, ...)', need: 'avoid common words such as "password" or the app name' },
    ];
    const missing = rules.filter((r) => !r.ok).map((r) => r.need);
    const ok = missing.length === 0;
    let score = 0;
    if (pw.length) {
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
      score = ok ? (pw.length >= 16 && new Set(pw).size >= 10 ? 4 : 3) : (pw.length >= 8 && classes >= 3 ? 2 : 1);
    }
    return { ok, score, rules, missing, min: MIN };
  }

  // One readable sentence, e.g. "Not strong enough yet. Please: add an UPPERCASE letter, add a symbol ..."
  function explain(pw) {
    const r = check(pw);
    if (r.ok) return 'Strong password.';
    return 'This password is not strong enough. Please ' + r.missing.join('; ') + '.';
  }

  g.CMPW = { check, explain, MIN };
  if (typeof module !== 'undefined') module.exports = g.CMPW;
})(typeof self !== 'undefined' ? self : globalThis);
