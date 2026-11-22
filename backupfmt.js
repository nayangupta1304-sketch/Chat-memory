// Chat Memory - backup format sniffing, shared by the dock (to decide how to import a file) and background.js.
// A backup may arrive under ANY file name or extension and in any of these wrappers; the content decides, not the name:
//   1. JSON envelope       (.json / .cmbackup.json / anything)   {"app":"chat-memory","vault":{...}}
//   2. Armored text        (.txt)   the same envelope as base64 between -----BEGIN/END CHAT MEMORY BACKUP----- lines
//   3. Large binary stream (.cmbak) "CMBK1\n" + header + encrypted frames (any size, up to the 25 GB vault)
// Anything else is NOT a backup and the dock imports it as an ordinary file instead.
(function (g) {
  const MAGIC = 'CMBK1\n', dec = new TextDecoder('utf-8');
  const startsWith = (u, s) => { if (u.length < s.length) return false; for (let i = 0; i < s.length; i++) if (u[i] !== s.charCodeAt(i)) return false; return true; };
  function b64ToBytes(s) { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch (e) { return null; } }
  function tryJson(t) {
    t = t.replace(/^\uFEFF/, '').trim(); let o = null;
    try { o = JSON.parse(t); } catch (e) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) { try { o = JSON.parse(t.slice(a, b + 1)); } catch (e2) {} } }
    return o && typeof o === 'object' ? o : null;
  }
  // Returns { kind: 'json', env } | { kind: 'bin', header, dataStart } | { kind: 'bin-short' } | null
  function sniff(u8, depth) {
    depth = depth || 0;
    if (startsWith(u8, MAGIC)) {
      if (u8.length < 10) return { kind: 'bin-short' };
      const hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(6, false);
      if (hl > 65536) return null;
      if (10 + hl > u8.length) return { kind: 'bin-short' };
      let h; try { h = JSON.parse(dec.decode(u8.subarray(10, 10 + hl))); } catch (e) { return null; }
      return h && h.app === 'chat-memory' && h.kdf ? { kind: 'bin', header: h, dataStart: 10 + hl } : null;
    }
    if (u8.length > 80 * 1048576) return null;
    let t; try { t = dec.decode(u8); } catch (e) { return null; }
    const o = tryJson(t);
    if (o) return o.app === 'chat-memory' && o.vault && o.vault.kdf && o.vault.box ? { kind: 'json', env: o } : null;
    if (depth < 2) { // armored / plain base64 text
      const body = t.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
      if (body.length > 40 && /^[A-Za-z0-9+/]+=*$/.test(body)) { const b = b64ToBytes(body); if (b) return sniff(b, depth + 1); }
    }
    return null;
  }
  const api = { sniff, MAGIC, b64ToBytes };
  g.CMFMT = api; if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
