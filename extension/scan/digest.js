// Builds a compressed structural digest of the page for the LLM site-adapter.
// Strips noise, keeps only stable attributes (no hashed class names), and collapses
// runs of same-shaped siblings so a repeating card pattern is obvious and small.
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  const SKIP = new Set([
    "SCRIPT", "STYLE", "SVG", "PATH", "NOSCRIPT", "HEAD", "LINK", "META", "IMG",
    "PICTURE", "BR", "HR", "CANVAS", "IFRAME", "TEMPLATE", "VIDEO", "AUDIO", "SOURCE",
  ]);
  // Only stable, semantic attributes — never the hashed class names.
  const KEEP_ATTRS = [
    "id", "role", "componentkey", "data-testid", "data-job-id",
    "data-occludable-job-id", "data-view-name", "aria-label", "href", "type",
  ];

  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();

  function directText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return collapse(t).slice(0, 48);
  }

  function attrStr(el) {
    const parts = [];
    for (const name of KEEP_ATTRS) {
      let v = el.getAttribute && el.getAttribute(name);
      if (v == null || v === "") continue;
      if (name === "href") {
        try {
          const u = new URL(v, location.href);
          v = u.pathname + (u.search ? u.search.slice(0, 40) : "");
        } catch {
          /* keep raw */
        }
      }
      v = collapse(String(v)).slice(0, 60);
      parts.push(`${name}="${v}"`);
    }
    return parts.length ? " " + parts.join(" ") : "";
  }

  // Signature groups same-shaped siblings (e.g. all cards share attr set); ignores
  // attribute VALUES so 25 cards with distinct componentkeys collapse into one group.
  function sig(el) {
    const names = [];
    for (const name of KEEP_ATTRS) {
      if (el.getAttribute && el.getAttribute(name) != null && el.getAttribute(name) !== "") {
        names.push(name);
      }
    }
    return el.tagName + "|" + names.join(",");
  }

  JCS.buildDigest = function (maxChars = 14000) {
    const out = [];
    let size = 0;
    const emit = (line, depth) => {
      const s = "  ".repeat(Math.min(depth, 20)) + line;
      out.push(s);
      size += s.length + 1;
    };

    function walk(el, depth) {
      if (size > maxChars) return;
      const kids = Array.from(el.children || []).filter((c) => !SKIP.has(c.tagName));
      let i = 0;
      while (i < kids.length) {
        if (size > maxChars) return;
        const s = sig(kids[i]);
        let j = i + 1;
        while (j < kids.length && sig(kids[j]) === s) j++;
        const groupCount = j - i;
        const emitCount = groupCount > 3 ? 2 : groupCount;
        for (let k = 0; k < emitCount; k++) {
          const node = kids[i + k];
          const tag = node.tagName.toLowerCase();
          emit(`<${tag}${attrStr(node)}> ${directText(node)}`.trimEnd(), depth);
          if (depth < 30) walk(node, depth + 1);
        }
        if (groupCount > emitCount) {
          const attrs = s.split("|")[1] || "";
          emit(`(x${groupCount - emitCount} more <${kids[i].tagName.toLowerCase()}> [${attrs}])`, depth);
        }
        i = j;
      }
    }

    if (document.body) walk(document.body, 0);
    return out.join("\n").slice(0, maxChars);
  };
})();
