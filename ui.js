/* ==========================================================================
   ui.js – DOM manipulation, chat rendering, uploads, player, loading states
   Depends on api.js (window.VideoAPI) and Lucide (window.lucide).
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ constants ------------------------------ */

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const ALLOWED_TYPES = /^image\/(png|jpe?g|webp)$/i;

  const RATIOS = {
    '16:9': { css: '16 / 9', width: 'max-w-xl' },
    '9:16': { css: '9 / 16', width: 'max-w-[260px]' },
    '1:1': { css: '1 / 1', width: 'max-w-sm' },
  };

  /* -------------------------------- state -------------------------------- */

  const state = {
    messages: [],
    nodes: new Map(),        // message id -> DOM node
    controllers: new Map(),  // ai message id -> AbortController
    pendingFile: null,
    pendingDataUrl: null,
    nextId: 1,
  };

  /* ------------------------------ DOM refs ------------------------------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const els = {
    scroll: $('#chat-scroll'),
    chat: $('#chat'),
    empty: $('#empty-state'),
    form: $('#composer'),
    prompt: $('#prompt'),
    send: $('#send-btn'),
    attachBtn: $('#attach-btn'),
    fileInput: $('#file-input'),
    preview: $('#attach-preview'),
    previewImg: $('#attach-thumb'),
    previewName: $('#attach-name'),
    previewSize: $('#attach-size'),
    removeBtn: $('#attach-remove'),
    ratio: $('#opt-ratio'),
    duration: $('#opt-duration'),
    dropOverlay: $('#drop-overlay'),
    toasts: $('#toasts'),
    newChat: $('#new-chat'),
    modeBadge: $('#mode-badge'),
  };

  /* ------------------------------ utilities ------------------------------ */

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatTime = (seconds) => {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const refreshIcons = () => {
    if (window.lucide) window.lucide.createIcons();
  };

  const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

  const isNearBottom = (threshold = 180) =>
    els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < threshold;

  const scrollToBottom = (smooth = true) => {
    els.scroll.scrollTo({ top: els.scroll.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  /** Generates a small gradient "scene" image so demo data needs no external assets. */
  function sceneThumb(a, b, c) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>` +
      `<radialGradient id="s"><stop offset="0" stop-color="${c}" stop-opacity=".95"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="320" height="320" fill="url(#g)"/><circle cx="220" cy="110" r="90" fill="url(#s)"/>` +
      `<path d="M0 240 L70 170 L120 215 L190 140 L260 220 L320 175 V320 H0Z" fill="rgba(0,0,0,.35)"/></svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  /* -------------------------------- toasts ------------------------------- */

  function toast(message, type = 'info') {
    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' is-error' : ''}`;
    node.innerHTML =
      `<i data-lucide="${type === 'error' ? 'triangle-alert' : 'check'}" class="h-4 w-4 shrink-0 ${type === 'error' ? 'text-red-300' : 'text-violet-300'}"></i>` +
      `<span>${escapeHtml(message)}</span>`;
    els.toasts.appendChild(node);
    refreshIcons();
    setTimeout(() => {
      node.classList.add('is-leaving');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    }, 3800);
  }

  /* --------------------------- message templates ------------------------- */

  function userMessageHTML(m) {
    const mode = m.image ? 'Image to video' : 'Text to video';
    return `
      <div class="flex justify-end">
        <div class="flex max-w-[88%] flex-col items-end gap-2 sm:max-w-[75%]">
          ${m.image ? `<img src="${m.image}" alt="Reference image you uploaded" class="h-24 w-24 rounded-xl object-cover shadow-lg shadow-violet-950/50 ring-1 ring-white/20 sm:h-28 sm:w-28" />` : ''}
          <div class="bubble-user rounded-2xl rounded-br-md px-4 py-3 text-[15px] leading-relaxed text-slate-50">${escapeHtml(m.text)}</div>
          <span class="text-xs text-slate-500">${mode}, ${m.ratio}, ${m.duration} s</span>
        </div>
      </div>`;
  }

  function aiShellHTML() {
    return `
      <div class="flex gap-3 sm:gap-4">
        <div class="avatar-ai" aria-hidden="true"><i data-lucide="clapperboard" class="h-4 w-4"></i></div>
        <div class="min-w-0 flex-1" data-slot></div>
      </div>`;
  }

  function stageText(m) {
    const p = m.progress || 0;
    if (p < 8) return 'Waiting for a free GPU';
    if (p < 25) return m.file || m.hasImage ? 'Reading your prompt and image' : 'Reading your prompt';
    if (p < 85) return 'Generating frames';
    return 'Rendering your video';
  }

  function loadingHTML(m) {
    const ratio = RATIOS[m.ratio] || RATIOS['16:9'];
    const p = Math.round(m.progress || 0);
    const frames = Array.from({ length: 14 }, (_, i) => `<span style="--i:${i}"></span>`).join('');
    return `
      <div class="w-full ${ratio.width}">
        <div class="gen-card" style="aspect-ratio:${ratio.css}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="Generating video">
          <span class="gen-blob gen-blob-a"></span>
          <span class="gen-blob gen-blob-b"></span>
          <div class="gen-content">
            <div class="gen-frames" aria-hidden="true">${frames}</div>
            <div>
              <p data-progress-text class="text-4xl font-semibold tabular-nums text-white">${p}%</p>
              <p data-stage class="mt-1 text-sm text-slate-300">${stageText(m)}</p>
            </div>
          </div>
          <div class="gen-track"><div data-progress-bar class="gen-fill" style="width:${p}%"></div></div>
        </div>
        <div class="mt-3 flex items-center justify-between gap-3 text-sm text-slate-400">
          <span>Wan2.1 is rendering your video. This can take a minute or two.</span>
          <button type="button" class="action-btn shrink-0" data-action="cancel" data-id="${m.id}">
            <i data-lucide="x" class="h-3.5 w-3.5"></i>Cancel
          </button>
        </div>
      </div>`;
  }

  function videoHTML(m) {
    const ratio = RATIOS[m.ratio] || RATIOS['16:9'];
    return `
      <div class="w-full ${ratio.width}">
        <div class="vp shadow-2xl shadow-violet-950/50 ring-1 ring-white/10" style="aspect-ratio:${ratio.css}">
          <video src="${escapeHtml(m.videoUrl)}#t=0.1" preload="metadata" playsinline loop></video>
          <button type="button" class="vp-center" data-vp="toggle" aria-label="Play video">
            <i data-lucide="play" class="h-7 w-7 translate-x-0.5"></i>
          </button>
          <div class="vp-controls">
            <button type="button" class="vp-btn" data-vp="toggle" aria-label="Play or pause">
              <i data-lucide="play" class="icon-play h-[18px] w-[18px]"></i>
              <i data-lucide="pause" class="icon-pause h-[18px] w-[18px]"></i>
            </button>
            <div class="vp-track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="vp-fill"></div>
            </div>
            <span class="vp-time" data-vp="time">0:00 / 0:00</span>
            <button type="button" class="vp-btn" data-vp="mute" aria-label="Mute or unmute">
              <i data-lucide="volume-2" class="icon-vol h-[18px] w-[18px]"></i>
              <i data-lucide="volume-x" class="icon-muted h-[18px] w-[18px]"></i>
            </button>
            <button type="button" class="vp-btn" data-vp="fullscreen" aria-label="Full screen">
              <i data-lucide="maximize" class="h-[18px] w-[18px]"></i>
            </button>
          </div>
          <div class="vp-error">This video could not be loaded. Check the video URL and try again.</div>
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-1 text-slate-400">
          <button type="button" class="action-btn" data-action="download" data-id="${m.id}"><i data-lucide="download" class="h-3.5 w-3.5"></i>Download</button>
          <button type="button" class="action-btn" data-action="regenerate" data-id="${m.id}"><i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i>Regenerate</button>
          <button type="button" class="action-btn" data-action="copy" data-id="${m.id}"><i data-lucide="copy" class="h-3.5 w-3.5"></i>Copy prompt</button>
        </div>
      </div>`;
  }

  function errorHTML(m) {
    return `
      <div class="error-card max-w-xl rounded-2xl p-4">
        <div class="flex items-start gap-3">
          <i data-lucide="triangle-alert" class="mt-0.5 h-5 w-5 shrink-0 text-red-300"></i>
          <div class="min-w-0 flex-1">
            <p class="font-medium text-white">${m.cancelled ? 'Generation cancelled' : 'Video generation failed'}</p>
            <p class="mt-1 text-sm text-slate-300">${escapeHtml(m.error || 'Something went wrong.')}</p>
            <button type="button" class="ghost-btn mt-3" data-action="retry" data-id="${m.id}">
              <i data-lucide="refresh-cw" class="h-4 w-4"></i>Try again
            </button>
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------ video player --------------------------- */

  function initPlayer(vp) {
    const video = $('video', vp);
    const fill = $('.vp-fill', vp);
    const track = $('.vp-track', vp);
    const time = $('[data-vp="time"]', vp);

    const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
    const update = () => {
      const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      fill.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', Math.round(pct));
      time.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    };

    $$('[data-vp="toggle"]', vp).forEach((btn) =>
      btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); })
    );
    video.addEventListener('click', toggle);

    video.addEventListener('play', () => {
      vp.classList.add('is-playing');
      // Only one video plays at a time.
      document.querySelectorAll('.vp video').forEach((other) => { if (other !== video) other.pause(); });
    });
    video.addEventListener('pause', () => vp.classList.remove('is-playing'));
    video.addEventListener('ended', () => vp.classList.remove('is-playing'));
    video.addEventListener('timeupdate', update);
    video.addEventListener('loadedmetadata', update);
    video.addEventListener('error', () => vp.classList.add('has-error'));

    $('[data-vp="mute"]', vp).addEventListener('click', () => {
      video.muted = !video.muted;
      vp.classList.toggle('is-muted', video.muted);
    });

    $('[data-vp="fullscreen"]', vp).addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (vp.requestFullscreen) vp.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS Safari
    });

    // Seeking: pointer drag and keyboard
    let seeking = false;
    const seekTo = (e) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (video.duration) video.currentTime = ratio * video.duration;
    };
    track.addEventListener('pointerdown', (e) => { seeking = true; track.setPointerCapture(e.pointerId); seekTo(e); });
    track.addEventListener('pointermove', (e) => { if (seeking) seekTo(e); });
    track.addEventListener('pointerup', () => { seeking = false; });
    track.addEventListener('pointercancel', () => { seeking = false; });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || 0, video.currentTime + 2); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 2); e.preventDefault(); }
    });
  }

  function $$(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  /* ------------------------------ rendering ------------------------------ */

  function renderAI(m) {
    const node = state.nodes.get(m.id);
    if (!node) return;
    const slot = $('[data-slot]', node);

    if (m.status === 'loading') slot.innerHTML = loadingHTML(m);
    else if (m.status === 'done') slot.innerHTML = videoHTML(m);
    else slot.innerHTML = errorHTML(m);

    const vp = $('.vp', slot);
    if (vp) initPlayer(vp);
    refreshIcons();
  }

  /** Updates only the progress readouts so the CSS animations never restart. */
  function updateProgress(m) {
    const node = state.nodes.get(m.id);
    if (!node) return;
    const p = Math.round(m.progress || 0);
    const text = $('[data-progress-text]', node);
    const bar = $('[data-progress-bar]', node);
    const stage = $('[data-stage]', node);
    const card = $('.gen-card', node);
    if (text) text.textContent = `${p}%`;
    if (bar) bar.style.width = `${p}%`;
    if (stage) stage.textContent = stageText(m);
    if (card) card.setAttribute('aria-valuenow', p);
  }

  function addMessage(m, { animate = true } = {}) {
    state.messages.push(m);
    const node = document.createElement('article');
    node.dataset.id = m.id;
    if (animate) node.classList.add('msg-in');

    if (m.role === 'user') {
      node.innerHTML = userMessageHTML(m);
    } else {
      node.innerHTML = aiShellHTML();
    }
    els.chat.appendChild(node);
    state.nodes.set(m.id, node);

    if (m.role === 'ai') renderAI(m);
    refreshIcons();
    toggleEmptyState();
    return node;
  }

  function toggleEmptyState() {
    const isEmpty = state.messages.length === 0;
    els.empty.classList.toggle('hidden', !isEmpty);
    els.empty.classList.toggle('flex', isEmpty);
    els.chat.classList.toggle('hidden', isEmpty);
  }

  /* --------------------------- generation pipeline ----------------------- */

  function setBusy() {
    const busy = state.controllers.size > 0;
    els.send.classList.toggle('is-busy', busy);
    els.send.setAttribute('aria-busy', String(busy));
    updateSendState();
  }

  function updateSendState() {
    const busy = state.controllers.size > 0;
    els.send.disabled = busy || !els.prompt.value.trim();
  }

  async function runJob(m, { startAt = 0 } = {}) {
    const controller = new AbortController();
    state.controllers.set(m.id, controller);

    m.status = 'loading';
    m.progress = startAt;
    m.error = null;
    m.cancelled = false;
    renderAI(m);
    setBusy();

    try {
      const result = await window.VideoAPI.generateVideo({
        prompt: m.prompt,
        image: m.file || null,
        aspectRatio: m.ratio,
        duration: m.duration,
        signal: controller.signal,
        startAt,
        onProgress: ({ progress }) => {
          if (typeof progress === 'number') {
            m.progress = progress;
            updateProgress(m);
          }
        },
      });
      m.status = 'done';
      m.videoUrl = result.videoUrl;
    } catch (err) {
      m.status = 'error';
      m.cancelled = err && err.name === 'AbortError';
      m.error = m.cancelled
        ? 'You stopped this generation before it finished.'
        : (err && err.message) || 'Something went wrong. Please try again.';
    } finally {
      const stickToBottom = isNearBottom();
      state.controllers.delete(m.id);
      setBusy();
      renderAI(m);
      if (stickToBottom) scrollToBottom();
    }
  }

  function newAiMessage(source) {
    return {
      id: state.nextId++,
      role: 'ai',
      status: 'loading',
      prompt: source.prompt,
      file: source.file || null,
      hasImage: Boolean(source.file || source.hasImage),
      ratio: source.ratio,
      duration: source.duration,
      progress: 0,
      videoUrl: null,
      error: null,
    };
  }

  function submitPrompt() {
    const text = els.prompt.value.trim();
    if (!text || state.controllers.size > 0) return;

    const ratio = els.ratio.value;
    const duration = Number(els.duration.value);

    addMessage({
      id: state.nextId++,
      role: 'user',
      text,
      image: state.pendingDataUrl,
      ratio,
      duration,
    });

    const ai = newAiMessage({ prompt: text, file: state.pendingFile, ratio, duration });
    addMessage(ai);

    // Reset composer
    els.prompt.value = '';
    autosize();
    clearAttachment();
    updateSendState();
    scrollToBottom();

    runJob(ai);
  }

  /* ----------------------------- composer logic -------------------------- */

  function autosize() {
    els.prompt.style.height = 'auto';
    els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 200)}px`;
  }

  function setAttachment(file) {
    if (!file) return;
    if (!ALLOWED_TYPES.test(file.type)) {
      toast('Use a PNG, JPG, or WebP image.', 'error');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast(`That image is ${formatBytes(file.size)}. The limit is 10 MB.`, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.pendingFile = file;
      state.pendingDataUrl = reader.result;
      els.previewImg.src = reader.result;
      els.previewName.textContent = file.name || 'Pasted image';
      els.previewSize.textContent = formatBytes(file.size);
      els.preview.classList.remove('hidden');
      els.prompt.focus();
    };
    reader.onerror = () => toast('That image could not be read. Try another file.', 'error');
    reader.readAsDataURL(file);
  }

  function clearAttachment() {
    state.pendingFile = null;
    state.pendingDataUrl = null;
    els.fileInput.value = '';
    els.previewImg.removeAttribute('src');
    els.preview.classList.add('hidden');
  }

  function bindComposer() {
    els.prompt.addEventListener('input', () => { autosize(); updateSendState(); });

    els.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchDevice()) {
        e.preventDefault();
        els.form.requestSubmit();
      }
    });

    els.prompt.addEventListener('paste', (e) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        setAttachment(item.getAsFile());
      }
    });

    els.form.addEventListener('submit', (e) => { e.preventDefault(); submitPrompt(); });
    els.attachBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => setAttachment(els.fileInput.files[0]));
    els.removeBtn.addEventListener('click', clearAttachment);

    // Drag and drop anywhere on the page
    let dragDepth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      els.dropOverlay.classList.remove('hidden');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) els.dropOverlay.classList.add('hidden');
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.add('hidden');
      setAttachment(e.dataTransfer.files[0]);
    });
  }

  /* --------------------------- chat-level actions ------------------------ */

  function bindChatActions() {
    els.chat.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const m = state.messages.find((x) => x.id === Number(btn.dataset.id));
      if (!m) return;

      switch (btn.dataset.action) {
        case 'cancel': {
          const controller = state.controllers.get(m.id);
          if (controller) controller.abort();
          break;
        }
        case 'retry':
          if (state.controllers.size > 0) return toast('Wait for the current video to finish first.', 'error');
          runJob(m);
          break;
        case 'regenerate': {
          if (state.controllers.size > 0) return toast('Wait for the current video to finish first.', 'error');
          const copy = newAiMessage(m);
          addMessage(copy);
          scrollToBottom();
          runJob(copy);
          break;
        }
        case 'copy':
          try {
            await navigator.clipboard.writeText(m.prompt);
            toast('Prompt copied.');
          } catch (_) {
            toast('Could not copy the prompt.', 'error');
          }
          break;
        case 'download': {
          const ok = await window.VideoAPI.downloadVideo(m.videoUrl, 'frameflow-video.mp4');
          if (!ok) toast('Opened the video in a new tab. Right-click it to save.');
          break;
        }
      }
    });

    // Empty-state suggestions
    els.empty.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-suggestion]');
      if (!chip) return;
      els.prompt.value = chip.dataset.suggestion;
      autosize();
      updateSendState();
      els.prompt.focus();
    });

    els.newChat.addEventListener('click', () => {
      state.controllers.forEach((controller) => controller.abort());
      state.controllers.clear();
      state.messages = [];
      state.nodes.clear();
      els.chat.innerHTML = '';
      clearAttachment();
      els.prompt.value = '';
      autosize();
      setBusy();
      toggleEmptyState();
      els.prompt.focus();
    });
  }

  /* ------------------------------- demo data ----------------------------- */
  /* Placeholder conversation so the layout is populated on first load.
     Videos below are sample clips, not generated from these prompts.        */

  function loadDemoConversation() {
    const demo = [
      {
        prompt: 'Neon-lit Tokyo street after the rain, slow dolly forward, reflections on wet asphalt, cinematic 35mm',
        image: sceneThumb('#4c1d95', '#be185d', '#22d3ee'),
        ratio: '16:9', duration: 5,
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      },
      {
        prompt: 'A paper boat drifting across a calm lake at sunrise, soft mist, gentle ripples spreading outward',
        image: null,
        ratio: '16:9', duration: 5,
        videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
      },
      {
        prompt: 'Animate this: clouds rolling over the mountains while the golden hour light slowly shifts',
        image: sceneThumb('#1e3a8a', '#f59e0b', '#fde68a'),
        ratio: '9:16', duration: 3,
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      },
    ];

    demo.forEach((d) => {
      addMessage({ id: state.nextId++, role: 'user', text: d.prompt, image: d.image, ratio: d.ratio, duration: d.duration }, { animate: false });
      const ai = newAiMessage({ prompt: d.prompt, hasImage: Boolean(d.image), ratio: d.ratio, duration: d.duration });
      ai.status = 'done';
      ai.videoUrl = d.videoUrl;
      addMessage(ai, { animate: false });
    });

    // One job still in progress so you can see the loading state
    const livePrompt = 'Aerial shot over a rugged coastline, waves crashing against the cliffs in slow motion, golden light';
    addMessage({ id: state.nextId++, role: 'user', text: livePrompt, image: null, ratio: '16:9', duration: 5 }, { animate: false });
    const live = newAiMessage({ prompt: livePrompt, ratio: '16:9', duration: 5 });
    addMessage(live, { animate: false });
    runJob(live, { startAt: 34 });
  }

  /* --------------------------------- init -------------------------------- */

  function init() {
    if (window.VideoAPI && window.VideoAPI.config.USE_MOCK) els.modeBadge.classList.remove('hidden');
    bindComposer();
    bindChatActions();
    loadDemoConversation();
    updateSendState();
    refreshIcons();
    requestAnimationFrame(() => scrollToBottom(false));
  }

  init();
})();
