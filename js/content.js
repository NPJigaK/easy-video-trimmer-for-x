// ============================================================================
// content.js – UI logic & timeline interaction for the trimming window
// ----------------------------------------------------------------------------
// Temp.html-style editing UI, existing file-pick flow + encoding pipeline kept.
// ============================================================================

const preContainer = document.getElementById("pre-extension-container");
const mainContainer = document.getElementById("main-extension-container");
const dropArea = document.getElementById("dropArea");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const statusBox = document.getElementById("status-box");
const logRangeBtn = document.getElementById("log-range-btn");

const supportsWebCodecs =
  typeof isWebCodecsAvailable !== "undefined" ? isWebCodecsAvailable : false;

let selectedFile = null;
let currentObjectUrl = null;

// ─────────────────────────────────────────────────────────────────────────────
// X.com composer helpers (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
const composerTabIdFromQuery = (() => {
  const raw = new URLSearchParams(window.location.search).get("tabId");
  const num = raw ? Number(raw) : NaN;
  return Number.isFinite(num) ? num : null;
})();

function getLastKnownTabId() {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendMessage) return resolve(null);
    chrome.runtime.sendMessage({ type: "GET_LAST_X_TAB" }, (res) => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to fetch last tab id", chrome.runtime.lastError);
        return resolve(null);
      }
      resolve(res?.tabId ?? null);
    });
  });
}

async function resolveComposerTabId() {
  if (composerTabIdFromQuery) return composerTabIdFromQuery;
  return getLastKnownTabId();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = reader.result;
      if (typeof res === "string") {
        const comma = res.indexOf(",");
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      } else {
        reject(new Error("Unexpected FileReader result type"));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Inject into MAIN world on X.com and attach the provided blob as if user uploaded.
async function attachClipToComposer(blob, fileName, mimeType = "video/mp4") {
  const tabId = await resolveComposerTabId();
  if (!tabId) throw new Error("X.com composer tab was not found.");
  const base64 = await blobToBase64(blob);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [base64, fileName, mimeType],
    func: (b64, name, type) => {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const blobInside = new Blob([bytes], { type });
      const file = new File([blobInside], name, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const tweetInput =
        document.querySelector('input[data-testid="fileInput"]') ||
        document.querySelector('input[type="file"][accept*="video"]');
      if (!tweetInput) {
        return { attached: false, reason: "Tweet file input not found" };
      }
      tweetInput.files = dt.files;
      tweetInput.dispatchEvent(new Event("change", { bubbles: true }));
      tweetInput.dispatchEvent(new Event("input", { bubbles: true }));
      return { attached: true, size: file.size };
    },
  });

  if (!result?.result?.attached) {
    throw new Error(
      result?.result?.reason || "Page-side attach failed unexpectedly."
    );
  }
  return result.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline state (temp.html port)
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  defaultClipLength: 30,
  minClipLength: 1,
  maxClipLength: 139,
  autoScrollPadding: 0.12,
  frameStep: 1 / 30,
};
const INITIAL_VIEW_DIVISOR = 10;
const TICK_SPACING_OPTIONS = [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600, 900, 1800];
const OVERVIEW_MIN_WIDTH = 24;
const PREVIEW_SEEK_THRESHOLD = 0.15;
const PREVIEW_DRAW_TOLERANCE = 0.3;
const DEBUG_PREVIEW = false;

const timelineState = {
  totalDuration: 0,
  viewStart: 0,
  viewEnd: 0,
  cursorTime: 0,
  isPlaying: false,
};
const clipState = { isActive: false, clipStart: 0, clipEnd: 0 };

const effectiveMinClipLength = () =>
  Math.min(CONFIG.minClipLength, timelineState.totalDuration || CONFIG.minClipLength);
const effectiveMaxClipLength = () =>
  Math.min(CONFIG.maxClipLength, timelineState.totalDuration || CONFIG.maxClipLength);

const els = {};
let dragMode = null; // 'scrub' | 'handle-start' | 'handle-end' | 'pan' | 'clip-move'
const overviewDrag = { active: false, offset: 0, span: 0 };
let pendingHoverTime = null;
let previewReady = false;
let lastRequestedTime = null;
let rafPending = false;
const clipMove = { active: false, startX: 0, origStart: 0, origEnd: 0 };
const dragState = { lastX: 0 };
const debugLog = (...args) => {
  if (DEBUG_PREVIEW) console.debug("[preview]", ...args);
};

function $(id) {
  return document.getElementById(id);
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const formatTime = (sec) => {
  if (!isFinite(sec)) return "0:00.00";
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s - h * 3600 - m * 60;
  const secStr = r.toFixed(2).padStart(5, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${secStr}` : `${m}:${secStr}`;
};
const hoverCtx = () =>
  els.hoverPreviewCanvas ? els.hoverPreviewCanvas.getContext("2d") : null;

// -------- Mapping helpers ---------
function timeToX(time) {
  const rect = els.timeline.getBoundingClientRect();
  const width = rect.width || 1;
  const span = timelineState.viewEnd - timelineState.viewStart || 1;
  return ((time - timelineState.viewStart) / span) * width;
}

function xToTime(x) {
  const rect = els.timeline.getBoundingClientRect();
  const width = rect.width || 1;
  const span = timelineState.viewEnd - timelineState.viewStart || 1;
  const t = timelineState.viewStart + (x / width) * span;
  return clamp(t, 0, timelineState.totalDuration);
}

function setCursorTime(time, syncVideo = true) {
  timelineState.cursorTime = clamp(time, 0, timelineState.totalDuration);
  if (syncVideo && els.video) els.video.currentTime = timelineState.cursorTime;
  render();
}

function updateDuration() {
  timelineState.totalDuration = els.video?.duration || 0;
  const full = timelineState.totalDuration;
  const span =
    full <= CONFIG.defaultClipLength
      ? full || CONFIG.defaultClipLength
      : Math.max(1, full / INITIAL_VIEW_DIVISOR);
  timelineState.viewStart = 0;
  timelineState.viewEnd = full ? Math.min(full, span) : span;
  timelineState.cursorTime = 0;
  clipState.isActive = false;
  clipState.clipStart = 0;
  clipState.clipEnd = 0;
  syncPreviewSource(els.video?.currentSrc || els.video?.src);
  render();
}

function loadVideoFile(file) {
  if (!file || !els.video) return;
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);
  els.video.pause();
  timelineState.isPlaying = false;
  clipState.isActive = false;
  els.video.src = currentObjectUrl;
  els.video.load();
  timelineState.cursorTime = 0;
  syncPreviewSource(currentObjectUrl);
  render();
}

function playPause() {
  if (!els.video) return;
  els.video.paused ? els.video.play() : els.video.pause();
}

function jumpRelative(seconds) {
  setCursorTime(timelineState.cursorTime + seconds);
  ensureCursorVisible();
}

function stepFrame(direction) {
  const step = CONFIG.frameStep || 1 / 30;
  setCursorTime(timelineState.cursorTime + direction * step);
  ensureCursorVisible();
}

// -------- Clip logic ---------
function createClip() {
  const start = timelineState.cursorTime;
  const minLen = effectiveMinClipLength();
  const maxLen = effectiveMaxClipLength();
  const targetLen = Math.min(CONFIG.defaultClipLength, maxLen);
  const end = Math.min(start + targetLen, timelineState.totalDuration);
  clipState.isActive = true;
  clipState.clipStart = clamp(
    start,
    0,
    Math.max(0, timelineState.totalDuration - minLen)
  );
  clipState.clipEnd = clamp(
    end,
    clipState.clipStart + minLen,
    Math.min(timelineState.totalDuration, clipState.clipStart + maxLen)
  );
  timelineState.isPlaying = false;
  els.video?.pause();
  // maybeRevealRange(clipState.clipStart, clipState.clipEnd);
  render();
}

// We need to check whether this feature is actually necessary, so we won’t be using it for now.
function maybeRevealRange(start, end) {
  const viewSpan = timelineState.viewEnd - timelineState.viewStart;
  const pad = viewSpan * 0.1;
  if (start < timelineState.viewStart + pad || end > timelineState.viewEnd - pad) {
    zoomToRange(start, end);
  }
}

function cancelClip() {
  clipState.isActive = false;
  render();
}

// -------- Zoom & pan ---------
function zoomTimeline(centerTime, zoomFactor) {
  const currentRange = timelineState.viewEnd - timelineState.viewStart;
  let newRange = currentRange / zoomFactor;
  const minRange = 1;
  const maxRange = timelineState.totalDuration || minRange;
  newRange = clamp(newRange, minRange, maxRange);
  let newStart = centerTime - newRange / 2;
  let newEnd = centerTime + newRange / 2;
  if (newStart < 0) {
    newStart = 0;
    newEnd = newRange;
  }
  if (newEnd > timelineState.totalDuration) {
    newEnd = timelineState.totalDuration;
    newStart = timelineState.totalDuration - newRange;
    if (newStart < 0) newStart = 0;
  }
  timelineState.viewStart = newStart;
  timelineState.viewEnd = newEnd;
  render();
}

function zoomToRange(start, end) {
  const center = (start + end) / 2;
  const range = Math.max(end - start, 1);
  const padding = range * 0.2;
  zoomTimeline(center, (timelineState.viewEnd - timelineState.viewStart) / (range + padding));
}

function panTimeline(deltaSeconds) {
  const span = timelineState.viewEnd - timelineState.viewStart;
  let newStart = timelineState.viewStart + deltaSeconds;
  let newEnd = timelineState.viewEnd + deltaSeconds;
  if (newStart < 0) {
    newStart = 0;
    newEnd = span;
  }
  if (newEnd > timelineState.totalDuration) {
    newEnd = timelineState.totalDuration;
    newStart = timelineState.totalDuration - span;
    if (newStart < 0) newStart = 0;
  }
  timelineState.viewStart = newStart;
  timelineState.viewEnd = newEnd;
  render();
}

// -------- Ticks & markers ---------
function chooseTickSpacing() {
  const span = timelineState.viewEnd - timelineState.viewStart;
  let chosen = TICK_SPACING_OPTIONS[0];
  for (const opt of TICK_SPACING_OPTIONS) {
    if (span / opt <= 12) {
      chosen = opt;
      break;
    }
  }
  return chosen;
}

function renderTicks() {
  if (!els.tickStrip) return;
  const container = els.tickStrip;
  container.innerHTML = "";
  const major = chooseTickSpacing();
  const minor = major / 5;
  const fragment = document.createDocumentFragment();
  const start = Math.floor(timelineState.viewStart / minor) * minor;
  const end = timelineState.viewEnd;
  for (let t = start; t <= end; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    if (!isMajor && t % major !== 0 && minor < 0.2) continue;
    const el = document.createElement("div");
    el.className = `tick ${isMajor ? "major" : "minor"}`;
    el.style.left = `${timeToX(t)}px`;
    if (isMajor) {
      const label = document.createElement("span");
      label.textContent = formatTime(t);
      el.appendChild(label);
    }
    fragment.appendChild(el);
  }
  container.appendChild(fragment);
}

// -------- Renderers ---------
function renderClip() {
  const active = clipState.isActive;
  if (els.clipHighlight) els.clipHighlight.style.display = active ? "block" : "none";
  if (els.clipHandleStart) els.clipHandleStart.style.display = active ? "block" : "none";
  if (els.clipHandleEnd) els.clipHandleEnd.style.display = active ? "block" : "none";
  if (els.playFromClipBtn) els.playFromClipBtn.disabled = !active;
  if (els.attachBtn) els.attachBtn.disabled = !active || !selectedFile;
  if (els.clipBtn) els.clipBtn.textContent = active ? "Cancel Clip" : "✂ Clip";
  if (!active) {
    if (els.clipLabel) els.clipLabel.textContent = "Clip inactive";
    return;
  }
  const left = timeToX(clipState.clipStart);
  const right = timeToX(clipState.clipEnd);
  const width = Math.max(2, right - left);
  if (els.clipHighlight) {
    els.clipHighlight.style.transform = `translateX(${left}px)`;
    els.clipHighlight.style.width = `${width}px`;
  }
  if (els.clipHandleStart) els.clipHandleStart.style.left = `${left}px`;
  if (els.clipHandleEnd) els.clipHandleEnd.style.left = `${right}px`;
  const duration = clipState.clipEnd - clipState.clipStart;
  if (els.clipLabel) {
    els.clipLabel.textContent = `Clip: ${formatTime(
      clipState.clipStart
    )} – ${formatTime(clipState.clipEnd)} (${duration.toFixed(2)} sec)`;
  }
}

function renderPlayhead() {
  if (!els.playhead || !els.timeline) return;
  const x = timeToX(timelineState.cursorTime);
  els.playhead.style.transform = `translateX(${x - 1}px)`;
  els.timeline.setAttribute("aria-valuenow", timelineState.cursorTime.toFixed(2));
  els.timeline.setAttribute("aria-valuetext", formatTime(timelineState.cursorTime));
  els.timeline.setAttribute("aria-valuemax", timelineState.totalDuration.toFixed(2));
  const span = timelineState.viewEnd - timelineState.viewStart || 1;
  const pct = clamp(
    ((timelineState.cursorTime - timelineState.viewStart) / span) * 100,
    0,
    100
  );
  els.timeline.style.setProperty("--past-pct", `${pct}%`);
}

function renderTimeLabel() {
  const text = `${formatTime(timelineState.cursorTime)} / ${formatTime(
    timelineState.totalDuration
  )}`;
  if (els.timeReadout) els.timeReadout.textContent = text;
  if (els.playPauseCenterBtn) {
    const playSymbol = timelineState.isPlaying ? "||" : ">";
    els.playPauseCenterBtn.textContent = playSymbol;
  }
}

function renderOverview() {
  if (!els.overview || !els.overviewThumb) return;
  const rect = els.overview.getBoundingClientRect();
  const width = rect.width || 1;
  const total = timelineState.totalDuration || 1;
  const span = Math.max(0.001, timelineState.viewEnd - timelineState.viewStart);
  let left = (timelineState.viewStart / total) * width;
  let thumbWidth = (span / total) * width;
  const minWidth = OVERVIEW_MIN_WIDTH;
  if (thumbWidth < minWidth) thumbWidth = minWidth;
  if (left + thumbWidth > width) left = width - thumbWidth;
  if (left < 0) left = 0;
  els.overviewThumb.style.width = `${thumbWidth}px`;
  els.overviewThumb.style.transform = `translateX(${left}px)`;

  if (els.overviewPlayhead) {
    const playX = clamp((timelineState.cursorTime / total) * width, 0, width);
    els.overviewPlayhead.style.transform = `translateX(${playX - 4}px)`;
    els.overviewPlayhead.style.display = total > 0 ? "block" : "none";
  }
}

function ensureCursorVisible() {
  const span = timelineState.viewEnd - timelineState.viewStart;
  const pad = span * CONFIG.autoScrollPadding;
  if (timelineState.cursorTime < timelineState.viewStart + pad) {
    panTimeline(timelineState.cursorTime - (timelineState.viewStart + pad));
  } else if (timelineState.cursorTime > timelineState.viewEnd - pad) {
    panTimeline(timelineState.cursorTime - (timelineState.viewEnd - pad));
  }
}

function render() {
  renderTicks();
  renderClip();
  renderPlayhead();
  renderOverview();
  renderTimeLabel();
}

// -------- Interaction handlers ---------
function onTimelineMouseDown(e) {
  if (e.button === 1) {
    startPan(e);
    return;
  }
  startScrub(e);
}

function startScrub(e) {
  dragMode = "scrub";
  els.video?.pause();
  timelineState.isPlaying = false;
  handleScrub(e);
  window.addEventListener("mousemove", handleScrub);
  window.addEventListener("mouseup", endDrag);
}

function handleScrub(e) {
  if (dragMode !== "scrub") return;
  const rect = els.timeline.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  setCursorTime(xToTime(x));
}

function startResize(side, e) {
  if (!clipState.isActive) return;
  dragMode = side === "start" ? "handle-start" : "handle-end";
  els.video?.pause();
  timelineState.isPlaying = false;
  window.addEventListener("mousemove", handleResize);
  window.addEventListener("mouseup", endDrag);
  e.stopPropagation();
  e.preventDefault();
}

function handleResize(e) {
  if (dragMode !== "handle-start" && dragMode !== "handle-end") return;
  const rect = els.timeline.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const t = xToTime(x);
  const minLen = effectiveMinClipLength();
  const maxLen = effectiveMaxClipLength();
  if (dragMode === "handle-start") {
    const newStart = clamp(
      t,
      Math.max(0, clipState.clipEnd - maxLen),
      Math.max(0, clipState.clipEnd - minLen)
    );
    clipState.clipStart = newStart;
    setCursorTime(newStart, true);
  } else {
    const newEnd = clamp(
      t,
      clipState.clipStart + minLen,
      Math.min(timelineState.totalDuration, clipState.clipStart + maxLen)
    );
    clipState.clipEnd = newEnd;
    setCursorTime(newEnd, true);
  }
  render();
}

function startClipMove(e) {
  if (!clipState.isActive) return;
  dragMode = "clip-move";
  clipMove.active = true;
  clipMove.startX = e.clientX;
  clipMove.origStart = clipState.clipStart;
  clipMove.origEnd = clipState.clipEnd;
  els.video?.pause();
  timelineState.isPlaying = false;
  window.addEventListener("mousemove", handleClipMove);
  window.addEventListener("mouseup", endDrag);
  e.stopPropagation();
  e.preventDefault();
}

function handleClipMove(e) {
  if (dragMode !== "clip-move" || !clipMove.active) return;
  const rect = els.timeline.getBoundingClientRect();
  const span = timelineState.viewEnd - timelineState.viewStart || 1;
  const dx = e.clientX - clipMove.startX;
  const deltaSeconds = (dx / rect.width) * span;
  const length = clipMove.origEnd - clipMove.origStart;
  const newStart = clamp(clipMove.origStart + deltaSeconds, 0, timelineState.totalDuration - length);
  const newEnd = newStart + length;
  clipState.clipStart = newStart;
  clipState.clipEnd = newEnd;
  render();
}

function startPan(e) {
  dragMode = "pan";
  dragState.lastX = e.clientX;
  window.addEventListener("mousemove", handlePan);
  window.addEventListener("mouseup", endDrag);
  e.preventDefault();
}

function handlePan(e) {
  if (dragMode !== "pan") return;
  const rect = els.timeline.getBoundingClientRect();
  const dx = e.clientX - dragState.lastX;
  dragState.lastX = e.clientX;
  const span = timelineState.viewEnd - timelineState.viewStart;
  const deltaSeconds = -(dx / rect.width) * span;
  panTimeline(deltaSeconds);
}

function endDrag() {
  dragMode = null;
  window.removeEventListener("mousemove", handleScrub);
  window.removeEventListener("mousemove", handleResize);
  window.removeEventListener("mousemove", handlePan);
  window.removeEventListener("mousemove", handleClipMove);
  window.removeEventListener("mouseup", endDrag);
  clipMove.active = false;
}

function onWheel(e) {
  const rect = els.timeline.getBoundingClientRect();
  const span = timelineState.viewEnd - timelineState.viewStart;
  if (e.ctrlKey) {
    e.preventDefault();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const centerTime = xToTime(x);
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    zoomTimeline(centerTime, factor);
  } else if (e.altKey) {
    e.preventDefault();
    const deltaSeconds = (e.deltaY / 100) * (span * 0.1);
    panTimeline(deltaSeconds);
  }
}

// Hover preview
function onTimelineMove(e) {
  const rect = els.timeline.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  const t = xToTime(x);
  showHoverPreview(x, t);
}

function hideHover() {
  if (els.hoverPreview) {
    els.hoverPreview.style.display = "none";
  }
  pendingHoverTime = null;
}

// Overview drag
function startOverviewDrag(e) {
  overviewDrag.active = true;
  overviewDrag.offset = e.clientX - els.overviewThumb.getBoundingClientRect().left;
  overviewDrag.span = timelineState.viewEnd - timelineState.viewStart;
  window.addEventListener("mousemove", handleOverviewDrag);
  window.addEventListener("mouseup", stopOverviewDrag);
  e.preventDefault();
  e.stopPropagation();
}

function handleOverviewDrag(e) {
  if (!overviewDrag.active) return;
  const rect = els.overview.getBoundingClientRect();
  const thumbWidth = els.overviewThumb.getBoundingClientRect().width;
  let left = clamp(e.clientX - rect.left - overviewDrag.offset, 0, Math.max(0, rect.width - thumbWidth));
  const total = timelineState.totalDuration || 1;
  let start = (left / rect.width) * total;
  let end = start + overviewDrag.span;
  if (end > total) {
    end = total;
    start = Math.max(0, end - overviewDrag.span);
  }
  timelineState.viewStart = start;
  timelineState.viewEnd = end;
  render();
}

function stopOverviewDrag() {
  overviewDrag.active = false;
  window.removeEventListener("mousemove", handleOverviewDrag);
  window.removeEventListener("mouseup", stopOverviewDrag);
}

function onOverviewClick(e) {
  if (e.target === els.overviewThumb) return;
  const rect = els.overview.getBoundingClientRect();
  const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const span = timelineState.viewEnd - timelineState.viewStart;
  const total = timelineState.totalDuration || 1;
  let center = ratio * total;
  let start = center - span / 2;
  if (start < 0) start = 0;
  if (start + span > total) start = Math.max(0, total - span);
  timelineState.viewStart = start;
  timelineState.viewEnd = Math.min(total, start + span);
  render();
}

function playFromClipStart() {
  if (!clipState.isActive) return;
  setCursorTime(clipState.clipStart);
  if (els.video) {
    els.video.play();
    timelineState.isPlaying = true;
  }
}

// Hover preview rendering
function syncPreviewSource(src) {
  if (!src || !els.previewVideo) return;
  previewReady = false;
  pendingHoverTime = null;
  lastRequestedTime = null;
  debugLog("sync source", src);
  els.previewVideo.src = src;
  els.previewVideo.load();
}

function showHoverPreview(x, time) {
  if (!els.hoverPreview || !els.previewVideo) return;
  if (!timelineState.totalDuration) return;
  els.hoverPreview.style.display = "block";
  els.hoverPreviewTime.textContent = formatTime(time);
  pendingHoverTime = time;
  if (!previewReady) debugLog("hover while not ready (metadata pending?)");
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      maybeSeekPreview();
    });
  }
}

function maybeSeekPreview() {
  if (!previewReady || pendingHoverTime == null) {
    if (!previewReady) debugLog("skip seek: preview not ready");
    return;
  }
  if (
    lastRequestedTime === null ||
    Math.abs(pendingHoverTime - lastRequestedTime) > PREVIEW_SEEK_THRESHOLD
  ) {
    lastRequestedTime = pendingHoverTime;
    try {
      els.previewVideo.currentTime = pendingHoverTime;
      debugLog("seek", pendingHoverTime);
    } catch (e) {
      console.warn("preview seek error", e);
    }
  }
}

function drawHoverPreviewFrame() {
  if (!previewReady || pendingHoverTime == null) return;
  if (Math.abs(els.previewVideo.currentTime - pendingHoverTime) > PREVIEW_DRAW_TOLERANCE)
    return;
  const ctx = hoverCtx();
  if (!ctx) return;
  try {
    ctx.drawImage(
      els.previewVideo,
      0,
      0,
      els.hoverPreviewCanvas.width,
      els.hoverPreviewCanvas.height
    );
    debugLog("draw frame", els.previewVideo.currentTime);
  } catch (e) {
    console.warn("preview draw error", e);
  }
}

// Keyboard
function onKeyDown(e) {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.code === "Space") {
    e.preventDefault();
    playPause();
  } else if (e.code === "ArrowRight") {
    const step = e.shiftKey ? 5 : 1;
    setCursorTime(timelineState.cursorTime + step);
    ensureCursorVisible();
  } else if (e.code === "ArrowLeft") {
    const step = e.shiftKey ? 5 : 1;
    setCursorTime(timelineState.cursorTime - step);
    ensureCursorVisible();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File selection helpers
// ─────────────────────────────────────────────────────────────────────────────
function syncFileInput(file) {
  if (!fileInput || !file) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
  } catch (_) {
    // Ignore if DataTransfer unsupported
  }
}

function resetUI() {
  mainContainer.style.display = "none";
  preContainer.style.display = "contents";
  selectedFile = null;
  clipState.isActive = false;
  clipState.clipStart = 0;
  clipState.clipEnd = 0;
  if (fileInput) {
    fileInput.value = ""; // allow re-selecting the same file after closing
  }
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
  if (els.video) {
    els.video.pause();
    els.video.removeAttribute("src");
    els.video.load();
  }
  clipState.isActive = false;
  timelineState.cursorTime = 0;
  timelineState.totalDuration = 0;
  if (statusBox) {
    statusBox.style.display = "none";
    statusBox.textContent = "";
  }
  if (logRangeBtn) {
    logRangeBtn.disabled = true;
    logRangeBtn.style.display = "";
  }
  const progress = document.getElementById("myProgress");
  if (progress) progress.innerHTML = "";
  if (fileInfo) fileInfo.textContent = "";
  if (dropArea) dropArea.classList.remove("dragover");
  render();
}

function handleFile(file) {
  if (!file) return;
  selectedFile = file;
  syncFileInput(file);
  if (fileInfo) {
    fileInfo.textContent = `Selected file: ${file.name} (size: ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
  }
  if (statusBox) {
    statusBox.style.display = "none";
    statusBox.textContent = "";
  }
  if (logRangeBtn) {
    logRangeBtn.disabled = !clipState.isActive;
    logRangeBtn.style.display = "";
  }
  const progress = document.getElementById("myProgress");
  if (progress) progress.innerHTML = "";
  preContainer.style.display = "none";
  mainContainer.style.display = "block";
  loadVideoFile(file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Encoding pipeline (unchanged logic, new state vars)
// ─────────────────────────────────────────────────────────────────────────────
async function handleClipToX() {
  if (!clipState.isActive) {
    alert("No clip selected. Create a clip first.");
    return;
  }
  const VFS_IN = "input.mp4";
  const VFS_OUT = "output.mp4";
  const VFS_TRIM = "trimmed.mp4";
  const VFS_H264 = "video.h264";

  const clipDuration = clipState.clipEnd - clipState.clipStart;
  const belowMin = clipDuration < CONFIG.minClipLength - 0.01;
  const aboveMax = clipDuration > CONFIG.maxClipLength + 0.01;
  if (belowMin || aboveMax) {
    alert(
      `Clip length must be between ${CONFIG.minClipLength} and ${CONFIG.maxClipLength} seconds. (Current: ${clipDuration.toFixed(
        2
      )} s)`
    );
    return;
  }
  const file = selectedFile || fileInput?.files?.[0];
  if (!file) return alert("Please select a file");
  if (logRangeBtn) {
    logRangeBtn.disabled = true;
    logRangeBtn.style.display = "none";
  }
  if (statusBox) statusBox.style.display = "block";

  const outputName = "easy-video-trimmer-" + file.name;
  const ffmpegFallbackCmd =
    "ffmpeg -i " +
    VFS_IN +
    " -ss " +
    clipState.clipStart +
    " -to " +
    clipState.clipEnd +
    " -c:v libx264 -threads 4 -profile:v high -level:v 4.1 -preset fast" +
    " -b:v 5000k -maxrate 5000k -bufsize 10000k" +
    " -vf scale=1280:720,format=yuv420p -c:a aac -b:a 128k -ac 2 " +
    VFS_OUT;

  let finalBlob = null;

  try {
    if (supportsWebCodecs) {
      statusBox.innerHTML = 'Preparing clip… <span class="spinner"></span>';
      try {
        const trimmedBytes = await trimWithFFmpeg(
          VFS_IN,
          VFS_TRIM,
          file,
          clipState.clipStart,
          clipState.clipEnd
        );

        statusBox.innerHTML = 'Encoding video… <span class="spinner"></span>';
        const trimmedBlob = new Blob([trimmedBytes.buffer], {
          type: "video/mp4",
        });
        const progressContainer = document.getElementById("myProgress");
        let webcodecsProgress = null;
        if (progressContainer) {
          progressContainer.innerHTML = "";
          webcodecsProgress = new VideoProgress(progressContainer, clipDuration);
        }
        const { videoBytes, framerate } = await encodeWithWebCodecs(trimmedBlob, {
          bitrate: 5_000_000,
          durationSec: clipDuration,
          onProgress: ({ frame, totalFrames }) => {
            if (!webcodecsProgress || !totalFrames) return;
            const pctTime = Math.min(frame / totalFrames, 1);
            webcodecsProgress.update({ time: pctTime * clipDuration * 1_000_000 });
          },
        });

        statusBox.innerHTML = 'Finalizing audio + video… <span class="spinner"></span>';
        await writeFFmpegFile(VFS_H264, videoBytes);
        const { blob } = await muxWithFFmpeg({
          videoH264Path: VFS_H264,
          audioSourcePath: VFS_TRIM,
          outputPath: VFS_OUT,
          framerate,
          durationSec: clipDuration,
          saveAs: outputName,
        });
        finalBlob = blob;
      } catch (webcodecsErr) {
        console.warn("WebCodecs pipeline failed, falling back:", webcodecsErr);
        statusBox.innerHTML =
          'Encoder issue detected, retrying… <span class="spinner"></span>';
        const { blob } = await runFFmpeg(
          VFS_IN,
          VFS_OUT,
          ffmpegFallbackCmd,
          file,
          clipDuration,
          outputName
        );
        finalBlob = blob;
      }
    } else {
      statusBox.innerHTML = 'Encoding… <span class="spinner"></span>';
      const { blob } = await runFFmpeg(
        VFS_IN,
        VFS_OUT,
        ffmpegFallbackCmd,
        file,
        clipDuration,
        outputName
      );
      finalBlob = blob;
    }

    statusBox.innerHTML = 'Attaching to X… <span class="spinner"></span>';
    await attachClipToComposer(finalBlob, outputName, "video/mp4");
    startCountdownAndClose("Attached to X. Closing this window shortly.");
  } catch (err) {
    console.error(err);
    if (finalBlob) {
      statusBox.textContent =
        "Failed to attach automatically. Downloading the clip instead.";
      downloadFile(finalBlob, outputName);
      startCountdownAndClose("Attachment failed. Downloaded the clip instead.");
    } else {
      statusBox.textContent = "Failed to encode.";
      startCountdownAndClose("Failed to encode.");
    }
  }
}

function startCountdownAndClose(msg) {
  let n = 7;
  const tick = () => {
    statusBox.textContent = `${msg} Closing this window in ${n} s…`;
    if (n-- === 0) {
      clearInterval(t);
      window.close();
    }
  };
  const t = setInterval(tick, 1000);
  tick();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM wiring
// ─────────────────────────────────────────────────────────────────────────────
function initElements() {
  els.video = $("video");
  els.previewVideo = $("previewVideo");
  els.playPauseCenterBtn = $("playPauseCenterBtn");
  els.playFromClipBtn = $("playFromClipBtn");
  els.timeReadout = $("timeReadout");
  els.timeline = $("timeline");
  els.tickStrip = $("tickStrip");
  els.clipHighlight = $("clipHighlight");
  els.clipHandleStart = $("clipHandleStart");
  els.clipHandleEnd = $("clipHandleEnd");
  els.playhead = $("playhead");
  els.hoverPreview = $("hoverPreview");
  els.hoverPreviewTime = $("hoverPreviewTime");
  els.hoverPreviewCanvas = $("hoverPreviewCanvas");
  els.clipLabel = $("clipLabel");
  els.clipBtn = $("clipBtn");
  els.importBtn = $("importBtn");
  els.overview = $("overview");
  els.overviewThumb = $("overviewThumb");
  els.overviewPlayhead = $("overviewPlayhead");
  els.back10Btn = $("back10Btn");
  els.forward10Btn = $("forward10Btn");
  els.stepLeftBtn = $("stepLeftBtn");
  els.stepRightBtn = $("stepRightBtn");
  els.zoomInBtn = $("zoomInBtn");
  els.zoomOutBtn = $("zoomOutBtn");
  els.attachBtn = $("log-range-btn");
  els.closeButton = $("closeButton");
}

function wireEvents() {
  if (els.playPauseCenterBtn) els.playPauseCenterBtn.addEventListener("click", playPause);
  if (els.video) {
    els.video.addEventListener("play", () => {
      timelineState.isPlaying = true;
      render();
    });
    els.video.addEventListener("pause", () => {
      timelineState.isPlaying = false;
      render();
    });
    els.video.addEventListener("timeupdate", () => {
      timelineState.cursorTime = els.video.currentTime;
      if (timelineState.isPlaying) ensureCursorVisible();
      render();
    });
    els.video.addEventListener("loadedmetadata", updateDuration);
  }

  if (els.timeline) {
    els.timeline.addEventListener("mousedown", onTimelineMouseDown);
    els.timeline.addEventListener("mousemove", onTimelineMove);
    els.timeline.addEventListener("mouseleave", hideHover);
    els.timeline.addEventListener("wheel", onWheel, { passive: false });
  }
  if (els.playhead) els.playhead.addEventListener("mousedown", startScrub);
  if (els.clipHandleStart)
    els.clipHandleStart.addEventListener("mousedown", (e) => startResize("start", e));
  if (els.clipHandleEnd)
    els.clipHandleEnd.addEventListener("mousedown", (e) => startResize("end", e));
  if (els.clipHighlight) els.clipHighlight.addEventListener("mousedown", startClipMove);
  if (els.clipBtn)
    els.clipBtn.addEventListener("click", () => {
      clipState.isActive ? cancelClip() : createClip();
    });
  if (els.playFromClipBtn) els.playFromClipBtn.addEventListener("click", playFromClipStart);
  if (els.overviewThumb) els.overviewThumb.addEventListener("mousedown", startOverviewDrag);
  if (els.overview) els.overview.addEventListener("mousedown", onOverviewClick);

  if (els.back10Btn) els.back10Btn.addEventListener("click", () => jumpRelative(-10));
  if (els.forward10Btn) els.forward10Btn.addEventListener("click", () => jumpRelative(10));
  if (els.stepLeftBtn) els.stepLeftBtn.addEventListener("click", () => stepFrame(-1));
  if (els.stepRightBtn) els.stepRightBtn.addEventListener("click", () => stepFrame(1));
  if (els.zoomInBtn)
    els.zoomInBtn.addEventListener("click", () => zoomTimeline(timelineState.cursorTime, 1.3));
  if (els.zoomOutBtn)
    els.zoomOutBtn.addEventListener("click", () => zoomTimeline(timelineState.cursorTime, 0.8));
  if (els.attachBtn) els.attachBtn.addEventListener("click", handleClipToX);

  if (els.importBtn) els.importBtn.addEventListener("click", () => fileInput?.click());
  if (els.closeButton) els.closeButton.addEventListener("click", resetUI);

  if (dropArea) {
    dropArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropArea.classList.add("dragover");
    });
    dropArea.addEventListener("dragleave", () => dropArea.classList.remove("dragover"));
    dropArea.addEventListener("drop", (e) => {
      e.preventDefault();
      dropArea.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith("video/")) {
        handleFile(f);
      } else if (fileInfo) {
        fileInfo.textContent = "Please drop a video file.";
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      f && f.type.startsWith("video/")
        ? handleFile(f)
        : fileInfo && (fileInfo.textContent = "Please select a video file.");
    });
  }

  window.addEventListener("resize", render);
  document.addEventListener("keydown", onKeyDown);

  if (els.previewVideo) {
    els.previewVideo.addEventListener("loadedmetadata", () => {
      previewReady = true;
    });
    els.previewVideo.addEventListener("seeked", drawHoverPreviewFrame);
    els.previewVideo.addEventListener("error", (e) => {
      console.warn("previewVideo error", e);
    });
  }
}

function bootstrap() {
  initElements();
  wireEvents();
  render();
}

bootstrap();

// ─────────────────────────────────────────────────────────────────────────────
// VideoProgress – used by ffmpeg-controller.js
// ─────────────────────────────────────────────────────────────────────────────
class VideoProgress {
  /**
   * @param {HTMLElement} container – element with .video-progress class
   * @param {number} clipDuration   – seconds trimmed clip should last
   */
  constructor(container, clipDuration) {
    this.bar = document.createElement("div");
    this.info = document.createElement("div");
    this.bar.className = "video-progress__bar";
    this.info.className = "video-progress__info";
    container.append(this.bar, this.info);
    this.clipDuration = clipDuration;
  }
  /** Update progress UI from FFmpeg log callback */
  update({ time }) {
    const sec = time / 1_000_000;
    const pct = Math.min((sec / this.clipDuration) * 100, 100);
    this.bar.style.width = pct + "%";
    this.info.textContent = `${pct.toFixed(1)}% • ${sec.toFixed(2)}s`;
  }
}
