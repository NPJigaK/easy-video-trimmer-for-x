const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

// initialize ffmpeg
const ffmpeg = new FFmpeg();

// convert wasm and core url to absolute path
const coreUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.js");
const wasmUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.wasm");
const workerUrl = chrome.runtime.getURL("lib/ffmpeg/ffmpeg-core.worker.js");

// log ffmpeg messages
ffmpeg.on("log", ({ message }) => {
  console.log(message);
});

let progress;

let clipDuration;
// progress bar
ffmpeg.on("progress", ({ time }) => {
  progress.update({ time });
  const currentSeconds = time / 1000000; // 秒に変換
  const progressPercentage = Math.min(
    (currentSeconds / clipDuration) * 100,
    100
  );
  console.log(
    progressPercentage.toFixed(1) +
      "%, time: " +
      currentSeconds.toFixed(2) +
      " s"
  );
});

// custom ffmpeg command
async function runFFmpeg(
  inputFileName,
  outputFileName,
  commandStr,
  file,
  _clipDuration
) {
  clipDuration = _clipDuration;
  progress= new VideoProgress(document.getElementById("myProgress"), _clipDuration);
  console.log(inputFileName, outputFileName, commandStr, file);

  // exit ffmpeg if it is already loaded
  if (ffmpeg.loaded) {
    await ffmpeg.terminate();
  }

  // load ffmpeg
  await ffmpeg.load({
    coreURL: coreUrl,
    wasmURL: wasmUrl,
    workerURL: workerUrl,
  });

  // split command string
  const commandList = commandStr.split(" ");
  if (commandList.shift() !== "ffmpeg") {
    alert("Please start with ffmpeg");
    return;
  }

  // write file to filesystem
  await ffmpeg.writeFile(inputFileName, await fetchFile(file));

  // execute command
  console.log(commandList);
  await ffmpeg.exec(commandList);

  // read output file
  const data = await ffmpeg.readFile(outputFileName);

  // create blob and download
  const blob = new Blob([data.buffer]);
  console.log(blob);
  downloadFile(blob, outputFileName);
}

function downloadFile(blob, fileName) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
}
