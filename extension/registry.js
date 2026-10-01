// Shared globals for all content-script files (they run in the same isolated world,
// in manifest js[] order). Parsers register here; content.js consumes the registry.
//
// CRITICAL (§6.3, §15): the cardKey computed here MUST equal the dedup_key the backend
// stores (§12), or every card falsely shows "new" and masking is worthless.

(function () {
  const JC = (window.__JOBCAPTURE = window.__JOBCAPTURE || {});
  JC.parsers = JC.parsers || [];
  JC.register = (p) => JC.parsers.push(p);
  JC.pick = (url) => JC.parsers.find((p) => p.matches(url)) || null;

  // --- backend messaging (background owns all HTTP) ---
  JC.send = (type, payload) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (res) =>
        resolve(res ?? { ok: false, error: "no response" })
      );
    });

  // --- dedup key (mirrors backend src/dedup.ts) ---
  const norm = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
  JC.dedupKey = (job) => {
    if (job.externalId && String(job.externalId).trim() !== "") {
      return `${job.source}:${String(job.externalId).trim()}`;
    }
    const composite = `${norm(job.company)}|${norm(job.title)}|${norm(job.location)}`;
    return "fuzzy:" + sha1(composite);
  };

  // --- minimal synchronous SHA-1 (hex), matches Node crypto sha1 ---
  function sha1(msg) {
    function rotl(n, s) {
      return (n << s) | (n >>> (32 - s));
    }
    const bytes = unescape(encodeURIComponent(msg));
    const ml = bytes.length * 8;
    const words = [];
    for (let i = 0; i < bytes.length; i++) {
      words[i >> 2] |= bytes.charCodeAt(i) << (24 - (i % 4) * 8);
    }
    words[ml >> 5] |= 0x80 << (24 - (ml % 32));
    words[(((ml + 64) >> 9) << 4) + 15] = ml;

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Array(80);
    for (let i = 0; i < words.length; i += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[i + t] | 0;
      for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        let f, k;
        if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const tmp = (rotl(a, 5) + f + e + k + w[t]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const toHex = (n) => ("00000000" + (n >>> 0).toString(16)).slice(-8);
    return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
  }
  JC.sha1 = sha1;
})();
