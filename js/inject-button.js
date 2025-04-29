/**
 * inject-button.js – X ポスト欄に “動画トリム” ボタンを追加（CSS 共通版）
 */
(() => {
  const BTN_ID = "easyVideoTrimmerBtn";
  const BLUE = "rgb(29, 155, 240)"; // X アイコン共通色

  /** ツールバーに 1 つだけ追加 */
  function inject(toolbar) {
    if (toolbar.querySelector(`[data-testid="${BTN_ID}"]`)) return;

    // 画像・動画ボタン（＝隣に <input type="file"> があるボタン）を取得
    const fileInput = toolbar.querySelector('input[type="file"]');
    const tmpl = fileInput
      ? fileInput
          .closest("div")
          .querySelector(
            'button[role="button"]:not([disabled]):not([aria-disabled="true"])'
          )
      : null;

    if (!tmpl) return; // 見つからない場合はスキップ

    /* ── ボタンを複製 ── */
    const btn = tmpl.cloneNode(true);

    // ---------- 属性・クラス調整 ----------
    btn.setAttribute("aria-label", "動画をトリム");
    btn.dataset.testid = BTN_ID;
    btn.removeAttribute("disabled");
    btn.setAttribute("aria-disabled", "false");
    btn.classList.remove("r-icoktb"); // 無効化時に付く半透明クラス

    // テンプレートに含まれる <input type="file"> などは不要
    btn.querySelectorAll("input").forEach((el) => el.remove());

    /* ── SVG をハサミに差し替え ── */
    const oldSvg = btn.querySelector("svg");
    oldSvg.outerHTML = `
    <svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"           
  stroke-width="1.7"
  stroke-linecap="round"
  stroke-linejoin="round"
>

  <!-- 外枠（ラウンド角） -->
  <rect x="1.5" y="1.5" width="21" height="21" rx="3.8" />

  <!-- ビデオフレーム（塗りつぶし） -->
  <rect x="13" y="7.2" width="8.2" height="7.8" rx="1.4" fill="currentColor" stroke="none" />

  <!-- 再生ボタン（白） -->
  <polygon points="15.2 8.9 18.6 11 15.2 13.1" fill="#FFFFFF" stroke="none" />

  <!-- ハサミ：円２個＋刃３本 -->
  <!-- 上リング -->
  <circle cx="6.8" cy="9.4"  r="2.3" />
  <!-- 下リング -->
  <circle cx="6.8" cy="15.8" r="2.3" />
  <!-- 交差する刃 -->
  <path d="M9.2 9 L18 17.8" />
  <!-- 刃先１ -->
  <path d="M11.4 6.8 L9.4 9" />
  <!-- 刃先２ -->
  <path d="M13.2 13.4 L11.4 15.4" />

</svg>
    `;

    /* ── アイコン全体を青に ── */
    const labelDiv = btn.querySelector(".css-146c3p1");
    if (labelDiv) labelDiv.style.color = BLUE;

    /* ── クリックで独立ウィンドウ ── */
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

    /* ── ラッパー <div> を作って末尾に追加 ── */
    // const wrapper = document.createElement("div");
    // wrapper.className = "css-175oi2r r-14tvyh0 r-cpa5s6"; // 既存と同じ
    // wrapper.setAttribute("role", "presentation");
    // wrapper.appendChild(btn);

    const outer = document.createElement("div");
    outer.className = "css-175oi2r r-14tvyh0 r-cpa5s6";
    outer.setAttribute("role", "presentation");

    const inner = document.createElement("div");
    inner.className = "css-175oi2r r-1pi2tsx r-1777fci";
    inner.appendChild(btn);
    outer.appendChild(inner);

    const list =
      toolbar.querySelector('[data-testid="ScrollSnap-List"]') ||
      toolbar.querySelector('[role="tablist"]') ||
      toolbar;
    list.appendChild(outer);
  }

  /* 既存ツールバーへ注入 */
  document.querySelectorAll('[data-testid="toolBar"]').forEach(inject);

  /* 動的に生成されるツールバーも監視して注入 */
  new MutationObserver(() =>
    document.querySelectorAll('[data-testid="toolBar"]').forEach(inject)
  ).observe(document.body, { childList: true, subtree: true });
})();
