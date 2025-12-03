# WebGPU 2x2 Video Grid Demo

This folder contains a minimal browser demo that:

- Streams four sample H.264 MP4 files from the public dataset curated in [jsturgis' public test videos gist](https://gist.github.com/jsturgis/3b19447b304616f18657).
- Keeps decoding on the client (Chrome/WebCodecs) and uploads frames to WebGPU via `GPUDevice.importExternalTexture`, so frames stay in GPU memory (no CPU copy round-trips).
- Applies a BT.709 transfer-function decode/encode pass in WGSL before emitting RGBA, approximating the color conversion stage you would need before compositing overlays.
- Reads every input (video quads + overlay pages) from `compose.json`, so you can describe `{url, x, y, width, height, crop, alpha, rotationDegrees, zoom, zIndex}` declaratively.
- Runs the renderer on a fixed 1920×1080@60 fps timeline using WebCodecs timestamps; lower-fps inputs are upsampled by repeating frames on the 60 Hz clock until a new frame arrives.
- Supports multiple “master downstream key” (MDSK) overlay pages; call `setOverlayPage('overlay-id')` in DevTools or pass `?overlay=overlay-id` in the URL to swap between layered alpha graphics.
- Honors per-layer timelines (`time.in`/`time.out` in seconds). Outside the active window the layer is skipped, so you can program segments or default to black frames when nothing is scheduled.

## Running Locally

1. Serve this directory over HTTPS (required for WebGPU & cross-origin MP4s). For development you can use [`mkcert`](https://github.com/FiloSottile/mkcert) certificates or rely on Chrome's `--allow-insecure-localhost`.

   ```bash
   cd /home/jp/git/web-render/src
   npx http-server -S -C /path/to/cert.pem -K /path/to/key.pem
   ```

   Alternatively, use `npx serve --ssl-cert ...` or your preferred HTTPS dev server.

2. Open `https://localhost:8080` (or whatever port you choose) in a Chromium browser with WebGPU enabled (Chrome 121+ ships it by default; otherwise enable `chrome://flags/#enable-unsafe-webgpu`).

3. You should see the four mp4 streams filling the canvas. Open DevTools console to inspect logs coming from `src/main.js`.

## Structure

| File            | Purpose                                                                 |
|-----------------|-------------------------------------------------------------------------|
| `index.html`    | Bootstrap markup + canvas + status log.                                 |
| `main.js`       | Sets up WebGPU, drives the 60 fps timeline, loads inputs/overlays from JSON, and composes layers. |
| `shaders.wgsl`  | Vertex + fragment shader pair. Fragment stage performs BT.709 → sRGB and applies per-layer alpha. |
| `compose.json`  | Declarative scene description (canvas size/fps/duration, base video inputs, overlay pages with alpha + timelines).      |

## Notes & Next Steps

- This is purely a rendering stub: overlays/text/etc. can be drawn by extending the WGSL pipeline or adding additional render passes.
- For production you'd swap the sample MP4 loader for your own transport (WHIP/WebRTC, WebTransport + fMP4, etc.); the zero-copy texture import + timestamp resampler stay the same.
- The BT.709 transfer conversion here focuses on the gamma curve. If you need full YUV→RGB matrix math (e.g., NV12 planes), reuse the WGSL from `smelter-render/src/wgpu/format/nv12_to_rgba.wgsl`.
- Flowics or any other HTML graphics system can feed the overlay slots as long as it produces a video stream (e.g., WebM with alpha) or image sequence accessible via HTTPS.
- Timeline scheduling lives entirely in JSON—set `time.in/out` on any layer to determine when it appears. Unscheduled intervals render only the background color (black frame equivalent), matching downstream-key expectations.

