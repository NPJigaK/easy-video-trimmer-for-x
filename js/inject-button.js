// ============================================================================
// inject-button.js – Adds a ✂︎ "動画をトリム" button to X (Twitter) composer
// ---------------------------------------------------------------------------
// Works as a *content‑script*: runs on every page that matches manifest rule.
// Key points
//   • Finds the media‑upload button → clones it so native CSS classes apply
//   • Swaps the SVG for a scissors‑in‑monitor glyph (24×24)
//   • On click: opens main.html in a centred popup window (800×700)
//   • Uses MutationObserver to cover dynamically regenerated toolbars
// ============================================================================
(() => {
  const BTN_ID = "easyVideoTrimmerBtn"; // unique data-testid
  const BLUE = "rgb(29, 155, 240)"; // official X brand blue

  // -------------------------------------------------------------------------
  // inject(toolbar) – idempotently inserts the new button into a given toolbar
  // -------------------------------------------------------------------------
  function inject(toolbar) {
    // Avoid duplicates (observer may fire multiple times)
    if (toolbar.querySelector(`[data-testid="${BTN_ID}"]`)) return;

    // Find the *media* button template: has a sibling <input type=file>
    const fileInput = toolbar.querySelector('input[type="file"]');
    const tmpl = fileInput
      ? fileInput
          .closest("div")
          .querySelector(
            'button[role="button"]:not([disabled]):not([aria-disabled="true"])'
          )
      : null;
    if (!tmpl) return; // composer not ready yet

    // ---- Duplicate & customise ------------------------------------------------
    const btn = tmpl.cloneNode(true);

    // A11y / state fixes
    btn.setAttribute("aria-label", "動画をトリム");
    btn.dataset.testid = BTN_ID;
    btn.removeAttribute("disabled");
    btn.setAttribute("aria-disabled", "false");
    btn.classList.remove("r-icoktb"); // semi‑transparent disabled style

    // Remove hidden <input type=file> the template contains (not needed here)
    btn.querySelectorAll("input").forEach((el) => el.remove());

    // ---- Swap icon: scissors‑inside‑monitor -----------------------------------
    const oldSvg = btn.querySelector("svg");
    oldSvg.outerHTML = `<!-- 24×24 icon (keeps parent CSS sizing) -->
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.5" y="1.5" width="21" height="21" rx="3.8" />
    <rect x="13" y="7.2" width="8.2" height="7.8" rx="1.4" fill="currentColor" stroke="none" />
    <polygon points="15.2 8.9 18.6 11 15.2 13.1" fill="#FFF" stroke="none" />
    <circle cx="6.8" cy="9.4"  r="2.3" />
    <circle cx="6.8" cy="15.8" r="2.3" />
    <path d="M9.2 9 L18 17.8" />
    <path d="M11.4 6.8 L9.4 9" />
    <path d="M13.2 13.4 L11.4 15.4" />
  </svg>`;

    // Tint entire icon to blue (same selector X uses)
    const labelDiv = btn.querySelector(".css-146c3p1");
    if (labelDiv) labelDiv.style.color = BLUE;

    // ---- Click handler: open trimming UI --------------------------------------
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const url = chrome.runtime.getURL("html/main.html");
      const { screenX: x, screenY: y } = e;
      window.open(
        url,
        "_blank",
        [
          "popup=yes",
          "resizable=yes",
          "scrollbars=yes",
          "width=800",
          "height=700",
          `left=${x - 300}`,
          `top=${y}`,
        ].join(",")
      );
    });

    // ---- Wrap with expected Twitter div hierarchy & append --------------------
    const outer = document.createElement("div");
    outer.className = "css-175oi2r r-14tvyh0 r-cpa5s6";
    outer.setAttribute("role", "presentation");

    const inner = document.createElement("div");
    inner.className = "css-175oi2r r-1pi2tsx r-1777fci";
    inner.appendChild(btn);
    outer.appendChild(inner);

    // X has two possible list containers depending on composer variant
    const list =
      toolbar.querySelector('[data-testid="ScrollSnap-List"]') ||
      toolbar.querySelector('[role="tablist"]') ||
      toolbar;
    list.appendChild(outer);
  }

  // ---------------------------------------------------------------------------
  // Initial injection + observe future composer instances (SPA navigation)
  // ---------------------------------------------------------------------------
  document.querySelectorAll('[data-testid="toolBar"]').forEach(inject);

  new MutationObserver(() =>
    document.querySelectorAll('[data-testid="toolBar"]').forEach(inject)
  ).observe(document.body, { childList: true, subtree: true });
})();
