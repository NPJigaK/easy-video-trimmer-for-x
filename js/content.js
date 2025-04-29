// ============================================================================
// content.js – UI logic & timeline interaction for the trimming window
// ----------------------------------------------------------------------------
// * Lives inside main.html (opened by the ✂︎ button).
// * Owns *all* state for clipStart / clipEnd, timeline zoom‑window, and
//   current‑time indicator.
// * Coordinates with:
//     - Video.js player instance (preview)
//     - ffmpeg-controller.js (runFFmpeg)   → encodes & downloads clip
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// 0. Reset‑to‑initial (× button)
//     • Hides the main UI and resets Video.js + file input so the user can
//       pick a new video without reopening the popup.
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById("closeButton").addEventListener("click", () => {
  const main = document.getElementById("main-extension-container");
  const pre = document.getElementById("pre-extension-container");
  main.style.display = "none";
  pre.style.display = "contents";
  player.reset();
  document.getElementById("fileInput").value = "";
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Video.js player – minimal controls, 0.5×–4× speeds, no PiP/full‑screen
// ─────────────────────────────────────────────────────────────────────────────
const player = videojs("my-video", {
  playbackRates: [0.5, 1, 1.5, 2, 3, 4],
  controlBar: {
    fullscreenToggle: false,
    pictureInPictureToggle: false,
    skipButtons: { forward: 5, backward: 5 }, // ← 5‑sec skip arrows
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DOM references & global state buckets
// ─────────────────────────────────────────────────────────────────────────────
const timelineContainer = document.getElementById("timeline-container");
const clipRange = document.getElementById("clip-range");
const leftHandle = document.querySelector(".left-handle");
const rightHandle = document.querySelector(".right-handle");
const startTimeLabel = document.getElementById("startTimeLabel");
const endTimeLabel = document.getElementById("endTimeLabel");
const currentIndicator = document.getElementById("current-indicator");

// Time constraints (X.com: 0 – 140 s)
const MIN_CLIP_LENGTH = 5; // lower bound (s)
const MAX_CLIP_LENGTH = 139; // upper bound (s)
const VIEW_DURATION_MAX = 280; // maximum timeline window (s)

let videoDuration = 0; // full video length (s)
// Timeline window ← horizontal scroll of long video
let timelineWindowStart = 0;
let timelineWindowEnd = 0;
let pxPerSec = 0; // pixels per second inside current window

// Clip boundaries (in video seconds)
let clipStart = 0;
let clipEnd = 5; // default 5‑second clip

// Drag‑state flags
let isDraggingLeft = false;
let isDraggingRight = false;
let isDraggingRange = false;
let dragStartX = 0;
let dragStartClipStart = 0;
let dragStartClipEnd = 0;

let isDraggingIndicator = false; // red play‑head drag flag

// ─────────────────────────────────────────────────────────────────────────────
// 3. Helper utilities  (clamp / unit conversion)
// ─────────────────────────────────────────────────────────────────────────────
const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
const secToPx = (t) => (t - timelineWindowStart) * pxPerSec;
const pxToSec = (px) => px / pxPerSec;

// ---------------------------------------------------------------------------
// updateClipUI() – reposition yellow range + update labels
// ---------------------------------------------------------------------------
function updateClipUI() {
  clipRange.style.left = secToPx(clipStart) + "px";
  clipRange.style.width = secToPx(clipEnd) - secToPx(clipStart) + "px";
  startTimeLabel.textContent = clipStart.toFixed(2);
  endTimeLabel.textContent = clipEnd.toFixed(2);
}

// Ensure current length stays within MIN↔MAX when user drags
function adjustClipLength() {
  const len = clipEnd - clipStart;
  if (len < MIN_CLIP_LENGTH) {
    isDraggingLeft
      ? (clipStart = clipEnd - MIN_CLIP_LENGTH)
      : (clipEnd = clipStart + MIN_CLIP_LENGTH);
  } else if (len > MAX_CLIP_LENGTH) {
    isDraggingLeft
      ? (clipStart = clipEnd - MAX_CLIP_LENGTH)
      : (clipEnd = clipStart + MAX_CLIP_LENGTH);
  }
}

// Keep clip inside current timeline window
function clampClipToWindow() {
  if (clipStart < timelineWindowStart) clipStart = timelineWindowStart;
  if (clipEnd > timelineWindowEnd) clipEnd = timelineWindowEnd;
  adjustClipLength();
  clipStart = clamp(clipStart, timelineWindowStart, timelineWindowEnd);
  clipEnd = clamp(clipEnd, timelineWindowStart, timelineWindowEnd);
}

const finalizeClipChange = () => {
  clampClipToWindow();
  updateClipUI();
};

// ---------------------------------------------------------------------------
// updateTimelineWindow() – scrolls grey background so play‑head stays visible
// ---------------------------------------------------------------------------
function updateTimelineWindow(refTime) {
  const view =
    videoDuration > VIEW_DURATION_MAX ? VIEW_DURATION_MAX : videoDuration;
  timelineWindowStart = clamp(refTime - view / 2, 0, videoDuration - view);
  timelineWindowEnd = timelineWindowStart + view;
  pxPerSec = timelineContainer.offsetWidth / view;

  // If yellow range left the view, nudge it back
  const len = clipEnd - clipStart;
  if (clipStart < timelineWindowStart) {
    clipStart = timelineWindowStart;
    clipEnd = clipStart + len;
  }
  if (clipEnd > timelineWindowEnd) {
    clipEnd = timelineWindowEnd;
    clipStart = clipEnd - len;
  }
  updateClipUI();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Red play‑head: auto‑sync & drag‑to‑seek
// ─────────────────────────────────────────────────────────────────────────────
function updateCurrentIndicator() {
  if (isDraggingIndicator) return; // user has control
  const t = player.currentTime();
  if (t < timelineWindowStart || t > timelineWindowEnd) updateTimelineWindow(t);
  currentIndicator.style.left = secToPx(t) + "px";
}

// ---- Drag handlers ---------------------------------------------------------
currentIndicator.addEventListener("mousedown", (e) => {
  e.preventDefault();
  isDraggingIndicator = true;
});

document.addEventListener("mousemove", (e) => {
  if (!isDraggingIndicator) return;
  const rect = timelineContainer.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, timelineContainer.offsetWidth);
  currentIndicator.style.left = x + "px";
});

document.addEventListener("mouseup", (e) => {
  if (!isDraggingIndicator) return;
  isDraggingIndicator = false;
  const rect = timelineContainer.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, timelineContainer.offsetWidth);
  player.currentTime(timelineWindowStart + pxToSec(x));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Yellow range drag logic  (left handle / right handle / whole bar)
// ─────────────────────────────────────────────────────────────────────────────
leftHandle.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  isDraggingLeft = true;
  dragStartX = e.clientX;
  dragStartClipStart = clipStart;
});

rightHandle.addEventListener("mousedown", (e) => {
  e.stopPropagation();
  isDraggingRight = true;
  dragStartX = e.clientX;
  dragStartClipEnd = clipEnd;
});

clipRange.addEventListener("mousedown", (e) => {
  if (e.target === clipRange) {
    isDraggingRange = true;
    dragStartX = e.clientX;
    dragStartClipStart = clipStart;
    dragStartClipEnd = clipEnd;
  }
});

document.addEventListener("mousemove", (e) => {
  const deltaSec = pxToSec(e.clientX - dragStartX);
  if (isDraggingLeft) {
    clipStart = dragStartClipStart + deltaSec;
    if (clipStart >= clipEnd) clipStart = clipEnd - 0.1;
  } else if (isDraggingRight) {
    clipEnd = dragStartClipEnd + deltaSec;
    if (clipEnd <= clipStart) clipEnd = clipStart + 0.1;
  } else if (isDraggingRange) {
    clipStart = dragStartClipStart + deltaSec;
    clipEnd = dragStartClipEnd + deltaSec;
  }
  adjustClipLength();
  clampClipToWindow();
  updateClipUI();
});

document.addEventListener("mouseup", () => {
  if (isDraggingLeft || isDraggingRight || isDraggingRange) {
    isDraggingLeft = isDraggingRight = isDraggingRange = false;
    finalizeClipChange();
    player.currentTime(clipStart); // jump preview back to start of yellow box
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Player event listeners  (metadata / seek / timeupdate)
// ─────────────────────────────────────────────────────────────────────────────
player.on("loadedmetadata", () => {
  videoDuration = player.duration();
  const view =
    videoDuration > VIEW_DURATION_MAX ? VIEW_DURATION_MAX : videoDuration;
  timelineWindowStart = 0;
  timelineWindowEnd = view;
  pxPerSec = timelineContainer.offsetWidth / view;
  clipStart = 0;
  clipEnd = videoDuration > 15 ? 15 : Math.min(MIN_CLIP_LENGTH, view);
  updateClipUI();
});

player.on("seeked", () => {
  updateTimelineWindow(player.currentTime());
  updateCurrentIndicator();
  const t = player.currentTime();
  if (t < clipStart || t > clipEnd) {
    const len = clipEnd - clipStart;
    clipStart = t;
    clipEnd = clipStart + len;
    clampClipToWindow();
    updateClipUI();
  }
});

player.on("timeupdate", updateCurrentIndicator);

// Space‑bar toggles play / pause even when focus is outside player
// (prevents default page scroll)
document.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    player[player.paused() ? "play" : "pause"]();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. File selection (drag‑drop & chooser) → load into Video.js
// ─────────────────────────────────────────────────────────────────────────────
const dropArea = document.getElementById("dropArea");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");

function handleFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  player.src({ type: file.type, src: url });
  player.load();
  player.play();
  document.getElementById("main-extension-container").style.display = "block";
  document.getElementById("pre-extension-container").style.display = "none";
  fileInfo.textContent = `選択されたファイル: ${file.name} (サイズ: ${(
    file.size /
    1024 /
    1024
  ).toFixed(2)} MB)`;
}

// Drag‑over effects
dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropArea.classList.add("dragover");
});

dropArea.addEventListener("dragleave", () =>
  dropArea.classList.remove("dragover")
);

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  f && f.type.startsWith("video/")
    ? handleFile(f)
    : (fileInfo.textContent = "動画ファイルをドロップしてください。");
});

fileInput.addEventListener("change", (e) => {
  const f = e.target.files[0];
  f && f.type.startsWith("video/")
    ? handleFile(f)
    : (fileInfo.textContent = "動画ファイルを選択してください。");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. "Clip video download" button → FFmpeg WASM encode & auto‑close
// ─────────────────────────────────────────────────────────────────────────────
const logRangeBtn = document.getElementById("log-range-btn");
const statusBox = document.getElementById("status-box");

logRangeBtn.addEventListener("click", async () => {
  logRangeBtn.disabled = true;
  logRangeBtn.style.display = "none";
  statusBox.innerHTML = 'Encoding… <span class="spinner"></span>';
  statusBox.style.display = "block";

  console.log(`Clip Range: start=${clipStart}, end=${clipEnd}`);
  const file = fileInput.files[0];
  if (!file) return alert("Please select a file");

  const input = file.name;
  const output = "easy-clip-video-" + file.name;
  const cmd =
    "ffmpeg -i " +
    input +
    " -ss " +
    clipStart +
    " -to " +
    clipEnd +
    " -c:v libx264 -threads 4 -profile:v high -level:v 4.0 -preset fast" +
    " -b:v 5000k -maxrate 5000k -bufsize 10000k" +
    " -vf scale=1280:720,format=yuv420p -c:a aac -b:a 128k -ac 2 " +
    output;
  try {
    await runFFmpeg(input, output, cmd, file, clipEnd - clipStart);
    startCountdownAndClose("Download complete!");
  } catch (_) {
    startCountdownAndClose("Failed to encoding.");
  }
});

function startCountdownAndClose(msg) {
  let n = 5;
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
// 9. VideoProgress – tiny helper class used by ffmpeg-controller.js
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
