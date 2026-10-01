/* ══════════════════════════════════════════════════════════════
   api.js — Backend contract & mock implementation
   Wan 2.1 (Text-to-Video / Image-to-Video)
══════════════════════════════════════════════════════════════ */

'use strict';

const API_CONFIG = {
  useMock: true,
  baseUrl: '/api',

  models: {
    textToVideo: 'Wan-AI/Wan2.1-T2V-14B',
    imageToVideo: 'Wan-AI/Wan2.1-I2V-14B-720P',
  },

  pollIntervalMs: 1500,
  timeoutMs: 300_000,

  maxImageBytes: 10 * 1024 * 1024,
  acceptedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],

  /** Duration → credit cost multiplier (used by the UI + backend later). */
  durationCosts: {
    '5s': 1,
    '10s': 2,
    '1m': 12,
    '6m': 72,
  },
};

/* ─────────────── Mock assets ─────────────── */
const MOCK_LIBRARY = [
  {
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    poster: 'https://picsum.photos/seed/lumen-neon/1280/720',
    resolution: '1280×720',
    seed: 428913,
  },
  {
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    poster: 'https://picsum.photos/seed/lumen-ink/1280/720',
    resolution: '1280×720',
    seed: 771204,
  },
  {
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    poster: 'https://picsum.photos/seed/lumen-drone/1280/720',
    resolution: '1280×720',
    seed: 305618,
  },
];

const STAGES = [
  { at: 0,  label: 'Initializing Wan 2.1 pipeline…' },
  { at: 10, label: 'Encoding prompt with T5-XXL…' },
  { at: 24, label: 'Sampling latent noise · step 8/30' },
  { at: 42, label: 'Denoising diffusion · step 18/30' },
  { at: 62, label: 'Temporal attention pass · step 26/30' },
  { at: 80, label: 'Decoding VAE latents…' },
  { at: 92, label: 'Upscaling to 720p & muxing…' },
];

/* ─────────────── Helpers ─────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

function validateImage(file) {
  if (!file) return { ok: false, error: 'No file provided.' };
  if (!API_CONFIG.acceptedImageTypes.includes(file.type)) {
    return { ok: false, error: 'Unsupported format. Use PNG, JPG, WEBP or GIF.' };
  }
  if (file.size > API_CONFIG.maxImageBytes) {
    return { ok: false, error: 'Image exceeds the 10 MB limit.' };
  }
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════
   MOCK GENERATION
══════════════════════════════════════════════════════════════ */
async function mockGenerate({ prompt, imageFile, duration, onProgress, signal }) {
  let progress = 0;
  let stageIndex = 0;

  // Longer durations take longer to "render"
  const durationMultiplier = { '5s': 1, '10s': 1.25, '1m': 1.6, '6m': 2.1 };
  const baseStep = imageFile ? 4.5 : 6;
  const stepSize = baseStep / (durationMultiplier[duration] || 1);

  while (progress < 100) {
    if (signal?.aborted) throw new DOMException('Generation aborted', 'AbortError');

    await sleep(180 + Math.random() * 300);
    progress = Math.min(100, progress + Math.random() * stepSize + 2.5);

    while (stageIndex < STAGES.length - 1 && progress >= STAGES[stageIndex + 1].at) {
      stageIndex += 1;
    }

    onProgress?.(Math.round(progress), STAGES[stageIndex].label);
  }

  onProgress?.(100, 'Finalizing…');
  await sleep(420);

  const asset = pickRandom(MOCK_LIBRARY);
  return {
    ...asset,
    prompt,
    duration,
    mode: imageFile ? 'image-to-video' : 'text-to-video',
    model: imageFile ? API_CONFIG.models.imageToVideo : API_CONFIG.models.textToVideo,
    createdAt: new Date().toISOString(),
  };
}

/* ══════════════════════════════════════════════════════════════
   REAL GENERATION (reference implementation — wire to your proxy)
══════════════════════════════════════════════════════════════ */
async function realGenerate({ prompt, imageFile, duration, onProgress, signal }) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('model', imageFile ? API_CONFIG.models.imageToVideo : API_CONFIG.models.textToVideo);
  form.append('resolution', '720p');
  form.append('duration', duration);          // ← e.g. "5s" | "10s" | "1m" | "6m"
  form.append('aspect_ratio', '16:9');
  if (imageFile) form.append('image', imageFile);

  const startRes = await fetch(`${API_CONFIG.baseUrl}/generate`, {
    method: 'POST',
    body: form,
    signal,
  });
  if (!startRes.ok) throw new Error(`Generation request failed (${startRes.status})`);

  const { jobId } = await startRes.json();
  const startedAt = Date.now();

  while (Date.now() - startedAt < API_CONFIG.timeoutMs) {
    if (signal?.aborted) throw new DOMException('Generation aborted', 'AbortError');
    await sleep(API_CONFIG.pollIntervalMs);

    const statusRes = await fetch(`${API_CONFIG.baseUrl}/status/${jobId}`, { signal });
    if (!statusRes.ok) continue;

    const data = await statusRes.json();
    onProgress?.(data.progress ?? 0, data.stage ?? 'Generating…');

    if (data.status === 'succeeded') return data.result;
    if (data.status === 'failed') throw new Error(data.error || 'Generation failed on the server.');
  }

  throw new Error('Generation timed out. Please try again.');
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */
const VideoAPI = {
  config: API_CONFIG,

  /**
   * Generate a video.
   * @param {Object}   params
   * @param {string}   params.prompt
   * @param {File}     [params.imageFile]
   * @param {string}   [params.duration]   "5s" | "10s" | "1m" | "6m"
   * @param {Function} [params.onProgress] (percent, label) => void
   * @param {AbortSignal} [params.signal]
   */
  async generateVideo({ prompt, imageFile, duration = '5s', onProgress, signal }) {
    if (imageFile) {
      const check = validateImage(imageFile);
      if (!check.ok) throw new Error(check.error);
    }

    if (API_CONFIG.useMock) {
      return mockGenerate({ prompt, imageFile, duration, onProgress, signal });
    }
    return realGenerate({ prompt, imageFile, duration, onProgress, signal });
  },

  /** Read a File into a data URL for instant preview. */
  readImagePreview(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the selected image.'));
      reader.readAsDataURL(file);
    });
  },

  /** Credits cost for a given duration label. */
  getDurationCost(duration) {
    return API_CONFIG.durationCosts[duration] ?? 1;
  },

  /** Fetch quota (stub). */
  async getQuota() {
    if (API_CONFIG.useMock) return { credits: 240, plan: 'Pro' };
    const res = await fetch(`${API_CONFIG.baseUrl}/quota`);
    return res.json();
  },
};

window.VideoAPI = VideoAPI;
