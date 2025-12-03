# Easy Video Trimmer for X.com

`Easy Video Trimmer for X.com` is a Chrome extension that recreates the legendary Twitter-era feature that let you trim videos directly in your browser and attach them straight to the X.com compose window.

## Features

- Adds a scissors button to the X post composer. You can cut clips in a dedicated trimming UI and attach the resulting MP4 directly to the same compose window. Because you never have to download the processed video file, you don’t end up with extra stray files on your PC.
- Supports drag handles on the timeline, zoom/pan, hover preview, and keyboard controls—similar to popular desktop editing software—so you can fine-tune clips intuitively.
- Privacy-first design that works entirely locally. No network requests are made as part of the video processing pipeline.

## Version

1.1.0.2 (beta)

### Why “beta”?

- [#6](https://github.com/NPJigaK/easy-video-trimmer-for-x/issues/6): In Chromium, ffmpeg.wasm’s parallel processing (threads) is limited to **4 threads**. Using 5 or more causes hangs, so the fallback encoder is fixed to 4 threads.
- Other major issues (encoding without GPU, auto-attaching to the post form) have been resolved by adding WebCodecs support ([#10](https://github.com/NPJigaK/easy-video-trimmer-for-x/pull/10)) and page-side attachment ([#11](https://github.com/NPJigaK/easy-video-trimmer-for-x/pull/11)).

## 🛠️ Installation

### Chrome Web Store

https://chromewebstore.google.com/detail/edpmkohefhijpaoolhkfmlbnbepikmbo?utm_source=item-share-cb

### Manual installation

1. Download (or clone) this repository and unzip it.
2. In Chrome, open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked**, then select the unzipped `easy-video-trimmer-for-x` folder (the directory that contains `manifest.json`).

## 🚀 How to Use

1. Open the X.com compose window.
2. Click the newly added scissors icon.  
   ![UI1](doc/image.jpg)
3. In the popup, drag & drop a video file or select one from your file system.  
   ![UI2](doc/image2.jpg)
4. Use the yellow handles to set the start and end positions, then click **Clip video & attach to X.com** to start trimming and encoding.  
   ![UI3](doc/image3.png)
5. After encoding finishes, the generated MP4 is automatically attached to the X.com compose form. Only if auto-attach fails will the MP4 be downloaded instead.

## ⚙️ Video Specs

The extension follows the [official media best practices](https://developer.x.com/ja/docs/media/upload-media/uploading-media/media-best-practices). Video encoding uses WebCodecs (hardware H.264 / GPU) whenever available, and falls back to ffmpeg.wasm (software H.264 / CPU) when WebCodecs is not supported. Trimming, audio processing, and MP4 muxing are handled by ffmpeg.wasm.

| Item                     | X.com recommended value                                 | Output from this extension (WebCodecs / ffmpeg.wasm)                                                        | Match status       |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------ |
| Video codec              | H.264 High profile                                      | H.264 High@L4.1                                                                                             | OK                 |
| Video bitrate            | 5,000 kbps or higher                                    | 5,000 kbps CBR                                                                                              | OK                 |
| Frame rate               | 30 or 60 FPS, at most 60 FPS                            | Same as source FPS (no explicit upper bound)                                                                | Upper bound needed |
| Resolution               | 1280x720 / 720x1280 / 720x720 (allowed 32x32–1280x1024) | WebCodecs: keeps original aspect ratio, no upscaling, max 720p on each side<br>ffmpeg.wasm: always 1280x720 | Partial            |
| Aspect ratio             | Recommended 16:9 or 1:1 (allowed 1:3–3:1)               | WebCodecs: keeps source aspect ratio<br>ffmpeg.wasm: effectively fixed to 16:9                              | Partial            |
| Pixel format / scan type | YUV 4:2:0, progressive, PAR 1:1                         | 4:2:0, progressive                                                                                          | OK                 |
| Open GOP                 | Not allowed                                             | Closed GOP                                                                                                  | OK                 |
| Audio codec / profile    | AAC LC, mono or stereo                                  | AAC-LC stereo                                                                                               | OK                 |
| Audio bitrate            | 128 kbps or higher                                      | 128 kbps                                                                                                    | OK                 |
| Duration                 | 0.5–140 seconds                                         | UI enforces 1–139 seconds                                                                                   | OK                 |
| File size                | Up to 512 MB                                            | No explicit check (at 5 Mbps + 128 kbps, 139 s ≈ 87 MB)                                                     | Not checked        |

## Contributing

`Easy Video Trimmer for X.com` is a community-driven project. Bug reports, fixes, feature proposals, and documentation improvements are all very welcome.  
Even if you’re new to development, feel free to open an Issue or submit a Pull Request (Drafts are totally fine).  
Detailed contribution guidelines are still a work in progress, but we’d be happy to improve features and overall quality together.

## 📝 License

For details, see [`LICENSE`](LICENSE).

> **Disclaimer**: This extension is an independent open-source project and is not affiliated with or endorsed by X Holdings Corp.
