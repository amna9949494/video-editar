/* ==========================================================================
   api.js – backend communication layer

   Exposes a single global: window.VideoAPI
     VideoAPI.config                     – editable settings
     VideoAPI.generateVideo(options)     – submit a job and resolve with { videoUrl }
     VideoAPI.downloadVideo(url, name)   – save a generated video

   Mock mode is ON by default so the UI works offline from index.html.
   To connect your real backend, set USE_MOCK to false and point BASE_URL at it.

   Expected backend contract (adapt the field names below if yours differ):
     POST {BASE_URL}/api/generate   multipart/form-data
          fields: prompt, aspect_ratio ("16:9"), duration (seconds), image (optional file)
          returns: { "job_id": "abc123" }
     GET  {BASE_URL}/api/jobs/:id
          returns: { "status": "queued" | "processing" | "completed" | "failed",
                     "progress": 0-100 (optional),
                     "video_url": "https://..." (when completed),
                     "error": "message" (when failed) }
   ========================================================================== */

(function (global) {
  'use strict';

  const API_CONFIG = {
    USE_MOCK: true,
    BASE_URL: 'https://your-backend.example.com',
    ENDPOINTS: {
      generate: '/api/generate',
      job: (id) => `/api/jobs/${encodeURIComponent(id)}`,
    },
    POLL_INTERVAL_MS: 2500,
    TIMEOUT_MS: 15 * 60 * 1000, // give up after 15 minutes
  };

  // Placeholder clips used by mock mode only.
  const SAMPLE_VIDEOS = [
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  ];

  /* ------------------------------ helpers -------------------------------- */

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const abortError = () => new DOMException('Generation cancelled', 'AbortError');

  /** Promise-based sleep that rejects immediately if the signal aborts. */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function endpoint(path) {
    return API_CONFIG.BASE_URL.replace(/\/+$/, '') + path;
  }

  async function toApiError(response) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.detail || data.error || data.message || '';
    } catch (_) { /* response had no JSON body */ }
    return new ApiError(detail || `The server responded with status ${response.status}.`, response.status);
  }

  /* ----------------------------- real backend ---------------------------- */

  async function submitJob({ prompt, image, aspectRatio, duration, signal }) {
    const body = new FormData();
    body.append('prompt', prompt);
    body.append('aspect_ratio', aspectRatio);
    body.append('duration', String(duration));
    if (image) body.append('image', image, image.name);

    let response;
    try {
      response = await fetch(endpoint(API_CONFIG.ENDPOINTS.generate), { method: 'POST', body, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError('Could not reach the server. Check your connection and try again.');
    }
    if (!response.ok) throw await toApiError(response);

    const data = await response.json();
    if (!data.job_id) throw new ApiError('The server did not return a job ID.');
    return data.job_id;
  }

  async function fetchJob(jobId, signal) {
    const response = await fetch(endpoint(API_CONFIG.ENDPOINTS.job(jobId)), { signal });
    if (!response.ok) throw await toApiError(response);
    return response.json();
  }

  async function pollJob(jobId, { onProgress, signal }) {
    const startedAt = Date.now();
    while (true) {
      if (Date.now() - startedAt > API_CONFIG.TIMEOUT_MS) {
        throw new ApiError('Generation took too long. Please try again.');
      }
      const job = await fetchJob(jobId, signal);

      if (onProgress) {
        onProgress({
          status: job.status,
          progress: typeof job.progress === 'number' ? job.progress : null,
        });
      }
      if (job.status === 'completed') {
        if (!job.video_url) throw new ApiError('The job finished without a video URL.');
        return { videoUrl: job.video_url };
      }
      if (job.status === 'failed') {
        throw new ApiError(job.error || 'Video generation failed.');
      }
      await sleep(API_CONFIG.POLL_INTERVAL_MS, signal);
    }
  }

  async function realGenerate(options) {
    const jobId = await submitJob(options);
    return pollJob(jobId, options);
  }

  /* -------------------------------- mock --------------------------------- */

  let sampleCursor = 0;

  /**
   * Simulates a ~8 second generation.
   * Tip: include "#fail" in a prompt to test the error state.
   */
  async function mockGenerate({ prompt, signal, onProgress, startAt = 0 }) {
    let progress = startAt;
    if (onProgress) onProgress({ status: 'queued', progress });
    await sleep(900, signal);

    while (progress < 100) {
      progress = Math.min(100, progress + 2 + Math.random() * 5);
      if (onProgress) onProgress({ status: 'processing', progress: Math.round(progress) });

      if (/#fail/i.test(prompt) && progress > 55) {
        throw new ApiError('The model ran out of GPU memory. Try a shorter duration.');
      }
      await sleep(350, signal);
    }

    const videoUrl = SAMPLE_VIDEOS[sampleCursor++ % SAMPLE_VIDEOS.length];
    return { videoUrl };
  }

  /* ------------------------------ public API ----------------------------- */

  /**
   * @param {Object}      options
   * @param {string}      options.prompt
   * @param {File|null}   options.image        optional reference image (image-to-video)
   * @param {string}      options.aspectRatio  "16:9" | "9:16" | "1:1"
   * @param {number}      options.duration     seconds
   * @param {AbortSignal} [options.signal]
   * @param {Function}    [options.onProgress] ({ status, progress }) => void
   * @param {number}      [options.startAt]    mock only: initial progress
   * @returns {Promise<{ videoUrl: string }>}
   */
  function generateVideo(options) {
    return API_CONFIG.USE_MOCK ? mockGenerate(options) : realGenerate(options);
  }

  /** Downloads via blob when CORS allows it, otherwise opens the video in a new tab. */
  async function downloadVideo(url, filename = 'frameflow-video.mp4') {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
      return true;
    } catch (_) {
      window.open(url, '_blank', 'noopener');
      return false;
    }
  }

  global.VideoAPI = { config: API_CONFIG, generateVideo, downloadVideo, ApiError };
})(window);
