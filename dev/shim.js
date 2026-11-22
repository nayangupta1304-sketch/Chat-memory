// Minimal chrome.* stand-in so the REAL background.js + content.js can run in a normal web page (prototype) or Node (tests).
(function (g) {
  const L = [], mem = { local: {}, session: {} };
  const ls = (() => { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return localStorage; } catch (e) { return null; } })();
  const be = {
    local: { get: (k) => { try { const v = ls.getItem('cmdemo_' + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return mem.local[k]; } },
             set: (k, v) => { try { ls.setItem('cmdemo_' + k, JSON.stringify(v)); } catch (e) { mem.local[k] = v; } },
             del: (k) => { try { ls.removeItem('cmdemo_' + k); } catch (e) { delete mem.local[k]; } } },
    session: { get: (k) => mem.session[k], set: (k, v) => { mem.session[k] = v; }, del: (k) => { delete mem.session[k]; } },
  };
  const area = (n) => ({
    async get(keys) { if (keys == null) { const all = {}; if (n === 'local' && !ls) Object.assign(all, JSON.parse(JSON.stringify(mem.local))); return all; } const ks = [].concat(keys), o = {}; ks.forEach((k) => { const v = be[n].get(k); if (v !== undefined) o[k] = v; }); return o; },
    async set(obj) { const ch = {}; for (const k in obj) { ch[k] = { newValue: obj[k] }; be[n].set(k, obj[k]); } L.forEach((f) => f(ch, n)); },
    async remove(k) { [].concat(k).forEach((x) => be[n].del(x)); },
    async setAccessLevel() {},
  });
  const timers = {}, alarmL = [], idleL = [], msgL = [];
  g.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (f) => L.push(f) } },
    alarms: {
      async create(name, o) { clearTimeout(timers[name]); timers[name] = setTimeout(() => alarmL.forEach((f) => f({ name })), o.delayInMinutes * 60000); },
      async clear(name) { clearTimeout(timers[name]); return true; },
      onAlarm: { addListener: (f) => alarmL.push(f) },
    },
    idle: { setDetectionInterval() {}, onStateChanged: { addListener: (f) => idleL.push(f) } },
    runtime: {
      onMessage: { addListener: (f) => msgL.push(f) },
      sendMessage: (msg) => new Promise((res) => {
        const m = JSON.parse(JSON.stringify(msg)); let used = false;
        const send = (r) => { if (!used) { used = true; res(JSON.parse(JSON.stringify(r))); } };
        for (const f of msgL) if (f(m, {}, send) === true) return;
        res(undefined);
      }),
    },
    __idle: (s) => idleL.forEach((f) => f(s)), __wipe: () => { mem.local = {}; mem.session = {}; if (ls) Object.keys(ls).filter((k) => k.startsWith('cmdemo_')).forEach((k) => ls.removeItem(k)); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
