const CONFIG_URL = window.__WEBGPU_CONFIG_URL__ || './compose.json';
const LAYOUT_STRIDE = 256; // conservatively matches minUniformBufferOffsetAlignment for most GPUs
const LAYOUT_FLOAT_BYTES = 48; // 12 floats per layout block (see shaders_v2.wgsl)
const DEFAULT_MSAA_SAMPLE_COUNT = 4;

// Simple A/B switches controllable via URL params, e.g.:
//   ?msaa=0&maxVideos=4&overlays=0&htmlOverlay=0
const urlParams = new URLSearchParams(window.location.search);
const DEBUG_FLAGS = {
  msaa: (urlParams.get('msaa') ?? '1') !== '0',
  enableVideos: (urlParams.get('videos') ?? '1') !== '0',
  maxVideoLayers: parseInt(urlParams.get('maxVideos') || '0', 10) || 0,
  enableOverlays: (urlParams.get('overlays') ?? '1') !== '0',
  enableHtmlOverlay: (urlParams.get('htmlOverlay') ?? '1') !== '0',
};
const MSAA_SAMPLE_COUNT = DEBUG_FLAGS.msaa ? DEFAULT_MSAA_SAMPLE_COUNT : 1;

console.log('WebGPU debug flags', DEBUG_FLAGS);

const recordButton = document.getElementById('record-button');

const canvas = document.getElementById('viewport');
const htmlOverlayFrame = document.getElementById('html-overlay-frame');
const logEl = document.getElementById('log');

function log(message) {
  const now = new Date().toISOString();
  logEl.textContent += `[${now}] ${message}\n`;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizeCrop(crop) {
  if (!crop) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  if (Array.isArray(crop)) {
    const [x0, y0, x1, y1] = crop;
    return {
      x: clamp01(x0),
      y: clamp01(y0),
      width: Math.max(clamp01((x1 ?? 1) - (x0 ?? 0)), 0.0001),
      height: Math.max(clamp01((y1 ?? 1) - (y0 ?? 0)), 0.0001),
    };
  }
  return {
    x: clamp01(crop.x ?? 0),
    y: clamp01(crop.y ?? 0),
    width: Math.max(clamp01(crop.width ?? 1), 0.0001),
    height: Math.max(clamp01(crop.height ?? 1), 0.0001),
  };
}

function normalizeTimeline(time, defaultDuration) {
  const defaultOut = defaultDuration ?? 30;
  if (!time) {
    return { in: 0, out: defaultOut };
  }
  const start = Math.max(0, time.in ?? 0);
  const stop = Math.max(start, time.out ?? defaultOut);
  return { in: start, out: stop };
}

function isLayerActive(layer, timelineSeconds) {
  if (!layer.timeline) {
    return true;
  }
  return timelineSeconds >= layer.timeline.in && timelineSeconds <= layer.timeline.out;
}

class FrameResampler {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.video = null;
    this.reader = null;
    this.buffer = [];
    this.offsetUs = undefined;
    this.maxBufferLength = 4;
    this.lastPresented = null;
    this.readyPromise = null;
    this.aspect = null;
  }

  async init() {
    if (!window.MediaStreamTrackProcessor) {
      throw new Error('MediaStreamTrackProcessor is required for timestamp-aware playback.');
    }

    this.video = document.createElement('video');
    this.video.src = this.descriptor.url;
    this.video.crossOrigin = 'anonymous';
    this.video.loop = this.descriptor.loop ?? true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';

    this.readyPromise = new Promise((resolve, reject) => {
      const onError = (event) => reject(event?.error || new Error(`Failed to load ${this.descriptor.url}`));
      this.video.addEventListener('error', onError, { once: true });
      this.video.addEventListener(
        'loadeddata',
        async () => {
          try {
            await this.video.play();
            const vw = this.video.videoWidth || 0;
            const vh = this.video.videoHeight || 0;
            if (vw > 0 && vh > 0) {
              this.aspect = vw / vh;
            }
            const stream = this.video.captureStream();
            const [track] = stream.getVideoTracks();
            if (!track) {
              throw new Error('captureStream() did not provide a video track');
            }
            const processor = new MediaStreamTrackProcessor({ track });
            this.reader = processor.readable.getReader();
            this.#pump();
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        { once: true }
      );
    });

    return this.readyPromise;
  }

  isReady() {
    return this.reader !== null;
  }

  getAspect() {
    return this.aspect;
  }

  async #pump() {
    if (!this.reader) {
      return;
    }
    const { value, done } = await this.reader.read();
    if (done || !value) {
      return;
    }
    this.#enqueue(value);
    this.#pump();
  }

  #enqueue(frame) {
    if (this.offsetUs === undefined) {
      this.offsetUs = -frame.timestamp;
    }

    const pts = frame.timestamp + this.offsetUs;
    this.buffer.push({ frame, pts });

    while (this.buffer.length > this.maxBufferLength) {
      const evicted = this.buffer.shift();
      if (!evicted) {
        break;
      }
      if (this.lastPresented && evicted.frame === this.lastPresented.frame) {
        // keep the last presented frame alive until a newer one is displayed
        this.buffer.unshift(evicted);
        break;
      }
      evicted.frame.close();
    }
  }

  getFrame(targetPtsUs) {
    if (!this.buffer.length) {
      return null;
    }

    let candidate = this.buffer[0];
    for (const slot of this.buffer) {
      if (slot.pts <= targetPtsUs) {
        candidate = slot;
      } else {
        break;
      }
    }
    if (this.lastPresented && this.lastPresented !== candidate && !this.buffer.includes(this.lastPresented)) {
      this.lastPresented.frame.close();
    }
    this.lastPresented = candidate;
    return candidate.frame;
  }

  dispose() {
    if (this.reader) {
      this.reader.releaseLock();
      this.reader = null;
    }
    this.buffer.forEach(({ frame }) => frame.close());
    this.buffer = [];
    if (this.video) {
      this.video.pause();
      this.video.src = '';
      this.video.remove();
      this.video = null;
    }
  }
}

class ImageOverlaySource {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.frame = null;
    this.readyPromise = null;
  }

  async init() {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = this.descriptor.url;
    await image.decode();
    const bitmap = await createImageBitmap(image);
    this.frame = new VideoFrame(bitmap, { timestamp: 0 });
    bitmap.close();
  }

  isReady() {
    return Boolean(this.frame);
  }

  getFrame() {
    return this.frame;
  }

  dispose() {
    this.frame?.close();
    this.frame = null;
  }
}

function buildLayoutBlock(entry, canvasWidth, canvasHeight) {
  const widthNorm = entry.width ?? 1;
  const heightNorm = entry.height ?? 1;
  const xNorm = entry.x ?? 0;
  const yNorm = entry.y ?? 0;

  const widthPx = widthNorm * canvasWidth;
  const heightPx = heightNorm * canvasHeight;
  const centerX = xNorm * canvasWidth + widthPx / 2;
  const centerY = yNorm * canvasHeight + heightPx / 2;

  const translateX = (centerX / canvasWidth) * 2 - 1;
  const translateY = 1 - (centerY / canvasHeight) * 2;
  const scaleX = widthPx / canvasWidth;
  const scaleY = heightPx / canvasHeight;

  // Base crop window in normalized UVs.
  const baseCrop = normalizeCrop(entry.crop);

  // Optional content zoom: zoom > 1.0 zooms in around the crop center (e.g. 2.0 = 200%).
  const zoom =
    entry.zoom ?? entry.contentZoom ?? entry.contentScale ?? entry.scale ?? 1;
  const zoomClamped = Math.max(zoom, 0.0001);
  let crop = baseCrop;
  if (zoomClamped !== 1) {
    const centerU = baseCrop.x + baseCrop.width / 2;
    const centerV = baseCrop.y + baseCrop.height / 2;
    const zoomedWidth = baseCrop.width / zoomClamped;
    const zoomedHeight = baseCrop.height / zoomClamped;
    crop = {
      width: zoomedWidth,
      height: zoomedHeight,
      x: clamp01(centerU - zoomedWidth / 2),
      y: clamp01(centerV - zoomedHeight / 2),
    };
  }
  const rotationDegrees =
    entry.rotationDegrees ?? entry.rotate ?? entry.rotation ?? 0;
  const rotationRadians = (rotationDegrees * Math.PI) / 180;
  const data = new Float32Array(12);
  data.set(
    [
      scaleX,
      scaleY,
      translateX,
      translateY,
      crop.width,
      crop.height,
      crop.x,
      crop.y,
      clamp01(entry.alpha ?? 1),
      rotationRadians,
      0,
      0,
    ],
    0
  );
  return data;
}

function applyLayoutBlocks(device, buffer, layers, canvasWidth, canvasHeight) {
  if (!layers.length) {
    return;
  }
  layers.forEach((layer, index) => {
    layer.dynamicOffset = index * LAYOUT_STRIDE;
    const layout = buildLayoutBlock(layer.layout, canvasWidth, canvasHeight);
    device.queue.writeBuffer(buffer, layer.dynamicOffset, layout.buffer, layout.byteOffset, layout.byteLength);
  });
}

async function createVideoLayers(entries, defaultDurationSeconds) {
  const layers = [];
  const sourceCache = new Map();

  for (const entry of entries) {
    const key = JSON.stringify({
      url: entry.url,
      loop: entry.loop ?? true,
    });

    let cached = sourceCache.get(key);
    if (!cached) {
      const source = new FrameResampler(entry);
      const initPromise = source.init();
      cached = { source, initPromise };
      sourceCache.set(key, cached);
    }

    await cached.initPromise;
    const source = cached.source;
    const aspect = typeof source.getAspect === 'function' ? source.getAspect() : null;

    layers.push({
      id: entry.id ?? crypto.randomUUID(),
      kind: 'video',
      source,
      layout: {
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height,
        crop: entry.crop,
        alpha: entry.alpha ?? 1,
        zoom: entry.zoom ?? entry.contentZoom ?? entry.contentScale ?? entry.scale ?? 1,
        rotationDegrees: entry.rotationDegrees ?? entry.rotate ?? entry.rotation ?? 0,
        contentAspect: aspect ?? null,
      },
      zIndex: entry.zIndex ?? 0,
      timeline: normalizeTimeline(entry.time, defaultDurationSeconds),
    });
  }

  return layers;
}

async function createOverlayPage(page, defaultDurationSeconds) {
  const layers = [];
  for (const layer of page.layers ?? []) {
    let source = null;
    if (layer.type === 'image') {
      source = new ImageOverlaySource(layer);
      await source.init();
    } else {
      source = new FrameResampler(layer);
      await source.init();
    }
    layers.push({
      id: layer.id ?? crypto.randomUUID(),
      kind: layer.type ?? 'video',
      source,
      layout: {
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        crop: layer.crop,
        alpha: layer.alpha ?? 1,
        zoom: layer.zoom ?? layer.contentZoom ?? layer.contentScale ?? layer.scale ?? 1,
        rotationDegrees: layer.rotationDegrees ?? layer.rotate ?? layer.rotation ?? 0,
      },
      zIndex: layer.zIndex ?? 10,
      timeline: normalizeTimeline(layer.time, defaultDurationSeconds),
    });
  }
  return { id: page.id, layers };
}

function composeLayers(videoLayers, overlayPages, activePageId) {
  const activePage =
    overlayPages.find((page) => page.id === activePageId) ??
    (overlayPages.length ? overlayPages[0] : { layers: [] });
  return [...videoLayers, ...(activePage.layers ?? [])].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

async function main() {
  if (!navigator.gpu) {
    log('WebGPU is not available. Enable chrome://flags/#enable-unsafe-webgpu');
    return;
  }
  if (!window.MediaStreamTrackProcessor) {
    log('MediaStreamTrackProcessor API is missing. Use latest Chrome.');
    return;
  }

  const config = await fetch(CONFIG_URL).then((res) => res.json());
  const canvasWidth = config.canvas?.width ?? 1920;
  const canvasHeight = config.canvas?.height ?? 1080;
  const targetFps = config.canvas?.fps ?? 60;
  const defaultTimelineSeconds = config.canvas?.duration ?? 30;
  const recordingConfig = config.recording ?? {};
  const recordingDurationSeconds = recordingConfig.duration ?? defaultTimelineSeconds;
  const recordingFps = recordingConfig.fps ?? targetFps;
  const recordingBitsPerSecond =
    recordingConfig.videoBitsPerSecond ??
    recordingConfig.bitrate ??
    recordingConfig.videoBitrate ??
    null;
  const recordingCodec = (recordingConfig.codec || '').toLowerCase() || null;
  const frameIntervalMs = 1000 / targetFps;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    log('Failed to acquire GPU adapter.');
    return;
  }
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
    alphaMode: 'opaque',
  });

  // Multisampled color buffer for anti-aliased geometry (e.g., rotated quads).
  let msaaColorTexture = null;
  let msaaColorView = null;
  if (MSAA_SAMPLE_COUNT > 1) {
    msaaColorTexture = device.createTexture({
      size: { width: canvasWidth, height: canvasHeight },
      sampleCount: MSAA_SAMPLE_COUNT,
      format: presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    msaaColorView = msaaColorTexture.createView();
  }

  // Recording: capture the canvas stream and dump a WebM matching the configured duration.
  if (recordButton) {
    recordButton.disabled = false;
    recordButton.addEventListener('click', () => {
      if (recordButton.disabled) {
        return;
      }

      let mimeTypes;
      if (recordingCodec === 'vp9') {
        mimeTypes = ['video/webm;codecs=vp9'];
      } else if (recordingCodec === 'vp8') {
        mimeTypes = ['video/webm;codecs=vp8'];
      } else {
        mimeTypes = [
          'video/webm;codecs=vp9',
          'video/webm;codecs=vp8',
          'video/webm',
        ];
      }
      const supportedMime = mimeTypes.find((type) =>
        window.MediaRecorder && MediaRecorder.isTypeSupported(type)
      );
      if (!supportedMime) {
        log('MediaRecorder WebM is not supported in this browser.');
        return;
      }

      const stream = canvas.captureStream(recordingFps);
      const recorderOptions = { mimeType: supportedMime };
      if (recordingBitsPerSecond) {
        recorderOptions.videoBitsPerSecond = recordingBitsPerSecond;
      }
      const recorder = new MediaRecorder(stream, recorderOptions);
      const chunks = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: supportedMime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'webgpu-composition.webm';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        recordButton.disabled = false;
        recordButton.textContent = 'Record WebM';
        log(`Saved WebM recording (${(blob.size / (1024 * 1024)).toFixed(2)} MiB).`);
      };

      recorder.onerror = (event) => {
        console.error('MediaRecorder error', event.error);
        log(`MediaRecorder error: ${event.error?.message ?? String(event.error)}`);
        recordButton.disabled = false;
        recordButton.textContent = 'Record WebM';
      };

      const durationMs = recordingDurationSeconds * 1000;
      recordButton.disabled = true;
      recordButton.textContent = 'Recording…';
      recorder.start();
      log(`Started WebM recording for ${(durationMs / 1000).toFixed(1)}s at ${recordingFps} fps${recordingBitsPerSecond ? `, ~${(recordingBitsPerSecond / 1_000_000).toFixed(1)} Mbps` : ''}.`);
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, durationMs);
    });
  }

  const shaderCode = await fetch(`./shaders_v2.wgsl?v=${crypto.randomUUID()}`).then((res) => res.text());
  const shaderModule = device.createShaderModule({ code: shaderCode });

  const vertexData = new Float32Array([
    -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
  ]);
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData.buffer);

  log('Loading video grid via WebCodecs…');
  let videoEntries = config.videos ?? [];
  if (!DEBUG_FLAGS.enableVideos) {
    videoEntries = [];
    log('DEBUG: Video layers disabled via ?videos=0');
  } else if (DEBUG_FLAGS.maxVideoLayers > 0 && videoEntries.length > DEBUG_FLAGS.maxVideoLayers) {
    videoEntries = videoEntries.slice(0, DEBUG_FLAGS.maxVideoLayers);
    log(`DEBUG: Limiting video layers to first ${DEBUG_FLAGS.maxVideoLayers}`);
  }
  const videoLayers = await createVideoLayers(videoEntries, defaultTimelineSeconds);
  log('Base video layers ready.');

  const htmlOverlayConfig =
    DEBUG_FLAGS.enableHtmlOverlay && config.htmlOverlay
      ? {
          ...config.htmlOverlay,
          timeline: normalizeTimeline(config.htmlOverlay.time, defaultTimelineSeconds),
        }
      : null;

  if (htmlOverlayConfig && htmlOverlayFrame) {
    htmlOverlayFrame.src = htmlOverlayConfig.url;
    htmlOverlayFrame.style.opacity = '0';
  }

  const overlayPages = [];
  if (DEBUG_FLAGS.enableOverlays) {
    for (const page of config.overlayPages ?? []) {
      overlayPages.push(await createOverlayPage(page, defaultTimelineSeconds));
    }
  }
  if (overlayPages.length) {
    log(`Overlay pages loaded: ${overlayPages.map((p) => p.id).join(', ')}`);
  }

  const overlayParam = new URLSearchParams(window.location.search).get('overlay');
  let activeOverlayPageId = overlayParam ?? overlayPages[0]?.id ?? null;

  let layers = composeLayers(videoLayers, overlayPages, activeOverlayPageId);
  let layoutBufferSize = Math.max(1, layers.length) * LAYOUT_STRIDE;
  const layoutBuffer = device.createBuffer({
    size: layoutBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  applyLayoutBlocks(device, layoutBuffer, layers, canvasWidth, canvasHeight);

  function rebuildLayers(pageId) {
    layers = composeLayers(videoLayers, overlayPages, pageId);
    const requiredSize = Math.max(1, layers.length) * LAYOUT_STRIDE;
    if (layoutBufferSize < requiredSize) {
      log('Overlay switch requires reallocation; reload page to take effect.');
      return;
    }
    applyLayoutBlocks(device, layoutBuffer, layers, canvasWidth, canvasHeight);
  }

  window.setOverlayPage = (pageId) => {
    if (!overlayPages.find((page) => page.id === pageId)) {
      log(`Overlay page "${pageId}" not found.`);
      return;
    }
    activeOverlayPageId = pageId;
    rebuildLayers(pageId);
    log(`Switched overlay page to ${pageId}`);
  };

  const layoutBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true },
      },
    ],
  });
  const textureBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutBindGroupLayout, textureBindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: 'vsMain',
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fsMain',
      targets: [
        {
          format: presentationFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
    multisample: {
      count: MSAA_SAMPLE_COUNT,
    },
  });

  const layoutBindGroup = device.createBindGroup({
    layout: layoutBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: layoutBuffer, offset: 0, size: LAYOUT_FLOAT_BYTES } }],
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  const timelineOriginMs = performance.now();
  let lastFrameIndex = -1;

  function renderFrame(nowMs) {
    const elapsedMs = nowMs - timelineOriginMs;
    const frameIndex = Math.floor(elapsedMs / frameIntervalMs);
    if (frameIndex <= lastFrameIndex) {
      requestAnimationFrame(renderFrame);
      return;
    }
    lastFrameIndex = frameIndex;

    const targetPtsUs = frameIndex * frameIntervalMs * 1000;
    const timelineSeconds = targetPtsUs / 1_000_000;

    const currentTextureView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const colorAttachment = {
      view: MSAA_SAMPLE_COUNT > 1 ? msaaColorView : currentTextureView,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0.015, g: 0.015, b: 0.025, a: 1 },
    };
    if (MSAA_SAMPLE_COUNT > 1) {
      colorAttachment.resolveTarget = currentTextureView;
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [colorAttachment],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);

    if (htmlOverlayConfig && htmlOverlayFrame) {
      const active = isLayerActive(htmlOverlayConfig, timelineSeconds);
      htmlOverlayFrame.style.opacity = active ? String(clamp01(htmlOverlayConfig.alpha ?? 1)) : '0';
    }

    for (const layer of layers) {
      if (!layer.source?.isReady()) {
        continue;
      }
      if (!isLayerActive(layer, timelineSeconds)) {
        continue;
      }
      const frame = layer.source.getFrame(targetPtsUs);
      if (!frame) {
        continue;
      }
      const externalTexture = device.importExternalTexture({ source: frame });
      const textureBindGroup = device.createBindGroup({
        layout: textureBindGroupLayout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: externalTexture },
        ],
      });
      pass.setBindGroup(0, layoutBindGroup, [layer.dynamicOffset]);
      pass.setBindGroup(1, textureBindGroup);
      pass.draw(6, 1, 0, 0);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}

main().catch((error) => {
  console.error(error);
  log(`Fatal error: ${error.message}`);
});
