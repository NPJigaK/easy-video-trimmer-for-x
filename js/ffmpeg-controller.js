// =======================================================================
// ffmpeg-controller.js – Thin wrapper around @ffmpeg/ffmpeg WASM runtime
// -----------------------------------------------------------------------
// • Exposes runFFmpeg() so UI can pass (input, output, command, File blob).
// • Handles:
//     1. Locating core / wasm / worker via chrome.runtime.getURL()
//     2. Lazy‑loading / terminating the FFmpeg instance between runs
//     3. Bridging FFmpeg progress → VideoProgress (blue bar)
//     4. Converting Uint8Array output → downloadable Blob
// =======================================================================

// Shorthands exposed by util bundle (bundled under lib/ffmpeg/)
const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

// ---- 1. Instance & asset URLs --------------------------------------------
const ffmpeg = new FFmpeg(); // one global instance – recreated each run

// All 3 worker assets must be absolute extension URLs so FFmpeg can import()
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm");
const workerUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.worker.js");

// ---- 2. Logging & progress taps ------------------------------------------
ffmpeg.on("log", ({ message }) => console.log(message));

let progress; // VideoProgress instance (injected later)
let clipDuration; // seconds – used to compute %

ffmpeg.on("progress", ({ time }) => {
  progress.update({ time }); // visual bar
  const sec = time / 1_000_000;
  const pct = Math.min((sec / clipDuration) * 100, 100);
  console.log(`${pct.toFixed(1)}%, time: ${sec.toFixed(2)} s`);
});

// ---------------------------------------------------------------------------
// runFFmpeg() – main entry from content.js
// ---------------------------------------------------------------------------
/**
 * @param {string}  inputFileName  – virtual FS path (e.g. original.mp4)
 * @param {string}  outputFileName – desired output name (e.g. clip.mp4)
 * @param {string}  commandStr     – full CLI string starting with "ffmpeg"
 * @param {File}    file           – browser File object selected by user
 * @param {number}  _clipDuration  – seconds, for progress calculation
 */
async function runFFmpeg(
  inputFileName,
  outputFileName,
  commandStr,
  file,
  _clipDuration
) {
  // 0) Prepare progress bar
  clipDuration = _clipDuration;
  progress = new VideoProgress(
    document.getElementById("myProgress"),
    _clipDuration
  );

  // 1) Terminate previous instance (memory leak guard)
  if (ffmpeg.loaded) await ffmpeg.terminate();

  // 2) Load core/wasm/worker – takes ~1s on modern machines
  await ffmpeg.load({
    coreURL: coreUrl,
    wasmURL: wasmUrl,
    workerURL: workerUrl,
  });

  // 3) Build CLI array, ensure string starts with "ffmpeg"
  const cmd = commandStr.split(" ");
  if (cmd.shift() !== "ffmpeg") {
    alert("Command must start with 'ffmpeg'");
    return;
  }

  // 4) Mount input file inside FFmpeg virtual FS
  await ffmpeg.writeFile(inputFileName, await fetchFile(file));

  // 5) Execute!
  console.log(cmd);
  await ffmpeg.exec(cmd);

  // 6) Retrieve Uint8Array → Blob → trigger download
  const data = await ffmpeg.readFile(outputFileName);
  downloadFile(new Blob([data.buffer]), outputFileName);
}

// Simple download helper (avoids using chrome.downloads permission)
function downloadFile(blob, fileName) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
}
