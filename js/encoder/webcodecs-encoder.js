// ============================================================================
// WebCodecs encoder – hardware-accelerated H.264 path
// ----------------------------------------------------------------------------
// Responsibilities:
//   • Feature-detect WebCodecs availability
//   • Decode a trimmed video blob via HTMLVideoElement + captureStream()
//   • Feed frames into VideoEncoder (AVC High @ Level 4.1)
//   • Return a raw H.264 Annex-B Uint8Array plus metadata
// Notes:
//   • Video decoding is handled by the browser (GPU where available).
//   • Video encoding is done by WebCodecs VideoEncoder (hardware-accelerated).
//   • Audio + final muxing are handled by ffmpeg-controller.js
// ============================================================================

const isWebCodecsAvailable =
  "VideoEncoder" in window && "MediaStreamTrackProcessor" in window;

/**
 * Encode a trimmed video Blob to H.264 Annex-B using WebCodecs.
 * @param {Blob} blob - Trimmed video container (mp4) to decode
 * @param {object} opts
 * @param {number} opts.bitrate - target bitrate in bps
 * @returns {Promise<{videoBytes: Uint8Array, framerate: number, width: number, height: number, frameCount: number}>}
 */
async function encodeWithWebCodecs(blob, { bitrate = 5_000_000 } = {}) {
  if (!isWebCodecsAvailable) {
    throw new Error("WebCodecs is not available in this browser.");
  }

  // Prepare a hidden video element for decoding
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(blob);
  video.src = url;
  video.currentTime = 0;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () =>
      reject(new Error("Failed to load trimmed video for WebCodecs."));
  });

  // Clamp to X.com max resolution (720p) while keeping aspect ratio
  const clampDimensions = (width, height) => {
    const maxW = 1280;
    const maxH = 720;
    const scale = Math.min(1, maxW / width, maxH / height);
    return {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    };
  };
  const targetDims = clampDimensions(video.videoWidth, video.videoHeight);
  const needsResize =
    targetDims.width !== video.videoWidth || targetDims.height !== video.videoHeight;
  const resizeCanvas = needsResize
    ? typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(targetDims.width, targetDims.height)
      : Object.assign(document.createElement("canvas"), {
          width: targetDims.width,
          height: targetDims.height,
        })
    : null;
  const resizeCtx = resizeCanvas ? resizeCanvas.getContext("2d") : null;

  // Capture the decoded frames as a stream
  const stream = video.captureStream();
  const track = stream.getVideoTracks()[0];
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();

  const settingsFps = track.getSettings().frameRate;
  const targetFramerate = Math.max(1, Math.round(settingsFps || 30));

  const encodedChunks = [];
  let frameCount = 0;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const out = new Uint8Array(chunk.byteLength);
      chunk.copyTo(out);
      encodedChunks.push(out);
    },
    error: (err) => {
      console.error("VideoEncoder error", err);
      throw err;
    },
  });

  encoder.configure({
    codec: "avc1.640029", // High @ Level 4.1
    width: targetDims.width,
    height: targetDims.height,
    bitrate,
    framerate: targetFramerate,
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "annexb" },
  });

  // Start playback so frames flow through the processor
  await video.play();

  try {
    // Drain frames from the track processor and encode
    while (true) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      frameCount++;
      let frameForEncode = frame;
      if (needsResize && resizeCtx && resizeCanvas) {
        resizeCtx.drawImage(frame, 0, 0, targetDims.width, targetDims.height);
        frameForEncode = new VideoFrame(resizeCanvas, {
          timestamp: frame.timestamp,
        });
      }
      encoder.encode(frameForEncode);
      frame.close();
      if (frameForEncode !== frame) frameForEncode.close();
    }

    await encoder.flush();
    encoder.close();
  } finally {
    // Cleanup capture artifacts
    track.stop();
    video.pause();
    URL.revokeObjectURL(url);
  }

  // Concatenate all encoded chunks
  const total = encodedChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const videoBytes = new Uint8Array(total);
  let offset = 0;
  for (const c of encodedChunks) {
    videoBytes.set(c, offset);
    offset += c.byteLength;
  }

  return {
    videoBytes,
    framerate: targetFramerate,
    width: targetDims.width,
    height: targetDims.height,
    frameCount,
  };
}
