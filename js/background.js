// =======================================================================
// background.js – lightweight message handler
// -----------------------------------------------------------------------
// * Used to fetch the sender tabId (X composer tab) for the popup window.
// * Keeps the last tabId in-memory so other pages can ask for it.
// =======================================================================

let lastXTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "GET_TAB_ID") {
    const tabId = sender.tab?.id ?? null;
    if (tabId) lastXTabId = tabId;
    sendResponse({ tabId });
    return;
  }

  if (msg.type === "GET_LAST_X_TAB") {
    sendResponse({ tabId: lastXTabId });
  }
});
