// =======================================================================
// ffmpeg-controller.js – Thin wrapper around @ffmpeg/ffmpeg WASM runtime
// -----------------------------------------------------------------------
// Exposes two layers:
//   1) Legacy runFFmpeg() – all-in-FFmpeg pipeline (fallback)
//   2) New helpers for hybrid mode:
//        • ensureFFmpegLoaded() – lazy load core/wasm/worker
//        • trimWithFFmpeg()     – precise trim + container copy
//        • muxWithFFmpeg()      – WebCodecs H.264 + AAC → MP4
//        • readFFmpegFile()     – pull Uint8Array out of VFS
//        • writeFFmpegFile()    – push Uint8Array into VFS
// Notes on the hybrid flow:
//   - FFmpeg is still used for trimming and mux/demux (exact cut points).
//   - WebCodecs does the heavy video encode when available.
//   - The UI (content.js) decides which path to run at runtime.
// =======================================================================

// Shorthands exposed by util bundle (bundled under lib/ffmpeg/)
const { FFmpeg, FFFSType } = FFmpegWASM;

// ---- 1. Instance & asset URLs --------------------------------------------
const ffmpeg = new FFmpeg(); // single instance reused across steps

// All 3 worker assets must be absolute extension URLs so FFmpeg can import()
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/core-mt/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/core-mt/ffmpeg-core.wasm");
const workerUrl = chrome.runtime.getURL(
  "lib/ffmpeg/core-mt/ffmpeg-core.worker.js"
);

// ---- 2. Logging & progress taps ------------------------------------------
ffmpeg.on("log", ({ message }) => console.log(message));

let progress; // VideoProgress instance (injected later)
let clipDuration; // seconds – used to compute %

ffmpeg.on("progress", ({ time }) => {
  if (progress) progress.update({ time }); // visual bar
  const sec = time / 1_000_000;
  const pct = clipDuration
    ? Math.min((sec / clipDuration) * 100, 100)
    : undefined;
  console.log(
    pct !== undefined
      ? `${pct.toFixed(1)}%, time: ${sec.toFixed(2)} s`
      : `time: ${sec.toFixed(2)} s`
  );
});

// ---------------------------------------------------------------------------
// withMountedInput() – mount input File via WORKERFS to avoid full in-memory copy
// Old: fetchFile + writeFile (copies entire File into MEMFS)
// New: mount(WORKERFS) so FFmpeg reads the File directly without duplicating it
// ---------------------------------------------------------------------------
async function withMountedInput(file, callback) {
  const inputDir = "/input";
  const inputPath = `${inputDir}/${file.name}`;
  await ffmpeg.createDir(inputDir);
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, inputDir);
  try {
    return await callback({ inputDir, inputPath });
  } finally {
    await ffmpeg.unmount(inputDir);
    await ffmpeg.deleteDir(inputDir);
  }
}

// ---------------------------------------------------------------------------
// Progress helper shared by both pipelines
// ---------------------------------------------------------------------------
function initProgressBar(durationSec) {
  clipDuration = durationSec;
  const container = document.getElementById("myProgress");
  container.innerHTML = "";
  progress = new VideoProgress(container, durationSec);
}

// ---------------------------------------------------------------------------
// ensureFFmpegLoaded() – lazy load core/wasm/worker once
// ---------------------------------------------------------------------------
async function ensureFFmpegLoaded() {
  if (ffmpeg.loaded) return;
  await ffmpeg.load({
    coreURL: coreUrl,
    wasmURL: wasmUrl,
    workerURL: workerUrl,
  });
}

// ---------------------------------------------------------------------------
// read / write helpers for the VFS (Uint8Array <-> FFmpeg memfs)
// ---------------------------------------------------------------------------
async function readFFmpegFile(path) {
  return ffmpeg.readFile(path);
}

async function writeFFmpegFile(path, data) {
  return ffmpeg.writeFile(path, data);
}

// ---------------------------------------------------------------------------
// trimWithFFmpeg() – precise trim using FFmpeg (copy streams, avoid re-encode)
// Returns Uint8Array of the trimmed container for WebCodecs to decode.
// ---------------------------------------------------------------------------
async function trimWithFFmpeg(
  inputFileName,
  trimmedFileName,
  file,
  startSec,
  endSec
) {
  const clipLen = endSec - startSec;
  initProgressBar(clipLen);
  await ensureFFmpegLoaded();

  await withMountedInput(file, async ({ inputPath }) => {
    const cmd = [
      "-ss",
      `${startSec}`,
      "-i",
      inputPath,
      "-t",
      `${clipLen}`,
      "-c",
      "copy",
      "-copyinkf",
      "-avoid_negative_ts",
      "make_zero",
      trimmedFileName,
    ];
    await ffmpeg.exec(cmd);
  });
  return ffmpeg.readFile(trimmedFileName);
}

// ---------------------------------------------------------------------------
// muxWithFFmpeg() – wrap WebCodecs H.264 + audio into MP4
// ---------------------------------------------------------------------------
async function muxWithFFmpeg({
  videoH264Path,
  audioSourcePath,
  outputPath,
  framerate,
  durationSec,
  saveAs,
  shouldDownload = false,
}) {
  initProgressBar(durationSec);
  await ensureFFmpegLoaded();
  const cmd = [
    "-r",
    `${Math.round(framerate || 30)}`,
    "-i",
    videoH264Path,
    "-i",
    audioSourcePath,
    "-map",
    "0:v:0",
    "-map",
    "1:a?",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ];

  await ffmpeg.exec(cmd);
  const data = await ffmpeg.readFile(outputPath);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  if (shouldDownload && saveAs) downloadFile(blob, saveAs);
  return { blob, fileName: saveAs || outputPath };
}

// ---------------------------------------------------------------------------
// runFFmpeg() – legacy all-in-FFmpeg path (CPU-only fallback)
// ---------------------------------------------------------------------------
/**
 * @param {string}  inputFileName  – virtual FS path (e.g. original.mp4)
 * @param {string}  outputFileName – desired output name (e.g. clip.mp4)
 * @param {string}  commandStr     – full CLI string starting with "ffmpeg"
 * @param {File}    file           – browser File object selected by user
 * @param {number}  _clipDuration  – seconds, for progress calculation
 * @param {string}  [saveAs]       – optional name used only when downloading
 * @param {{ shouldDownload?: boolean }} [options]
 */
async function runFFmpeg(
  inputFileName,
  outputFileName,
  commandStr,
  file,
  _clipDuration,
  saveAs,
  { shouldDownload = false } = {}
) {
  // 0) Prepare progress bar
  initProgressBar(_clipDuration);

  // 1) Load core/wasm/worker – takes ~1s on modern machines
  await ensureFFmpegLoaded();

  // 3) Build CLI array, ensure string starts with "ffmpeg"
  const cmd = commandStr.split(" ");
  if (cmd.shift() !== "ffmpeg") {
    alert("Command must start with 'ffmpeg'");
    return;
  }

  // 4) Mount input file via WORKERFS and run the command with the mounted path
  await withMountedInput(file, async ({ inputPath }) => {
    const updatedCmd = cmd.map((arg) =>
      arg === inputFileName ? inputPath : arg
    );
    console.log(updatedCmd);
    await ffmpeg.exec(updatedCmd);
  });

  // 6) Retrieve Uint8Array → Blob → return to caller (optional download)
  const data = await ffmpeg.readFile(outputFileName);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  if (shouldDownload && saveAs) downloadFile(blob, saveAs);
  return { blob, fileName: saveAs || outputFileName };
}

// Simple download helper (avoids using chrome.downloads permission)
function downloadFile(blob, fileName) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
}
