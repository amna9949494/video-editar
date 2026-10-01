/* ══════════════════════════════════════════════════════════════
   ui.js — DOM rendering, chat flow, uploads, localStorage history
══════════════════════════════════════════════════════════════ */

'use strict';

(function () {
  /* ─────────────── Constants ─────────────── */
  const STORAGE_KEY = 'lumen.chat.history.v1';
  const MAX_HISTORY = 30;

  /* ─────────────── DOM refs ─────────────── */
  const DOM = {
    chatScroll: document.getElementById('chatScroll'),
    chatContainer: document.getElementById('chatContainer'),
    emptyState: document.getElementById('emptyState'),
    suggestions: document.getElementById('suggestions'),
    form: document.getElementById('composerForm'),
    prompt: document.getElementById('promptInput'),
    sendBtn: document.getElementById('sendBtn'),
    attachBtn: document.getElementById('attachBtn'),
    fileInput: document.getElementById('fileInput'),
    tray: document.getElementById('attachmentTray'),
    sidebar: document.getElementById('sidebar'),
    backdrop: document.getElementById('sidebarBackdrop'),
    menuBtn: document.getElementById('menuBtn'),
    closeSidebarBtn: document.getElementById('closeSidebarBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    historyList: document.getElementById('historyList'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    durationGroup: document.getElementById('durationGroup'),
    chatTitle: document.getElementById('chatTitle'),
    chatSubtitle: document.getElementById('chatSubtitle'),
  };

  /* ─────────────── State ─────────────── */
  const state = {
    pendingImage: null,      // { file, dataUrl, name, size }
    busy: false,
    duration: '5s',          // ← selected video duration
    history: [],             // persisted chat history
    activeHistoryId: null,
  };

  /* ══════════════════════════════════════════════════════════
     LOCALSTORAGE — persistence layer
  ═══════════════════════════════════════════════════════════ */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.history = raw ? JSON.parse(raw) : [];
    } catch {
      state.history = [];
    }
    return state.history;
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.history.slice(0, MAX_HISTORY)));
    } catch (err) {
      console.warn('Could not persist chat history:', err);
    }
  }

  function addHistoryEntry(entry) {
    state.history.unshift(entry);
    state.history = state.history.slice(0, MAX_HISTORY);
    state.activeHistoryId = entry.id;
    saveHistory();
    renderHistory();
  }

  function updateHistoryEntry(id, patch) {
    const idx = state.history.findIndex((h) => h.id === id);
    if (idx === -1) return;
    state.history[idx] = { ...state.history[idx], ...patch };
    saveHistory();
    renderHistory();
  }

  function deleteHistoryEntry(id) {
    state.history = state.history.filter((h) => h.id !== id);
    if (state.activeHistoryId === id) state.activeHistoryId = null;
    saveHistory();
    renderHistory();
  }

  function clearAllHistory() {
    if (!state.history.length) return;
    if (!window.confirm('Clear all chat history? This cannot be undone.')) return;
    state.history = [];
    state.activeHistoryId = null;
    saveHistory();
    renderHistory();
    showToast('Chat history cleared.');
  }

  /* ══════════════════════════════════════════════════════════
     UTILITIES
  ═══════════════════════════════════════════════════════════ */
  const $ = (sel, root = document) => root.querySelector(sel);

  function refreshIcons() {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function escapeHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function scrollToBottom({ smooth = true } = {}) {
    requestAnimationFrame(() => {
      DOM.chatScroll.scrollTo({
        top: DOM.chatScroll.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    });
  }

  function formatBytes(bytes = 0) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function relativeTime(iso) {
    if (!iso) return 'Just now';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function uid() {
    return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /* ══════════════════════════════════════════════════════════
     HISTORY RENDERING
  ═══════════════════════════════════════════════════════════ */
  function renderHistory() {
    if (!state.history.length) {
      DOM.historyList.innerHTML = `
        <div class="history-empty">
          <i data-lucide="message-square-dashed" class="h-5 w-5 opacity-50"></i>
          <p>No chats yet.<br/>Your generations will appear here.</p>
        </div>`;
      refreshIcons();
      return;
    }

    DOM.historyList.innerHTML = state.history
      .map((item) => {
        const isActive = item.id === state.activeHistoryId;
        const thumb = item.imageThumb
          ? `<img src="${item.imageThumb}" alt="" class="h-8 w-8 shrink-0 rounded-lg object-cover border border-white/10" />`
          : `<span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-neon-violet/25 to-neon-blue/15 text-neon-purple">
               <i data-lucide="${item.mode === 'image-to-video' ? 'image' : 'film'}" class="h-3.5 w-3.5"></i>
             </span>`;

        return `
          <div class="history-item ${isActive ? 'active' : ''}" data-id="${item.id}" role="button" tabindex="0">
            ${thumb}
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] font-medium">${escapeHtml(item.title)}</span>
              <span class="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-white/35">
                <span>${escapeHtml(item.duration || '5s')}</span>
                <span class="opacity-40">·</span>
                <span>${escapeHtml(relativeTime(item.createdAt))}</span>
              </span>
            </span>
            <button type="button" class="history-del icon-btn !h-7 !w-7 !rounded-lg !border-transparent !bg-transparent opacity-0" data-del="${item.id}" aria-label="Delete">
              <i data-lucide="x" class="h-3 w-3"></i>
            </button>
          </div>`;
      })
      .join('');

    refreshIcons();

    // Hover state for the delete button
    DOM.historyList.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        el.querySelector('.history-del')?.classList.remove('opacity-0');
      });
      el.addEventListener('mouseleave', () => {
        el.querySelector('.history-del')?.classList.add('opacity-0');
      });
    });
  }

  /* ══════════════════════════════════════════════════════════
     MESSAGE BUILDERS
  ═══════════════════════════════════════════════════════════ */
  function buildUserMessage({ text, image }) {
    const row = document.createElement('div');
    row.className = 'msg-row animate-rise flex justify-end gap-3';
    row.dataset.role = 'user';

    const body = document.createElement('div');
    body.className = 'flex max-w-[92%] flex-col items-end gap-2 sm:max-w-[78%]';

    if (text) {
      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      bubble.textContent = text;
      body.appendChild(bubble);
    }

    if (image) {
      const thumb = document.createElement('img');
      thumb.src = image;
      thumb.alt = 'Source image';
      thumb.loading = 'lazy';
      thumb.className = 'user-thumb';
      body.appendChild(thumb);
    }

    const avatar = document.createElement('div');
    avatar.className =
      'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-[11px] font-bold text-white/70';
    avatar.textContent = 'AK';

    row.append(body, avatar);
    return row;
  }

  function buildAIRow() {
    const row = document.createElement('div');
    row.className = 'msg-row animate-rise flex gap-3 sm:gap-4';
    row.dataset.role = 'ai';

    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar';
    avatar.innerHTML = '<i data-lucide="sparkles" class="h-4 w-4"></i>';

    const content = document.createElement('div');
    content.className = 'min-w-0 flex-1 sm:max-w-[88%]';

    row.append(avatar, content);
    return { row, content };
  }

  function buildVideoCard(v) {
    return `
      <div class="glass rounded-3xl p-3 sm:p-3.5">
        <div class="video-frame">
          <span class="video-badge">
            <i data-lucide="film" class="h-3 w-3"></i>
            Wan 2.1 · ${escapeHtml(v.resolution || '720p')}
          </span>
          <video
            src="${escapeHtml(v.videoUrl)}"
            poster="${escapeHtml(v.poster || '')}"
            controls
            playsinline
            preload="metadata"
          ></video>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <a class="action-btn" href="${escapeHtml(v.videoUrl)}" download target="_blank" rel="noopener">
            <i data-lucide="download" class="h-3.5 w-3.5"></i> Download
          </a>
          <button class="action-btn" data-action="regenerate" type="button">
            <i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i> Regenerate
          </button>
          <button class="action-btn" data-action="upscale" type="button">
            <i data-lucide="wand-sparkles" class="h-3.5 w-3.5"></i> Upscale 1080p
          </button>
          <span class="ml-auto font-mono text-[11px] text-white/30">
            ${escapeHtml(v.duration || '5s')} · seed ${escapeHtml(String(v.seed ?? '—'))}
          </span>
        </div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════
     MESSAGE RENDERERS
  ═══════════════════════════════════════════════════════════ */
  function appendUserMessage(payload) {
    const el = buildUserMessage(payload);
    DOM.chatContainer.appendChild(el);
    refreshIcons();
    scrollToBottom();
    return el;
  }

  function appendVideoMessage(video) {
    const { row, content } = buildAIRow();
    content.innerHTML = buildVideoCard(video);
    DOM.chatContainer.appendChild(row);
    refreshIcons();
    scrollToBottom();
    return row;
  }

  function appendProcessingMessage(duration = '5s') {
    const { row, content } = buildAIRow();

    content.innerHTML = `
      <div class="glass rounded-3xl p-5">
        <div class="flex items-center gap-4">
          <div class="relative shrink-0">
            <div class="gen-orb"></div>
            <div class="gen-ring"></div>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-[13px] font-semibold text-white/90">Generating video</p>
            <p class="gen-status mt-0.5 truncate text-xs text-white/45">Initializing Wan 2.1 pipeline…</p>
          </div>
          <div class="gen-pct shrink-0 font-mono text-xs text-white/55">0%</div>
        </div>

        <div class="skeleton-video mt-5"></div>

        <div class="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div class="gen-bar"></div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <span class="chip">720p</span>
          <span class="chip">${escapeHtml(duration)}</span>
          <span class="chip">16:9</span>
          <span class="chip ml-auto">
            <i data-lucide="clock" class="h-3 w-3"></i> ~45s
          </span>
        </div>
      </div>`;

    DOM.chatContainer.appendChild(row);
    refreshIcons();
    scrollToBottom();

    const statusEl = $('.gen-status', content);
    const pctEl = $('.gen-pct', content);
    const barEl = $('.gen-bar', content);

    return {
      row,
      setProgress(pct, label) {
        const value = Math.max(0, Math.min(100, Math.round(pct)));
        barEl.style.width = `${value}%`;
        pctEl.textContent = `${value}%`;
        if (label && label !== statusEl.textContent) {
          statusEl.style.opacity = '0';
          setTimeout(() => {
            statusEl.textContent = label;
            statusEl.style.opacity = '1';
          }, 140);
        }
        scrollToBottom({ smooth: false });
      },
      setResult(video) {
        content.innerHTML = buildVideoCard(video);
        refreshIcons();
        scrollToBottom();
      },
      setError(message) {
        content.innerHTML = `
          <div class="glass rounded-3xl border !border-rose-500/30 p-5">
            <div class="flex items-start gap-3">
              <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300">
                <i data-lucide="alert-triangle" class="h-4 w-4"></i>
              </div>
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-white/90">Generation failed</p>
                <p class="mt-0.5 text-xs leading-relaxed text-white/45">${escapeHtml(message)}</p>
                <button class="action-btn mt-3" data-action="regenerate" type="button">
                  <i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i> Try again
                </button>
              </div>
            </div>
          </div>`;
        refreshIcons();
        scrollToBottom();
      },
    };
  }

  /* ══════════════════════════════════════════════════════════
     COMPOSER: attachments
  ═══════════════════════════════════════════════════════════ */
  function renderTray() {
    if (!state.pendingImage) {
      DOM.tray.classList.add('hidden');
      DOM.tray.innerHTML = '';
      return;
    }

    const { dataUrl, name, size } = state.pendingImage;
    DOM.tray.classList.remove('hidden');
    DOM.tray.innerHTML = `
      <div class="tray-item animate-pop">
        <img src="${dataUrl}" alt="Attachment preview" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[12.5px] font-medium text-white/85">${escapeHtml(name)}</p>
          <p class="mt-0.5 text-[11px] text-white/40">
            ${formatBytes(size)} · Image → Video
          </p>
        </div>
        <button type="button" class="tray-remove" id="removeAttachment" aria-label="Remove attachment">
          <i data-lucide="x" class="h-3.5 w-3.5"></i>
        </button>
      </div>`;

    refreshIcons();

    $('#removeAttachment', DOM.tray)?.addEventListener('click', () => {
      state.pendingImage = null;
      DOM.fileInput.value = '';
      renderTray();
    });
  }

  async function handleFileSelected(file) {
    if (!file) return;

    const cfg = VideoAPI.config;
    if (!cfg.acceptedImageTypes.includes(file.type)) {
      showToast('Unsupported format — use PNG, JPG, WEBP or GIF.', 'error');
      return;
    }
    if (file.size > cfg.maxImageBytes) {
      showToast('Image is too large (max 10 MB).', 'error');
      return;
    }

    try {
      const dataUrl = await VideoAPI.readImagePreview(file);
      state.pendingImage = { file, dataUrl, name: file.name, size: file.size };
      renderTray();
      DOM.prompt.focus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ══════════════════════════════════════════════════════════
     COMPOSER: textarea
  ═══════════════════════════════════════════════════════════ */
  function autoResize() {
    DOM.prompt.style.height = 'auto';
    DOM.prompt.style.height = `${Math.min(DOM.prompt.scrollHeight, 200)}px`;
  }

  function clearComposer() {
    DOM.prompt.value = '';
    autoResize();
    state.pendingImage = null;
    DOM.fileInput.value = '';
    renderTray();
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    DOM.sendBtn.disabled = isBusy;
    DOM.sendBtn.classList.toggle('is-busy', isBusy);
    DOM.sendBtn.innerHTML = isBusy
      ? '<i data-lucide="loader-2" class="h-[18px] w-[18px]"></i>'
      : '<i data-lucide="arrow-up" class="h-[18px] w-[18px]"></i>';
    refreshIcons();
  }

  /* ══════════════════════════════════════════════════════════
     DURATION SELECTOR
  ═══════════════════════════════════════════════════════════ */
  function setDuration(value) {
    state.duration = value;

    DOM.durationGroup.querySelectorAll('.duration-pill').forEach((pill) => {
      const isActive = pill.dataset.duration === value;
      pill.classList.toggle('is-active', isActive);
      pill.setAttribute('aria-checked', String(isActive));
    });

    // Update header subtitle
    DOM.chatSubtitle.textContent = `Wan 2.1 · 720p · ${value} · 16:9`;

    // Update the hint with credit cost
    const cost = VideoAPI.getDurationCost(value);
    const hint = $('#durationHint');
    if (hint) hint.textContent = `≈ ${cost} credit${cost > 1 ? 's' : ''} per render`;
  }

  /* ══════════════════════════════════════════════════════════
     GENERATION FLOW
  ═══════════════════════════════════════════════════════════ */
  async function runGeneration({ promptText, imageFile, imageThumb, historyId }) {
    setBusy(true);
    const processing = appendProcessingMessage(state.duration);

    try {
      const result = await VideoAPI.generateVideo({
        prompt: promptText,
        imageFile,
        duration: state.duration,
        onProgress: (pct, label) => processing.setProgress(pct, label),
      });
      processing.setResult(result);

      // Persist the video URL into the history entry
      if (historyId) {
        updateHistoryEntry(historyId, {
          videoUrl: result.videoUrl,
          poster: result.poster,
        });
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        processing.setError('Generation was cancelled.');
      } else {
        processing.setError(err?.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
      DOM.prompt.focus();
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busy) return;

    const text = DOM.prompt.value.trim();
    const attachment = state.pendingImage;

    if (!text && !attachment) {
      DOM.prompt.focus();
      return;
    }

    const finalPrompt = text || 'Animate the provided image with natural, cinematic motion.';
    const thumbDataUrl = attachment?.dataUrl || null;

    // Render user message immediately
    appendUserMessage({
      text: finalPrompt,
      image: thumbDataUrl,
    });

    // Create the history entry
    const historyEntry = {
      id: uid(),
      title: finalPrompt.slice(0, 42) + (finalPrompt.length > 42 ? '…' : ''),
      prompt: finalPrompt,
      duration: state.duration,
      mode: attachment ? 'image-to-video' : 'text-to-video',
      imageThumb: thumbDataUrl,
      videoUrl: null,
      createdAt: new Date().toISOString(),
    };
    addHistoryEntry(historyEntry);

    // Update header title
    DOM.chatTitle.textContent = historyEntry.title;

    const payload = {
      promptText: finalPrompt,
      imageFile: attachment?.file || null,
      historyId: historyEntry.id,
    };

    clearComposer();
    await runGeneration(payload);
  }

  function handleRegenerate(button) {
    if (state.busy) return;

    const row = button.closest('.msg-row');
    let sibling = row?.previousElementSibling;

    while (sibling && sibling.dataset.role !== 'user') {
      sibling = sibling.previousElementSibling;
    }

    const bubble = sibling?.querySelector('.user-bubble');
    const promptText = bubble?.textContent?.trim();
    if (!promptText) return;

    runGeneration({ promptText, imageFile: null, historyId: null });
  }

  /* ══════════════════════════════════════════════════════════
     RESTORE A HISTORY ENTRY INTO THE CHAT
  ═══════════════════════════════════════════════════════════ */
  function restoreHistory(entry) {
    DOM.chatContainer.innerHTML = '';
    showEmptyState(false);

    state.activeHistoryId = entry.id;
    DOM.chatTitle.textContent = entry.title;
    DOM.chatSubtitle.textContent = `Wan 2.1 · 720p · ${entry.duration || '5s'} · 16:9`;

    appendUserMessage({
      text: entry.prompt,
      image: entry.imageThumb || null,
    });

    if (entry.videoUrl) {
      appendVideoMessage({
        videoUrl: entry.videoUrl,
        poster: entry.poster,
        duration: entry.duration,
        resolution: '1280×720',
        seed: '—',
      });
    } else {
      // No video stored yet — show a lightweight placeholder
      const { row, content } = buildAIRow();
      content.innerHTML = `
        <div class="glass rounded-3xl border !border-white/5 p-5 text-center">
          <p class="text-[12.5px] text-white/45">
            This generation's video isn't available in your local history.
          </p>
          <button class="action-btn mt-3" data-action="regenerate" type="button">
            <i data-lucide="refresh-cw" class="h-3.5 w-3.5"></i> Regenerate
          </button>
        </div>`;
      DOM.chatContainer.appendChild(row);
      refreshIcons();
    }

    renderHistory();
    scrollToBottom({ smooth: false });
    closeSidebar();
  }

  /* ══════════════════════════════════════════════════════════
     SIDEBAR
  ═══════════════════════════════════════════════════════════ */
  function openSidebar() {
    DOM.sidebar.classList.remove('-translate-x-full');
    DOM.backdrop.classList.remove('hidden');
  }

  function closeSidebar() {
    DOM.sidebar.classList.add('-translate-x-full');
    DOM.backdrop.classList.add('hidden');
  }

  /* ══════════════════════════════════════════════════════════
     EMPTY STATE
  ═══════════════════════════════════════════════════════════ */
  const SUGGESTIONS = [
    { icon: 'mountain-snow', title: 'Aerial over Iceland', text: 'Drone shot flying over black volcanic cliffs at golden hour, mist rolling in, cinematic grade.' },
    { icon: 'swords', title: 'Cyberpunk duel', text: 'Two cyberpunk samurai facing off in a rain-soaked alley, neon reflections, slow motion sparks.' },
    { icon: 'waves', title: 'Bioluminescent sea', text: 'Macro shot of bioluminescent jellyfish drifting through dark water, glowing blue tendrils.' },
    { icon: 'sparkles', title: 'Product reveal', text: 'Elegant product reveal on a reflective black surface, rotating slowly, soft rim light, studio setup.' },
  ];

  function renderSuggestions() {
    DOM.suggestions.innerHTML = SUGGESTIONS.map(
      (s) => `
        <button type="button" class="suggestion-card" data-prompt="${escapeHtml(s.text)}">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-neon-violet/30 to-neon-blue/20 text-neon-purple">
            <i data-lucide="${s.icon}" class="h-3.5 w-3.5"></i>
          </span>
          <span class="min-w-0">
            <span class="block text-[12.5px] font-semibold text-white/85">${escapeHtml(s.title)}</span>
            <span class="mt-0.5 block text-[11px] leading-snug text-white/35 line-clamp-2">${escapeHtml(s.text)}</span>
          </span>
        </button>`
    ).join('');
    refreshIcons();

    DOM.suggestions.querySelectorAll('.suggestion-card').forEach((card) => {
      card.addEventListener('click', () => {
        DOM.prompt.value = card.dataset.prompt;
        autoResize();
        DOM.prompt.focus();
      });
    });
  }

  function showEmptyState(show) {
    DOM.emptyState.classList.toggle('hidden', !show);
  }

  /* ══════════════════════════════════════════════════════════
     TOAST
  ═══════════════════════════════════════════════════════════ */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `glass animate-pop fixed left-1/2 top-5 z-[100] -translate-x-1/2 rounded-2xl px-4 py-2.5 text-[12.5px] font-medium shadow-2xl ${
      type === 'error' ? 'text-rose-200 !border-rose-500/30' : 'text-white/85'
    }`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .3s ease, transform .3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-50%, -10px)';
      setTimeout(() => toast.remove(), 320);
    }, 2400);
  }

  /* ══════════════════════════════════════════════════════════
     EVENT BINDING
  ═══════════════════════════════════════════════════════════ */
  function bindEvents() {
    /* Composer */
    DOM.form.addEventListener('submit', handleSubmit);
    DOM.prompt.addEventListener('input', autoResize);
    DOM.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        DOM.form.requestSubmit();
      }
    });

    /* Attachment */
    DOM.attachBtn.addEventListener('click', () => DOM.fileInput.click());
    DOM.fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelected(file);
    });

    /* Paste an image into the prompt */
    DOM.prompt.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imageItem = items.find((i) => i.type.startsWith('image/'));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (file) handleFileSelected(file);
      }
    });

    /* Drag & drop onto the composer */
    const composer = DOM.form;
    ['dragenter', 'dragover'].forEach((evt) =>
      composer.addEventListener(evt, (e) => {
        e.preventDefault();
        composer.classList.add('is-dragover');
      })
    );
    ['dragleave', 'drop'].forEach((evt) =>
      composer.addEventListener(evt, (e) => {
        e.preventDefault();
        if (evt === 'dragleave' && composer.contains(e.relatedTarget)) return;
        composer.classList.remove('is-dragover');
      })
    );
    composer.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFileSelected(file);
    });

    /* Duration selector */
    DOM.durationGroup.addEventListener('click', (e) => {
      const pill = e.target.closest('.duration-pill');
      if (pill) setDuration(pill.dataset.duration);
    });

    /* Delegated actions inside the chat */
    DOM.chatContainer.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;

      const action = actionBtn.dataset.action;
      if (action === 'regenerate') handleRegenerate(actionBtn);
      if (action === 'upscale') showToast('Upscaling queued — 1080p render starting…');
    });

    /* Sidebar */
    DOM.menuBtn.addEventListener('click', openSidebar);
    DOM.closeSidebarBtn.addEventListener('click', closeSidebar);
    DOM.backdrop.addEventListener('click', closeSidebar);

    /* New chat */
    DOM.newChatBtn.addEventListener('click', () => {
      DOM.chatContainer.innerHTML = '';
      showEmptyState(true);
      clearComposer();
      state.activeHistoryId = null;
      DOM.chatTitle.textContent = 'New Generation';
      setDuration(state.duration); // resets subtitle
      renderHistory();
      DOM.prompt.focus();
      closeSidebar();
    });

    /* History: click to restore, delete to remove */
    DOM.historyList.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-del]');
      if (delBtn) {
        e.stopPropagation();
        deleteHistoryEntry(delBtn.dataset.del);
        return;
      }
      const item = e.target.closest('.history-item');
      if (!item) return;
      const entry = state.history.find((h) => h.id === item.dataset.id);
      if (entry) restoreHistory(entry);
    });

    /* Keyboard activation for history items */
    DOM.historyList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('.history-item');
      if (!item) return;
      e.preventDefault();
      const entry = state.history.find((h) => h.id === item.dataset.id);
      if (entry) restoreHistory(entry);
    });

    /* Clear history */
    DOM.clearHistoryBtn.addEventListener('click', clearAllHistory);

    /* Global shortcut: focus composer */
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== DOM.prompt) {
        e.preventDefault();
        DOM.prompt.focus();
      }
    });
  }

  /* ══════════════════════════════════════════════════════════
     BOOTSTRAP
  ═══════════════════════════════════════════════════════════ */
  function seedDemoHistory() {
    // On a first-ever visit, preload a couple of demo entries so the sidebar isn't empty.
    if (state.history.length) return;

    const now = Date.now();
    state.history = [
      {
        id: uid(),
        title: 'Neon Tokyo alley at midnight',
        prompt: 'Cinematic dolly shot through a neon-lit Tokyo alley at midnight. Rain-slicked asphalt reflecting pink and cyan signage, shallow depth of field, anamorphic lens flares.',
        duration: '5s',
        mode: 'image-to-video',
        imageThumb: 'https://picsum.photos/seed/tokyo-alley-42/320/320',
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
        poster: 'https://picsum.photos/seed/lumen-neon/1280/720',
        createdAt: new Date(now - 1000 * 60 * 8).toISOString(),
      },
      {
        id: uid(),
        title: 'Ink swirling in water (macro)',
        prompt: 'Slow-motion macro of deep purple and electric blue ink swirling through water, volumetric backlight, ultra sharp, 120fps look.',
        duration: '10s',
        mode: 'text-to-video',
        imageThumb: null,
        videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        poster: 'https://picsum.photos/seed/lumen-ink/1280/720',
        createdAt: new Date(now - 1000 * 60 * 60 * 3).toISOString(),
      },
      {
        id: uid(),
        title: 'Bioluminescent jellyfish drift',
        prompt: 'Macro shot of bioluminescent jellyfish drifting through dark water, glowing blue tendrils, deep sea ambience.',
        duration: '1m',
        mode: 'text-to-video',
        imageThumb: null,
        videoUrl: null,
        poster: null,
        createdAt: new Date(now - 1000 * 60 * 60 * 26).toISOString(),
      },
    ];
    saveHistory();
  }

  function renderSeededConversation() {
    // Show the most recent history entry as the visible chat on load.
    const first = state.history[0];
    if (first && first.videoUrl) {
      restoreHistory(first);
    } else {
      showEmptyState(true);
    }
  }

  function init() {
    loadHistory();
    seedDemoHistory();
    renderHistory();
    renderSuggestions();
    setDuration(state.duration);
    renderTray();
    autoResize();
    bindEvents();
    refreshIcons();

    // Render the most recent conversation
    renderSeededConversation();

    DOM.prompt.focus();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
