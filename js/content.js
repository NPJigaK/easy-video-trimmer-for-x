// ============================
// 再生位置更新＆黄色枠調整処理
// ============================
document.getElementById("closeButton").addEventListener("click", function () {
  // 例として、#main-extension-container を非表示にする
  const mainContainer = document.getElementById("main-extension-container");
  mainContainer.style.display = "none";
  const preContainer = document.getElementById("pre-extension-container");
  preContainer.style.display = "contents";
  player.reset();
  const fileInput = document.getElementById("fileInput");
  fileInput.value = "";
});

// video.js のプレイヤー設定
const player = videojs("my-video", {
  playbackRates: [0.5, 1, 1.5, 2, 3, 4],
  controlBar: {
    fullscreenToggle: false,
    pictureInPictureToggle: false,
    skipButtons: {
      forward: 5, // 5秒進む
      backward: 5, // 5秒戻る
    },
  },
});

// DOM要素の取得
const timelineContainer = document.getElementById("timeline-container");
const clipRange = document.getElementById("clip-range");
const leftHandle = document.querySelector(".left-handle");
const rightHandle = document.querySelector(".right-handle");
const startTimeLabel = document.getElementById("startTimeLabel");
const endTimeLabel = document.getElementById("endTimeLabel");
//const logRangeBtn = document.getElementById('log-range-btn');
const currentIndicator = document.getElementById("current-indicator");

// 定数設定
const MIN_CLIP_LENGTH = 5; // 5秒以上
const MAX_CLIP_LENGTH = 139; // 139秒以内
const VIEW_DURATION_MAX = 280; // タイムライン表示の上限（必要に応じて調整）

let videoDuration = 0;
// タイムラインウィンドウ：動画全体から表示される部分の開始・終了時間（秒）
let timelineWindowStart = 0;
let timelineWindowEnd = 0;
let pxPerSec = 0; // タイムライン上の1秒あたりのピクセル数

// クリップ選択の開始・終了時間（動画上の実際の秒数）
let clipStart = 0;
let clipEnd = 5; // 初期は5秒間（動画が短い場合は調整）

// ドラッグ状態の管理（黄色枠の操作用）
let isDraggingLeft = false;
let isDraggingRight = false;
let isDraggingRange = false;
let dragStartX = 0;
let dragStartClipStart = 0;
let dragStartClipEnd = 0;

// 追加: 赤い再生インジケーターのドラッグ状態
let isDraggingIndicator = false;

// ============================
// ユーティリティ関数
// ============================
// 値をmin～maxに丸める
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// タイムラインウィンドウの開始時刻からのオフセットで秒→pxに変換
function secToPx(time) {
  return (time - timelineWindowStart) * pxPerSec;
}

// px→秒変換（タイムラインウィンドウのオフセット考慮）
function pxToSec(px) {
  return px / pxPerSec;
}

// クリップ範囲の表示位置・サイズを更新、ラベルも更新する関数
function updateClipUI() {
  const left = secToPx(clipStart);
  const width = secToPx(clipEnd) - secToPx(clipStart);
  clipRange.style.left = left + "px";
  clipRange.style.width = width + "px";

  startTimeLabel.textContent = clipStart.toFixed(2);
  endTimeLabel.textContent = clipEnd.toFixed(2);
}

// クリップ長が規定内（5秒～139秒）に収まるよう調整する関数
function adjustClipLength() {
  let length = clipEnd - clipStart;
  if (length < MIN_CLIP_LENGTH) {
    if (isDraggingLeft) {
      clipStart = clipEnd - MIN_CLIP_LENGTH;
    } else if (isDraggingRight) {
      clipEnd = clipStart + MIN_CLIP_LENGTH;
    }
  } else if (length > MAX_CLIP_LENGTH) {
    if (isDraggingLeft) {
      clipStart = clipEnd - MAX_CLIP_LENGTH;
    } else if (isDraggingRight) {
      clipEnd = clipStart + MAX_CLIP_LENGTH;
    }
  }
}

// クリップがタイムラインウィンドウ内に収まるように調整する関数
function clampClipToWindow() {
  if (clipStart < timelineWindowStart) {
    clipStart = timelineWindowStart;
    clipEnd = Math.max(clipEnd, clipStart + MIN_CLIP_LENGTH);
  }
  if (clipEnd > timelineWindowEnd) {
    clipEnd = timelineWindowEnd;
    clipStart = Math.min(clipStart, clipEnd - MIN_CLIP_LENGTH);
  }
  adjustClipLength();
  clipStart = clamp(clipStart, timelineWindowStart, timelineWindowEnd);
  clipEnd = clamp(clipEnd, timelineWindowStart, timelineWindowEnd);
}

// ドラッグ終了時に最終調整する関数
function finalizeClipChange() {
  clampClipToWindow();
  updateClipUI();
}

// タイムラインウィンドウを更新（現在の再生位置を中心に配置）
function updateTimelineWindow(referenceTime) {
  let viewDuration =
    videoDuration > VIEW_DURATION_MAX ? VIEW_DURATION_MAX : videoDuration;
  let newWindowStart = referenceTime - viewDuration / 2;
  newWindowStart = clamp(newWindowStart, 0, videoDuration - viewDuration);
  timelineWindowStart = newWindowStart;
  timelineWindowEnd = timelineWindowStart + viewDuration;
  pxPerSec =
    timelineContainer.offsetWidth / (timelineWindowEnd - timelineWindowStart);

  // クリップ選択がウィンドウ外に出た場合の調整
  const clipLength = clipEnd - clipStart;
  if (clipStart < timelineWindowStart) {
    clipStart = timelineWindowStart;
    clipEnd = clipStart + clipLength;
    if (clipEnd > timelineWindowEnd) clipEnd = timelineWindowEnd;
  }
  if (clipEnd > timelineWindowEnd) {
    clipEnd = timelineWindowEnd;
    clipStart = clipEnd - clipLength;
    if (clipStart < timelineWindowStart) clipStart = timelineWindowStart;
  }
  updateClipUI();
}

// ============================
// 赤い再生インジケーター更新
// ============================
// ※ドラッグ中は自動更新しない
function updateCurrentIndicator() {
  if (isDraggingIndicator) return;
  const currentTime = player.currentTime();
  if (currentTime < timelineWindowStart || currentTime > timelineWindowEnd) {
    updateTimelineWindow(currentTime);
  }
  currentIndicator.style.left = secToPx(currentTime) + "px";
}

// ============================
// 黄色枠（クリップ範囲）のドラッグ操作
// ============================
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
  if (isDraggingLeft) {
    const deltaX = e.clientX - dragStartX;
    const deltaSec = pxToSec(deltaX);
    clipStart = dragStartClipStart + deltaSec;
    if (clipStart >= clipEnd) clipStart = clipEnd - 0.1;
    adjustClipLength();
    clampClipToWindow();
    updateClipUI();
  } else if (isDraggingRight) {
    const deltaX = e.clientX - dragStartX;
    const deltaSec = pxToSec(deltaX);
    clipEnd = dragStartClipEnd + deltaSec;
    if (clipEnd <= clipStart) clipEnd = clipStart + 0.1;
    adjustClipLength();
    clampClipToWindow();
    updateClipUI();
  } else if (isDraggingRange) {
    const deltaX = e.clientX - dragStartX;
    const deltaSec = pxToSec(deltaX);
    clipStart = dragStartClipStart + deltaSec;
    clipEnd = dragStartClipEnd + deltaSec;
    clampClipToWindow();
    updateClipUI();
  }
});

document.addEventListener("mouseup", () => {
  if (isDraggingLeft || isDraggingRight || isDraggingRange) {
    isDraggingLeft = false;
    isDraggingRight = false;
    isDraggingRange = false;
    finalizeClipChange();
    // 再生位置を黄色枠の先頭に更新
    player.currentTime(clipStart);
  }
});

// ============================
// 赤い再生インジケーターのドラッグ操作
// ============================

currentIndicator.addEventListener("mousedown", (e) => {
  e.preventDefault();
  isDraggingIndicator = true;
});

document.addEventListener("mousemove", (e) => {
  if (!isDraggingIndicator) return;
  const timelineRect = timelineContainer.getBoundingClientRect();
  let x = e.clientX - timelineRect.left;
  x = Math.max(0, Math.min(x, timelineContainer.offsetWidth));
  currentIndicator.style.left = x + "px";
  // タイムライン上の位置から再生時間へ変換（秒単位）
  const newTime = timelineWindowStart + pxToSec(x);
  // ドラッグ中、常に videojs の再生位置に反映
  //player.currentTime(newTime);
});

document.addEventListener("mouseup", (e) => {
  if (!isDraggingIndicator) return;
  isDraggingIndicator = false;
  const timelineRect = timelineContainer.getBoundingClientRect();
  let x = e.clientX - timelineRect.left;
  x = Math.max(0, Math.min(x, timelineContainer.offsetWidth));
  const newTime = timelineWindowStart + pxToSec(x);
  player.currentTime(newTime);
});

// ============================
// 動画のメタデータ読み込み後の初期設定
// ============================
player.on("loadedmetadata", () => {
  videoDuration = player.duration();
  let viewDuration =
    videoDuration > VIEW_DURATION_MAX ? VIEW_DURATION_MAX : videoDuration;
  // 初期タイムラインウィンドウは動画先頭から
  timelineWindowStart = 0;
  timelineWindowEnd = viewDuration;
  pxPerSec =
    timelineContainer.offsetWidth / (timelineWindowEnd - timelineWindowStart);
  // 初期クリップはウィンドウの先頭からMIN_CLIP_LENGTH秒
  clipStart = timelineWindowStart;
  if (videoDuration > 15) {
    clipEnd = 15; // 15秒以上の動画の場合、初期クリップを15秒に設定
  } else {
    clipEnd = Math.min(clipStart + MIN_CLIP_LENGTH, timelineWindowEnd);
  }
  updateClipUI();
});

// シークバー移動時にタイムラインを更新
player.on("seeked", () => {
  updateTimelineWindow(player.currentTime());
  updateCurrentIndicator();
  const currentTime = player.currentTime();
  if (currentTime < clipStart || currentTime > clipEnd) {
    let clipLength = clipEnd - clipStart;
    clipStart = currentTime;
    clipEnd = clipStart + clipLength;
    clampClipToWindow();
    updateClipUI();
  }
});

// 再生中の timeupdate イベントで赤いインジケーターを更新
player.on("timeupdate", () => {
  updateCurrentIndicator();
});

// スペースキーを押した際に videojs プレイヤーの再生/停止を切り替える
document.addEventListener("keydown", (e) => {
  // event.code が "Space" ならばスペースキーが押されたと認識
  if (e.code === "Space") {
    // スペースキーが既定のスクロール動作などを発生させないように preventDefault()
    e.preventDefault();
    // プレイヤーの再生状態を確認して切り替え
    if (player.paused()) {
      player.play();
    } else {
      player.pause();
    }
  }
});

// クリップ範囲をコンソール出力するボタンの処理
// logRangeBtn.addEventListener('click', () => {
//     console.log(`Clip Range: start=${clipStart}, end=${clipEnd}`);
// });

const dropArea = document.getElementById("dropArea");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");

// ファイルの処理（ファイル名とサイズを表示）
function handleFile(file) {
  if (!file) return;
  const fileURL = URL.createObjectURL(file);

  // Video.js のプレイヤーに新しいソースを設定する
  player.src({ type: file.type, src: fileURL });
  player.load(); // 新しいソースを読み込み
  player.play(); // 自動再生（必要に応じて）

  const mainContainer = document.getElementById("main-extension-container");
  mainContainer.style.display = "block";
  const preContainer = document.getElementById("pre-extension-container");
  preContainer.style.display = "none";

  fileInfo.textContent = `選択されたファイル: ${file.name} (サイズ: ${(
    file.size /
    1024 /
    1024
  ).toFixed(2)} MB)`;
}

// ドラッグ＆ドロップの実装
dropArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropArea.classList.add("dragover");
});

dropArea.addEventListener("dragleave", () => {
  dropArea.classList.remove("dragover");
});

dropArea.addEventListener("drop", (e) => {
  e.preventDefault();
  dropArea.classList.remove("dragover");

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type.startsWith("video/")) {
      handleFile(file);
    } else {
      fileInfo.textContent = "動画ファイルをドロップしてください。";
    }
  }
});

// ファイル選択ダイアログでの選択
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    if (file.type.startsWith("video/")) {
      handleFile(file);
    } else {
      fileInfo.textContent = "動画ファイルを選択してください。";
    }
  }
});

const logRangeBtn = document.getElementById("log-range-btn");
const statusBox = document.getElementById("status-box");

logRangeBtn.addEventListener("click", async () => {
  logRangeBtn.disabled = true;
  logRangeBtn.style.display = "none";
  statusBox.innerHTML = 'Encoding… <span class="spinner"></span>';
  statusBox.style.display = "block";

  console.log(`Clip Range: start=${clipStart}, end=${clipEnd}`);

  const file = document.getElementById("fileInput").files[0];
  if (!file) {
    alert("Please select a file");
    return;
  }

  const inputFileName = file.name;
  const outputFileName = "easy-clip-video-" + file.name;
  const command =
    "ffmpeg -i " +
    inputFileName +
    " -ss " +
    clipStart +
    " -to " +
    clipEnd +
    " -c:v libx264 " +
    "-threads 4 " +
    "-profile:v high " +
    "-level:v 4.0 " +
    "-preset fast " +
    "-b:v 5000k " +
    "-maxrate 5000k " +
    "-bufsize 10000k " +
    "-vf scale=1280:720,format=yuv420p " +
    "-c:a aac " +
    "-b:a 128k " +
    "-ac 2 " +
    outputFileName;

  try {
    await runFFmpeg(
      inputFileName,
      outputFileName,
      command,
      file,
      clipEnd - clipStart
    );

    startCountdownAndClose("Download complete!");
  } catch (e) {
    console.error(e);
    startCountdownAndClose("Failed to encoding.");
  }
});

function startCountdownAndClose(text) {
  let counter = 5;
  const tick = () => {
    statusBox.textContent = text + ` Closing this window in ${counter} s…`;
    if (counter-- === 0) {
      clearInterval(timer);
      window.close(); 
    }
  };
  tick(); 
  const timer = setInterval(tick, 1000);
}

class VideoProgress {
  /**
   * @param {HTMLElement} container  — .video-progress を持つ要素
   * @param {number} clipDuration     — クリップ全体の秒数
   */
  constructor(container, clipDuration) {
    this.container = container;
    this.bar = document.createElement("div");
    this.info = document.createElement("div");

    this.bar.className = "video-progress__bar";
    this.info.className = "video-progress__info";
    container.appendChild(this.bar);
    container.appendChild(this.info);

    this.clipDuration = clipDuration;
  }

  /**
   * @param {{time: number}} progress — time はマイクロ秒単位
   */
  update({ time }) {
    const seconds = time / 1_000_000;
    const percent = Math.min((seconds / this.clipDuration) * 100, 100);

    this.bar.style.width = percent + "%";
    this.info.textContent = `${percent.toFixed(1)}% • ${seconds.toFixed(2)}s`;
  }
}
