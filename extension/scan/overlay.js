// Scan progress overlay + per-card verdict painting.
(function () {
  const JCS = (window.__JCSCAN = window.__JCSCAN || {});

  const VERDICT_LABEL = { strong: "Strong fit", maybe: "Maybe", weak: "Weak fit", disqualified: "Skip" };
  const VERDICT_CLASS = {
    strong: "jc-v-strong",
    maybe: "jc-v-maybe",
    weak: "jc-v-weak",
    disqualified: "jc-v-disq",
  };

  let root = null;
  let label = null;
  let bar = null;
  let cancelled = false;

  const overlay = {
    mount(total) {
      cancelled = false;
      this.destroy();
      root = document.createElement("div");
      root.id = "jc-scan-overlay";
      root.innerHTML = `
        <div class="jc-scan-row">
          <span class="jc-scan-title">Scanning jobs</span>
          <span class="jc-scan-label">0 / ${total}</span>
          <button class="jc-scan-cancel" type="button">Cancel</button>
        </div>
        <div class="jc-scan-track"><div class="jc-scan-fill"></div></div>`;
      document.body.appendChild(root);
      label = root.querySelector(".jc-scan-label");
      bar = root.querySelector(".jc-scan-fill");
      root.querySelector(".jc-scan-cancel").addEventListener("click", () => {
        cancelled = true;
        if (label) label.textContent = "Cancelling…";
      });
    },
    setProgress(done, total) {
      if (label) label.textContent = `${done} / ${total}`;
      if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    },
    note(msg) {
      if (label) label.textContent = msg;
    },
    finish(summary) {
      if (!root) return;
      const row = root.querySelector(".jc-scan-row");
      if (row) {
        row.innerHTML = `<span class="jc-scan-title">Scan complete</span>
          <span class="jc-scan-label">${summary}</span>
          <button class="jc-scan-cancel" type="button">Close</button>`;
        row.querySelector(".jc-scan-cancel").addEventListener("click", () => overlay.destroy());
      }
      if (bar) bar.style.width = "100%";
    },
    isCancelled() {
      return cancelled;
    },
    destroy() {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
      label = null;
      bar = null;
    },
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  /** Colour a card and attach a score chip with a reason tooltip. */
  overlay.paintCard = function (card, result) {
    const el = card.el;
    if (!el) return;
    for (const c of Object.values(VERDICT_CLASS)) el.classList.remove(c);
    el.classList.add(VERDICT_CLASS[result.verdict] || "jc-v-maybe");
    el.classList.toggle("jc-scan-disq", result.verdict === "disqualified");
    el.dataset.jcVerdict = result.verdict;

    const pct = Math.round((result.score ?? 0) * 100);
    const tipParts = [];
    if (result.disqualifiers?.length) tipParts.push("Skip: " + result.disqualifiers.join("; "));
    if (result.reason) tipParts.push(result.reason);
    if (result.missingRequired?.length) tipParts.push("Missing: " + result.missingRequired.join(", "));
    const tip = tipParts.join("\n");

    let chip = el.querySelector(".jc-scan-chip");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "jc-scan-chip";
      const anchor = card.badgeAnchor || el.querySelector("h2, h3, a[href]") || el;
      anchor.appendChild(chip);
    }
    chip.classList.remove(...Object.values(VERDICT_CLASS));
    chip.classList.add(VERDICT_CLASS[result.verdict] || "jc-v-maybe");
    chip.textContent = `${VERDICT_LABEL[result.verdict] || "?"} ${pct}%`;
    chip.title = tip;
  };

  overlay.setHideDisqualified = function (hide) {
    document.body.classList.toggle("jc-hide-disq", !!hide);
  };

  JCS.overlay = overlay;
})();
