// Phone apply driver — the iOS counterpart of applyEngine.js.
//
// NOT loaded by manifest.json. The backend concatenates applyAdapters.js +
// applyCore.js + an inlined payload + this file and serves the result from
// GET /apply/fill-script; an iOS Shortcut feeds it to Safari's "Run JavaScript
// on Web Page" action. It lives beside the extension's apply code so the fill
// logic has exactly one home (docs/phone-apply-design.md).
//
// Two constraints shape everything here, both consequences of running as page
// JavaScript rather than as an extension:
//
//   • No backend I/O. The ATS page's connect-src blocks our host, so profile,
//     cover letter and résumé bytes must arrive pre-inlined in the payload.
//   • No recording. The submit watcher can see the confirmation but cannot POST
//     it, so the status bar offers a deep link back into the dashboard and the
//     human taps it. (Two taps beats "wait until you're at a laptop".)
//
// The HARD BOUNDARY is unchanged: no Submit click, no EEO/self-identification
// questions, no guessed salary/authorization/demographic answers.
(function (root) {
  "use strict";

  const core = root.JC_APPLY_CORE;
  const DRIVER_BUILD = "m1";

  // ---- status sheet ---------------------------------------------------------
  // Bottom sheet rather than the desktop corner bar: on a phone the bottom edge
  // is the only place guaranteed not to sit under the ATS's own sticky header,
  // and it is inside thumb reach. Shadow root for the same reason as desktop —
  // ATS stylesheets otherwise bleed in and garble it.
  function createSheet() {
    const host = document.createElement("div");
    host.id = "jh-fill-sheet";
    host.style.cssText =
      "all:initial;display:block;position:fixed;left:0;right:0;bottom:0;z-index:2147483647";
    const shadow = host.attachShadow({ mode: "open" });
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "background:#1f2328;color:#e6edf3;padding:12px 14px calc(12px + env(safe-area-inset-bottom));" +
      "font:15px/1.45 -apple-system,system-ui,sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,.45);" +
      "border-top:1px solid #30363d;max-height:45vh;overflow:auto";
    const statusEl = document.createElement("div");
    const listEl = document.createElement("div");
    listEl.style.cssText = "margin-top:8px;font-size:13.5px;color:#adbac7";
    const actionsEl = document.createElement("div");
    actionsEl.style.cssText = "margin-top:10px;display:flex;gap:8px;flex-wrap:wrap";
    wrap.append(statusEl, listEl, actionsEl);
    shadow.append(wrap);
    const mount = () => {
      if (!host.isConnected && document.body) document.body.appendChild(host);
    };
    mount();
    return {
      status(html) {
        statusEl.innerHTML = `<b>Apply assist</b> · ${DRIVER_BUILD} — ${html}`;
        mount();
      },
      list(html) {
        listEl.innerHTML = html;
      },
      /** 44px minimum height — Apple's touch-target floor. */
      action(label, onTap, href) {
        const b = document.createElement(href ? "a" : "button");
        if (href) {
          b.href = href;
          b.style.textDecoration = "none";
        }
        b.textContent = label;
        b.style.cssText +=
          ";background:#30363d;color:#e6edf3;border:1px solid #484f58;border-radius:8px;" +
          "padding:11px 14px;min-height:44px;font:14px system-ui;display:inline-flex;" +
          "align-items:center;cursor:pointer";
        if (onTap) b.addEventListener("click", onTap);
        actionsEl.append(b);
        return b;
      },
      remove: () => host.remove(),
    };
  }

  /**
   * Scroll an unanswered control into the middle of the viewport and flash it.
   * On a phone "the highlighted fields" is useless advice — the human cannot
   * see them — so the sheet walks them one tap at a time instead.
   */
  function focusControl(el) {
    if (!el || !el.isConnected) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const prev = el.style.boxShadow;
    el.style.boxShadow = "0 0 0 3px #f0883e";
    setTimeout(() => {
      el.style.boxShadow = prev;
    }, 1600);
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function run(payload) {
    const p = payload || {};
    const adapter = (root.JC_APPLY_ADAPTERS || {})[location.host];
    if (!core) return "apply core missing — reinstall the shortcut";

    const sheet = createSheet();

    const mountHelper = () => {
      if (!root.JC_APPLY_ASSIST) return;
      root.JC_APPLY_ASSIST.mount({
        fields: p.fields || { answers: {} },
        jobId: p.jobId || null,
        title: p.title || null,
        company: p.company || null,
        resumeReady: !!(p.resumeBase64 || p.resumeUrl),
        resumeBase64: p.resumeBase64 || null,
        resumeFilename: "resume.pdf",
      });
    };

    if (!adapter) {
      mountHelper();
      sheet.status(
        "this site has no full auto-fill — tap a field for presets, tap Upload for your résumé. Login and Next are yours. You tap Submit."
      );
      if (p.resumeUrl) sheet.action("⤓ Résumé PDF", null, p.resumeUrl);
      if (p.recordUrl) sheet.action("✓ I submitted", null, p.recordUrl);
      sheet.action("×", () => sheet.remove());
      return "field helper only — no adapter for " + location.host;
    }
    sheet.status("waiting for the form to settle…");
    if (document.readyState !== "complete") {
      await new Promise((r) => root.addEventListener("load", r, { once: true }));
    }
    await core.quietDom(1000, 12000);

    let form = await core.waitFor(() => document.querySelector(adapter.formSelector), 5000);
    if (!form && adapter.applicationSuffix && !location.pathname.endsWith(adapter.applicationSuffix)) {
      // Desktop navigates here and re-runs via the content script. On the phone
      // the injected context dies with the navigation, so hand it back to the
      // human with the one instruction that works.
      sheet.status("this is the posting page — opening the application form. Run the shortcut again there.");
      sheet.action("Open the form ▸", null, location.pathname.replace(/\/$/, "") + adapter.applicationSuffix);
      return "opened the application form — run the shortcut again";
    }
    if (!form) {
      mountHelper();
      sheet.status("couldn't find the application form — tap a field for presets, tap Upload for the résumé, then record from the dashboard.");
      if (p.recordUrl) sheet.action("✓ I submitted", null, p.recordUrl);
      return "no form found";
    }

    // Résumé first: the upload re-renders the form on Ashby and wipes anything
    // filled beforehand (same ordering as desktop, same reason).
    sheet.status("attaching your tailored résumé…");
    const resumeState = await core.attachResume(adapter, p.resumeBase64 || null, 1800);

    sheet.status("filling the application…");
    // Slower than desktop across the board: phone CPUs re-render React forms
    // lazily and geo-suggest lookups run over the cellular link.
    const filler = core.createFiller(adapter, p.fields || { answers: {} }, {
      timing: { settle: 450, poll: 650, commit: 600 },
    });
    let unanswered = await filler.pass();

    let drafted = 0;
    if (p.coverLetter && core.freeTextBoxes(adapter).length) {
      drafted = core.draftFreeText(adapter, p.coverLetter, { engineFilled: filler.engineFilled });
    }

    sheet.status("verifying…");
    await core.sleep(900);
    unanswered = await filler.pass();

    // ---- hand off to the human ----------------------------------------------
    const labels = [...new Set(unanswered.map((u) => u.label))];
    const resumeNote =
      resumeState === "injected"
        ? "résumé attached"
        : resumeState === "already"
          ? "résumé already attached"
          : resumeState === "none"
            ? "no upload field on this form"
            : "⚠️ couldn't attach the résumé — tap Choose File and pick it from " +
              "Files ▸ JobHunt (the shortcut saved it there)";
    sheet.status(
      `<b>your turn.</b> ${escapeHtml(resumeNote)}` +
        (drafted ? ` · ${drafted} draft answer(s) to proofread` : "") +
        (labels.length ? ` · ${labels.length} question(s) left` : " · every field I could fill is filled") +
        ". EEO/demographics are yours by design. Review, then tap the form's own Submit."
    );
    if (labels.length) {
      sheet.list(labels.slice(0, 6).map((l) => `• ${escapeHtml(l)}`).join("<br>"));
      let i = 0;
      sheet.action("Next unanswered ▾", () => {
        focusControl(unanswered[i % unanswered.length].el);
        i++;
      });
    }
    if (p.resumeUrl && resumeState !== "injected" && resumeState !== "already") {
      sheet.action("⤓ Résumé PDF", null, p.resumeUrl);
    }
    if (p.recordUrl) sheet.action("✓ I submitted", null, p.recordUrl);
    sheet.action("×", () => sheet.remove());
    mountHelper();

    return [
      `résumé: ${resumeState}`,
      drafted ? `${drafted} drafted` : null,
      labels.length ? `${labels.length} unanswered: ${labels.slice(0, 3).join("; ")}` : "all fields filled",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  root.JC_APPLY_MOBILE = { run, DRIVER_BUILD };
})(typeof window !== "undefined" ? window : globalThis);
