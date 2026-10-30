(function () {
  "use strict";

  const IS_MOCK = window.__QCHAT_MOCK__ === true;
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const listen = (event, cb) => window.__TAURI__.event.listen(event, cb);
  const GUTTER = 28;
  const STREAM_HEADROOM = 72;
  const CHATS_KEY = "qchat.chats";
  const CHATS_VERSION = 1;
  const MAX_RECENT = 3;
  const MAX_RESPONSE = 60 * 1024;
  const OPEN_TIMEOUT = 12000;
  const FRESH_TIMEOUT = 2500;

  // rAF stalls while the native window is hidden, so never let work depend on it alone.
  function nextFrame(fn) {
    let ran = false;
    const run = () => { if (!ran) { ran = true; fn(); } };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  // ---------------------------------------------------------------------------
  // 1. Theme
  // ---------------------------------------------------------------------------
  async function refreshTheme() {
    try {
      QSettings.setTheme(await invoke("get_theme"));
    } catch (_) {
      QSettings.setTheme(null);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Security & Markdown Configuration
  // ---------------------------------------------------------------------------
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

  const GLYPH = {
    copy: "",
    check: "",
    send: "",
    stop: "",
    close: "",
    clock: "",
    down: "",
    errorBadge: "",
    settings: "",
    newChat: "",
    account: "",
    trash: "",
    hide: ""
  };

  function sanitizeHref(rawHref) {
    if (typeof rawHref !== "string") return null;
    const trimmed = rawHref.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        return parsed.href;
      }
    } catch (_) {}
    return null;
  }

  if (window.marked) {
    const renderer = new window.marked.Renderer();

    renderer.html = (token) => escapeHtml(typeof token === "string" ? token : (token?.text ?? ""));
    renderer.image = (href, _title, text) => `<button type="button" class="hyperlink-btn" data-action="view-media">${escapeHtml(typeof text === "string" ? text : (href?.text || "Image"))}</button>`;

    renderer.link = (href, title, text) => {
      const rawHref = typeof href === "string" ? href : (href?.href ?? "");
      const rawTitle = typeof title === "string" ? title : (href?.title ?? "");
      const labelHtml = typeof text === "string" ? text : (href?.text ?? "");
      const safeUrl = sanitizeHref(rawHref);
      if (!safeUrl) return /^(sandbox:|attachment:|qchat-media:)/i.test(rawHref) ? `<button type="button" class="hyperlink-btn" data-action="view-media">${labelHtml || "View file in ChatGPT"}</button>` : labelHtml;
      const titleAttr = ` title="${escapeHtml(rawTitle || safeUrl)}"`;
      return `<a href="${escapeHtml(safeUrl)}"${titleAttr} rel="noopener noreferrer">${labelHtml}</a>`;
    };

    renderer.code = (code, infostring) => {
      const rawCode = typeof code === "string" ? code : (code?.text ?? "");
      const rawLang = typeof infostring === "string" ? infostring : (code?.lang ?? "");
      const cleanLang = (rawLang.trim().split(/\s+/)[0] || "").replace(/[^a-zA-Z0-9_+-]/g, "");
      const safeLang = escapeHtml(cleanLang || "code");
      const safeCode = escapeHtml(rawCode.replace(/\n$/, ""));
      return (
        `<div class="code-block">` +
        `<div class="code-header"><span class="code-lang">${safeLang}</span>` +
        `<button type="button" class="code-copy-btn" data-action="copy-code" title="Copy code">` +
        `<span class="icon" aria-hidden="true">${GLYPH.copy}</span><span class="btn-label">Copy</span></button></div>` +
        `<pre><code class="language-${safeLang}">${safeCode}</code></pre></div>`
      );
    };

    window.marked.setOptions({ gfm: true, breaks: true, renderer });
  }

  function renderMarkdownSafe(markdownText) {
    const src = String(markdownText ?? "");
    if (!src) return "";
    return window.marked ? window.marked.parse(src) : `<p>${escapeHtml(src)}</p>`;
  }

  // ---------------------------------------------------------------------------
  // 3. Error Copy Mapping & State
  // ---------------------------------------------------------------------------
  const ERROR_MESSAGES = {
    not_ready: "ChatGPT is still loading. Try again in a moment.",
    busy: "ChatGPT is busy with another response.",
    rate_limited: "You've hit ChatGPT's usage limit for now.",
    auth: "Your session expired. Sign in again to continue.",
    send_failed: "Couldn't send your message to ChatGPT.",
    stream_failed: "The response was interrupted.",
    timeout: "ChatGPT took too long to respond.",
    open_timeout: "That chat is taking too long to open. Try sending again.",
    invalid_id: "That chat can't be reopened. Start a new one with /new."
  };

  const formatErrorCopy = (code, fallback) =>
    (code && ERROR_MESSAGES[code]) || fallback || "Something went wrong.";

  // Native errors look like "busy: details".
  const errorCode = (err) => {
    const code = err?.code || String(err?.message || err || "").split(":", 1)[0].trim();
    return ERROR_MESSAGES[code] ? code : "send_failed";
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $("stage"),
    stack: $("stack"),
    zone: $("bubble-zone"),
    bar: $("bar"),
    orb: $("orb"),
    statusDot: $("status-dot"),
    statusLabel: $("status-label"),
    guestNotice: $("guest-notice"),
    guestTitle: $("guest-title"),
    guestMessage: $("guest-message"),
    btnGuestSignin: $("btn-guest-signin"),
    btnGuestDismiss: $("btn-guest-dismiss"),
    globalError: $("global-error"),
    globalErrorText: $("global-error-text"),
    btnErrorSignin: $("btn-error-signin"),
    btnErrorDismiss: $("btn-error-dismiss"),
    clearConfirm: $("clear-confirm"),
    btnClearYes: $("btn-clear-yes"),
    btnClearNo: $("btn-clear-no"),
    suggestions: $("suggestions"),
    slashMenu: $("slash-menu"),
    tabs: $("tabs"),
    promptInput: $("prompt-input"),
    btnSend: $("btn-send"),
    btnAttach: $("btn-attach"),
    attachmentInput: $("attachment-input"),
    attachments: $("attachments")
  };

  const turns = [];
  const turnNodes = new Map();
  const renderSchedule = new Map();
  const pendingFiles = [];
  const imageURLs = new Set();
  let stageQueue = Promise.resolve();
  let sending = false;
  let chatGeneration = 0;
  let userScrolledUp = false;
  let guestDismissed = false;
  let sentThisSession = false;
  let autoDismissTimer = null;
  const bridge = { ready: false, loggedIn: false, signedOut: false };

  const isStreaming = () => turns.some((t) => t.status === "streaming");
  const isBusy = () => sending || isStreaming();

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function makeIcon(glyph, className = "icon") {
    const span = make("span", className, glyph);
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  function makeProgressRing() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "progress-ring");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "7");
    circle.setAttribute("pathLength", "100");
    svg.appendChild(circle);
    return svg;
  }

  // ---------------------------------------------------------------------------
  // 4. Chat history (local only)
  // ---------------------------------------------------------------------------
  const freshChat = () => ({
    key: crypto.randomUUID(),
    conversationId: null,
    title: "",
    lastActive: Date.now(),
    lastPrompt: "",
    lastResponse: "",
    createdAt: Date.now()
  });

  const hasContent = (chat) => Boolean(chat.lastPrompt || chat.lastResponse || chat.conversationId);

  function cleanChat(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key) return null;
    const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
    const time = (value) => (Number.isFinite(value) && value > 0 ? value : Date.now());
    return {
      key: raw.key,
      conversationId: typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId : null,
      title: text(raw.title, 40),
      lastActive: time(raw.lastActive),
      lastPrompt: text(raw.lastPrompt, 4000),
      lastResponse: text(raw.lastResponse, MAX_RESPONSE),
      createdAt: time(raw.createdAt)
    };
  }

  function loadChats() {
    const empty = { current: freshChat(), recent: [] };
    if (!QSettings.settings.keepHistory) {
      try { localStorage.removeItem(CHATS_KEY); } catch (_) {}
      return empty;
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(CHATS_KEY) || "null");
      if (!parsed || parsed.v !== CHATS_VERSION) return empty;
      const current = cleanChat(parsed.current) || empty.current;
      const seen = new Set([current.key]);
      const recent = (Array.isArray(parsed.recent) ? parsed.recent : [])
        .map(cleanChat)
        .filter((chat) => chat && !seen.has(chat.key) && seen.add(chat.key))
        .sort((a, b) => b.lastActive - a.lastActive)
        .slice(0, MAX_RECENT);
      return { current, recent };
    } catch (_) {
      return empty;
    }
  }

  const chats = loadChats();

  function saveChats() {
    try {
      if (!QSettings.settings.keepHistory) localStorage.removeItem(CHATS_KEY);
      else localStorage.setItem(CHATS_KEY, JSON.stringify({ v: CHATS_VERSION, current: chats.current, recent: chats.recent }));
    } catch (_) {}
  }

  function pushRecent(chat) {
    if (!QSettings.settings.keepHistory) return;
    chats.recent = [chat, ...chats.recent.filter((c) => c.key !== chat.key)].slice(0, MAX_RECENT);
  }

  function recordPartial(turn) {
    if (!turn || turn.role !== "assistant" || !turn.text || turn.chatKey !== chats.current.key) return;
    chats.current.lastResponse = turn.text.slice(0, MAX_RESPONSE);
    chats.current.lastActive = Date.now();
    saveChats();
  }

  function clearRecentChats() {
    chats.recent = [];
    if (!isBusy() && !turns.length) chats.current = freshChat();
    saveChats();
    renderTabs();
    updateIdleChips();
  }

  // ---------------------------------------------------------------------------
  // 5. Which chat the ChatGPT page holds
  // ---------------------------------------------------------------------------
  // `pristine`: the page has not been touched since launch, so an empty chat can use it as is.
  let page = { key: null, conv: null, pristine: true };
  let pageSync = Promise.resolve();
  const readyWaiters = new Set();

  function waitForReady(conversationId, timeoutMs) {
    const waiter = { conversationId };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = () => { clearTimeout(waiter.timer); clearTimeout(waiter.grace); readyWaiters.delete(waiter); resolve(); };
      waiter.timer = setTimeout(() => {
        readyWaiters.delete(waiter);
        clearTimeout(waiter.grace);
        reject({ code: "open_timeout" });
      }, timeoutMs);
    });
    promise.catch(() => {});
    readyWaiters.add(waiter);
    promise.cancel = () => { clearTimeout(waiter.timer); clearTimeout(waiter.grace); readyWaiters.delete(waiter); };
    return promise;
  }

  function settleReadyWaiters(evt) {
    if (!evt.ready) return;
    for (const waiter of [...readyWaiters]) {
      const id = waiter.conversationId;
      if (!id || typeof evt.url !== "string" || evt.url.includes(`/c/${id}`)) waiter.resolve();
      // A guest page falls back to a fresh chat instead of /c/<id>; give it a moment to get there.
      else if (!evt.loggedIn && !waiter.grace) waiter.grace = setTimeout(() => waiter.resolve(), 500);
    }
  }

  async function openInPage(chat) {
    const id = chat.conversationId;
    page = { key: null, conv: null, pristine: false };
    const ready = waitForReady(id, window.__mock?.openTimeout || OPEN_TIMEOUT);
    try {
      await invoke("chat_open", { conversationId: id, preserveUploads: true });
      await ready;
      page = { key: chat.key, conv: id, pristine: false };
    } catch (err) {
      ready.cancel();
      throw err;
    }
  }

  async function freshInPage(chat) {
    page = { key: null, conv: null, pristine: false };
    const ready = waitForReady(null, FRESH_TIMEOUT);
    await invoke("chat_new", { preserveUploads: true });
    // The page normally confirms quickly; a slow confirmation is not a reason to fail the send.
    await ready.catch(() => {});
    page = { key: chat.key, conv: null, pristine: false };
  }

  // Never send into the wrong conversation: this throws rather than falling through.
  async function ensurePage(chat) {
    await pageSync.catch(() => {});
    if (chat.conversationId) {
      if (page.conv !== chat.conversationId) await openInPage(chat);
    } else if (page.key !== chat.key) {
      if (page.pristine && !chat.lastResponse) page = { key: chat.key, conv: null, pristine: false };
      else await freshInPage(chat);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Attachments & media
  // ---------------------------------------------------------------------------
  const CHUNK_SIZE = 512 * 1024;
  const MAX_BYTES = 512 * 1024 * 1024;
  const fileSize = bytes => bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  function imagePreview(file) {
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(file.type) && !(!file.type && /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name))) return null;
    const url = URL.createObjectURL(file); imageURLs.add(url); return url;
  }
  function releasePreview(url) { if (url && imageURLs.delete(url)) URL.revokeObjectURL(url); }
  function previewImage(src, name, className = "") {
    const image = make("img", className);
    image.crossOrigin = "anonymous";
    image.alt = name || "Image";
    image.src = src;
    return image;
  }
  function imageCopyButton(source) {
    const button = make("button", "btn btn-compact image-copy", "Copy image");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const image = await source();
        if (!image) throw new Error("Image is not ready");
        await image.decode();
        const width = image.naturalWidth, height = image.naturalHeight;
        if (!width || !height || width * height > 16 * 1024 * 1024) throw new Error("Image is too large to copy");
        const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const bytes = context.getImageData(0, 0, width, height).data;
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
        await invoke("image_copy", { width, height, rgba: btoa(chunks.join("")) });
        button.textContent = "Copied";
      } catch (error) { button.textContent = /too large/i.test(error?.message || "") ? "Image too large to copy" : "Copy failed. Retry"; }
      finally { button.disabled = false; }
      clearTimeout(button._copyTimer);
      button._copyTimer = setTimeout(() => { button.textContent = "Copy image"; }, 1600);
    });
    return button;
  }
  function renderAttachments() {
    el.attachments.replaceChildren();
    el.attachments.hidden = !pendingFiles.length;
    for (const item of pendingFiles) {
      const chip = make("div", "attachment-chip glass glass-tiny");
      chip.dataset.state = item.state;
      const label = make("span", "attachment-name", item.file.name);
      const status = item.state === "error" ? "Could not attach. Remove and try again." : item.state === "ready" ? fileSize(item.file.size) : `${Math.floor(item.offset / Math.max(1, item.file.size) * 100)}%`;
      const remove = make("button", "icon-btn"); remove.append(makeIcon(GLYPH.close));
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${item.file.name}`);
      remove.disabled = sending;
      remove.addEventListener("click", () => removeAttachment(item));
      if (item.previewURL) chip.append(previewImage(item.previewURL, item.file.name, "attachment-thumbnail"));
      chip.append(label, make("span", "attachment-status", status), remove);
      if (item.previewURL) chip.append(imageCopyButton(() => previewImage(item.previewURL, item.file.name)));
      el.attachments.append(chip);
    }
    updateComposerMode();
  }
  async function discardAttachment(item) {
    if (!item.id || item.discarded) return;
    item.discarded = true;
    try { await invoke("attachment_remove", { id: item.id }); }
    catch (_) { item.discarded = false; showGlobalError("attachment_failed", "Could not discard a file. Try New chat before attaching more files."); }
  }
  function removeAttachment(item) {
    item.cancelled = true;
    item.reader?.abort();
    const index = pendingFiles.indexOf(item);
    if (index >= 0) pendingFiles.splice(index, 1);
    releasePreview(item.previewURL);
    // The staging task discards after any in-flight command settles.
    if (item.state === "ready" || item.state === "error") void discardAttachment(item);
    renderAttachments();
  }
  function readChunk(item, blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      item.reader = reader;
      reader.onload = () => { item.reader = null; resolve(String(reader.result).split(",", 2)[1]); };
      reader.onerror = reader.onabort = () => { item.reader = null; reject(new Error("File read interrupted")); };
      reader.readAsDataURL(blob);
    });
  }
  async function stageAttachment(item) {
    try {
      if (item.cancelled) return;
      const meta = await invoke("attachment_begin", { name: item.file.name, mime: item.file.type || "application/octet-stream", size: item.file.size });
      if (!meta || typeof meta.id !== "string") throw new Error("Invalid attachment response");
      item.id = meta.id;
      while (!item.cancelled && item.offset < item.file.size) {
        const end = Math.min(item.offset + CHUNK_SIZE, item.file.size);
        const data = await readChunk(item, item.file.slice(item.offset, end));
        if (item.cancelled) break;
        await invoke("attachment_chunk", { id: item.id, offset: item.offset, data });
        item.offset = end;
        renderAttachments();
      }
      if (!item.cancelled) {
        await invoke("attachment_finish", { id: item.id });
        item.state = "ready";
      }
    } catch (_) {
      item.state = "error";
      await discardAttachment(item);
    } finally {
      if (item.cancelled) await discardAttachment(item);
      renderAttachments();
    }
  }
  function addFiles(files) {
    if (isStreaming() || sending) return;
    for (const file of Array.from(files || [])) {
      if (pendingFiles.length >= 10 || file.size > MAX_BYTES || pendingFiles.reduce((n, f) => n + f.file.size, 0) + file.size > MAX_BYTES) {
        showGlobalError("attachment_failed", "Attach up to 10 files, totalling at most 512 MB.");
        continue;
      }
      const item = { file, offset: 0, state: "staging", cancelled: false, id: null, previewURL: imagePreview(file) };
      pendingFiles.push(item);
      stageQueue = stageQueue.then(() => stageAttachment(item));
    }
    renderAttachments();
  }

  function safeMediaSource(meta, kind) {
    if (!meta || meta.kind !== kind || typeof meta.src !== "string") return false;
    try {
      const url = new URL(meta.src);
      const broker = /^http:\/\/qchat-media\.localhost\/[A-Za-z0-9_-]+$/.test(meta.src) && url.protocol === "http:" && url.hostname === "qchat-media.localhost" && !url.port && !url.username && !url.password && !url.search && !url.hash && /^\/[A-Za-z0-9_-]+$/.test(url.pathname);
      const mockRaster = IS_MOCK && kind === "image" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(meta.src);
      if (!broker && !mockRaster) return false;
      const mime = String(meta.mime || "").toLowerCase().split(";")[0].trim();
      if (kind === "image") return /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(mime);
      if (kind === "audio") return /^audio\/(mpeg|mp3|mp4|ogg|wav|x-wav|webm|aac|flac)$/.test(mime);
      if (kind === "video") return /^video\/(mp4|webm|ogg|quicktime)$/.test(mime);
      return false;
    } catch (_) { return false; }
  }
  function appendMedia(turn, items) {
    const entry = turnNodes.get(turn.id);
    if (!entry) return;
    for (let item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== "string") continue;
      let existing = entry.mediaItems.get(item.id);
      if (existing && existing.item.kind !== item.kind) { existing.card.remove(); entry.mediaItems.delete(item.id); existing = null; }
      if (existing) {
        const changed = existing.item.revision !== item.revision || existing.item.pending !== item.pending;
        Object.assign(existing.item, item);
        if (changed && item.kind === "image") void existing.loadMedia(true);
        continue;
      }
      item = { ...item };
      const kind = ["image", "audio", "video"].includes(item.kind) ? item.kind : "file";
      const card = make("div", "media-card");
      const status = make("span", "media-status");
      const preview = make("div", "media-preview");
      const actions = make("div", "media-actions");
      const view = make("button", "hyperlink-btn", "View in ChatGPT");
      view.type = "button";
      view.addEventListener("click", openSignin);
      const save = make("button", "btn btn-compact", "Save to Downloads");
      save.type = "button";
      save.addEventListener("click", async () => {
        save.disabled = true;
        try { await invoke("media_save", { mediaId: item.id, revision: item.revision || 0 }); status.textContent = "Saved to Downloads"; }
        catch (_) { status.textContent = "Could not save. View in ChatGPT to download."; }
        finally { save.disabled = false; }
      });
      actions.append(save, view);
      card.append(make("div", "attachment-name", typeof item.name === "string" ? item.name : "File"), preview, status, actions);
      entry.mediaEl.append(card);
      const record = { item, card, loadMedia: () => {} };
      entry.mediaItems.set(item.id, record);
      if (kind === "file") continue;
      const load = make("button", "btn btn-compact", "Load");
      load.type = "button";
      actions.prepend(load);
      let loaded = false, loadingRevision, loadedRevision, imageNode;
      const loadMedia = async (refresh = false) => {
        const revision = item.revision || 0;
        if (item.pending) { status.textContent = "Creating image…"; return; }
        if ((loaded && (!refresh || loadedRevision === revision)) || load.disabled) return imageNode;
        load.disabled = true;
        loadingRevision = revision;
        status.textContent = "Loading…";
        try {
          const meta = await invoke("media_load", { mediaId: item.id, revision });
          if (!safeMediaSource(meta, kind)) throw new Error("Unsupported media");
          if (turnNodes.get(turn.id) !== entry) return;
          const media = make(kind === "image" ? "img" : kind);
          if (kind === "image") { media.alt = typeof item.name === "string" ? item.name : "Image"; media.crossOrigin = "anonymous"; media.loading = "eager"; imageNode = media; }
          else { media.controls = true; media.preload = "none"; media.autoplay = false; }
          media.addEventListener("error", () => { loaded = false; load.hidden = false; status.textContent = "Preview unavailable. Retry loading the image."; });
          media.addEventListener("load", () => scrollToBottom(false));
          media.src = meta.src;
          preview.replaceChildren(media);
          loaded = true; loadedRevision = revision;
          load.hidden = true;
          status.textContent = "";
        } catch (_) { status.textContent = "Preview unavailable. View in ChatGPT."; }
        finally {
          load.disabled = false;
          if (kind === "image" && (item.revision || 0) !== loadingRevision) void loadMedia(true);
        }
        return imageNode;
      };
      record.loadMedia = loadMedia;
      load.addEventListener("click", loadMedia);
      if (kind === "image") { actions.insertBefore(imageCopyButton(async () => { await loadMedia(); return imageNode; }), save); void loadMedia(); }
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Window sizing
  // ---------------------------------------------------------------------------
  let bubbleMax = 480;
  let lastFit = { width: 0, height: 0 };
  let fitQueued = false;
  let shrinkTimer = null;
  let sizesQueued = false;

  const responseEntry = () => {
    for (const turn of turns) {
      const entry = turnNodes.get(turn.id);
      if (entry?.bubble && !entry.row.hidden) return entry;
    }
    return null;
  };

  function updateBubbleMax() {
    const chrome = el.stack.offsetHeight - (el.zone.hidden ? 0 : el.zone.offsetHeight);
    const pct = QSettings.settings.maxHeightPct / 100;
    bubbleMax = Math.max(120, Math.round(pct * window.screen.availHeight) - chrome);
  }

  // Layout reads only; the bubble's width and height ease towards what the text needs.
  function syncBubbleSize(entry) {
    if (!entry?.bubble || entry.row.hidden) return;
    const capped = entry.inner.offsetHeight > bubbleMax;
    if (capped !== entry.row.hasAttribute("data-capped")) entry.row.toggleAttribute("data-capped", capped);
    const barWidth = el.stack.offsetWidth;
    const width = capped ? barWidth : Math.min(entry.inner.offsetWidth, barWidth);
    const target = Math.min(entry.inner.offsetHeight, bubbleMax);
    entry.targetHeight = target;
    entry.bubble.style.width = `${width}px`;
    entry.bubble.style.height = `${target}px`;
    followStream(entry);
  }

  function followStream(entry) {
    if (!entry.row.hasAttribute("data-capped")) {
      if (entry.jump) entry.jump.hidden = true;
      return;
    }
    if (!userScrolledUp) entry.scroller.scrollTop = entry.scroller.scrollHeight;
  }

  const scrollToBottom = () => { const entry = responseEntry(); if (entry) followStream(entry); };

  function queueSizes() {
    if (sizesQueued) return;
    sizesQueued = true;
    nextFrame(() => {
      sizesQueued = false;
      updateBubbleMax();
      const entry = responseEntry();
      if (entry) syncBubbleSize(entry);
      queueFit();
    });
  }

  function wantedSize() {
    let height = el.stack.offsetHeight;
    const entry = responseEntry();
    if (entry && entry.targetHeight > entry.bubble.offsetHeight) height += entry.targetHeight - entry.bubble.offsetHeight;
    return { width: el.stack.offsetWidth + 2 * GUTTER, height: height + 2 * GUTTER };
  }

  function sendFit(width, height) {
    if (width === lastFit.width && height === lastFit.height) return;
    lastFit = { width, height };
    invoke("fit_window", { width, height }).catch(() => {});
  }

  function fitNow() {
    const want = wantedSize();
    const entry = responseEntry();
    const growing = isStreaming() && entry && !entry.row.hasAttribute("data-capped");
    if (want.height > lastFit.height || want.width !== lastFit.width) {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
      // While text streams, ask for spare room so each new line doesn't resize the OS window.
      const spare = growing ? STREAM_HEADROOM : 0;
      const height = want.height > lastFit.height ? want.height + spare : lastFit.height;
      sendFit(want.width, height);
    } else if (want.height < lastFit.height) {
      if (growing || shrinkTimer) return;
      // Shrink only after the exit animation, so nothing leaving gets clipped.
      shrinkTimer = setTimeout(() => {
        shrinkTimer = null;
        if (isStreaming() && responseEntry()) return;
        const now = wantedSize();
        sendFit(now.width, now.height);
      }, QSettings.timings.t3 + 60);
    } else {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
    }
  }

  function queueFit() {
    if (fitQueued) return;
    fitQueued = true;
    nextFrame(() => { fitQueued = false; fitNow(); });
  }

  const sizeObserver = new ResizeObserver(() => queueSizes());
  sizeObserver.observe(el.stack);

  // ---------------------------------------------------------------------------
  // 8. Bubbles
  // ---------------------------------------------------------------------------
  function syncZone() {
    el.zone.hidden = el.zone.childElementCount === 0;
    updateIdleChips();
    queueSizes();
  }

  function createUserRow(turn) {
    const row = make("article", "turn-row");
    row.dataset.id = turn.id;
    row.dataset.role = "user";
    row.dataset.status = turn.status;
    row.setAttribute("aria-label", "You said");

    const bubble = make("div", "bubble bubble-user glass glass-tiny");
    const contentEl = make("div", "turn-content", turn.text);
    const mediaEl = make("div", "turn-media");
    for (const file of turn.attachments || []) {
      if (!file.previewURL) { mediaEl.append(make("div", "attachment-chip", `${file.name} · ${fileSize(file.size)}`)); continue; }
      const card = make("div", "media-card uploaded-image");
      const preview = make("div", "media-preview"); const image = previewImage(file.previewURL, file.name); preview.append(image);
      card.append(preview, imageCopyButton(() => image)); mediaEl.append(card);
    }
    bubble.append(contentEl, mediaEl);

    const thinking = make("div", "thinking");
    thinking.setAttribute("role", "status");
    thinking.setAttribute("aria-label", "ChatGPT is thinking");
    thinking.append(make("span"), make("span"), make("span"));

    row.append(bubble, thinking);
    turnNodes.set(turn.id, { row, contentEl, mediaEl, mediaItems: new Map() });
    return row;
  }

  function createResponseRow(turn) {
    const row = make("article", "turn-row");
    row.dataset.id = turn.id;
    row.dataset.role = "assistant";
    row.dataset.status = turn.status;
    row.setAttribute("aria-label", "ChatGPT replied");
    row.hidden = true;

    const bubble = make("div", "bubble bubble-response glass");
    const scroller = make("div", "bubble-scroll scroll");
    const inner = make("div", "bubble-inner turn-body");
    const contentEl = make("div", "turn-content");
    const mediaEl = make("div", "turn-media");
    const generation = make("div", "image-generation");
    generation.hidden = true; generation.setAttribute("role", "status"); generation.setAttribute("aria-live", "polite");
    generation.append(makeProgressRing(), make("span", "image-generation-label", "Creating image…"), make("span", "image-generation-value"));
    const errorWrap = make("div", "turn-error");
    errorWrap.hidden = true;
    inner.append(contentEl, mediaEl, generation, errorWrap);
    scroller.append(inner);
    bubble.append(scroller, make("div", "stream-sheen"));

    const tools = make("div", "bubble-tools glass glass-tiny");
    const copyBtn = make("button", "tool-btn");
    copyBtn.type = "button";
    copyBtn.dataset.action = "copy-turn";
    copyBtn.dataset.id = turn.id;
    copyBtn.title = "Copy";
    copyBtn.setAttribute("aria-label", "Copy reply");
    copyBtn.append(makeIcon(GLYPH.copy));
    const closeBtn = make("button", "tool-btn");
    closeBtn.type = "button";
    closeBtn.dataset.action = "dismiss-turn";
    closeBtn.title = "Dismiss (Esc)";
    closeBtn.setAttribute("aria-label", "Dismiss reply");
    closeBtn.append(makeIcon(GLYPH.close));
    tools.append(copyBtn, closeBtn);

    const jump = make("button", "jump-chip glass glass-tiny");
    jump.type = "button";
    jump.hidden = true;
    jump.title = "Jump to latest";
    jump.append(makeIcon(GLYPH.down), document.createTextNode("Latest"));
    jump.addEventListener("click", () => {
      userScrolledUp = false;
      jump.hidden = true;
      scroller.scrollTop = scroller.scrollHeight;
    });

    scroller.addEventListener("scroll", () => {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 28;
      userScrolledUp = !nearBottom;
      jump.hidden = nearBottom || !row.hasAttribute("data-capped");
    });

    row.append(bubble, tools, jump);
    const entry = { row, bubble, scroller, inner, contentEl, errorWrap, mediaEl, generation, jump, mediaItems: new Map(), targetHeight: 0 };
    turnNodes.set(turn.id, entry);
    sizeObserver.observe(inner);
    return row;
  }

  function buildTurnError(turn) {
    const line = make("div", "error-line");
    line.setAttribute("role", "alert");
    line.append(makeIcon(GLYPH.errorBadge), make("p", "error-text", turn.error || "Something went wrong."));
    const actions = make("div", "error-actions");
    if (turn.code === "auth") {
      const signin = make("button", "btn btn-compact btn-accent", "Sign in");
      signin.type = "button";
      signin.dataset.action = "signin";
      actions.appendChild(signin);
    }
    if ((!turn.hadAttachments && turn.prompt) || pendingFiles.some((f) => f.state === "ready")) {
      const retry = make("button", "btn btn-compact", "Retry");
      retry.type = "button";
      retry.dataset.action = "retry-turn";
      retry.dataset.id = turn.id;
      actions.appendChild(retry);
    }
    if (turn.hadAttachments) {
      const view = make("button", "btn btn-compact", "View in ChatGPT");
      view.type = "button";
      view.dataset.action = "signin";
      actions.appendChild(view);
    }
    if (actions.childElementCount) line.append(actions);
    return line;
  }

  function renderTurnNow(turnId) {
    const sched = renderSchedule.get(turnId);
    if (sched) {
      sched.queued = false;
      if (sched.timerId) clearTimeout(sched.timerId);
      sched.timerId = null;
      sched.lastRenderTs = performance.now();
    }

    const turn = turns.find((t) => t.id === turnId);
    const entry = turnNodes.get(turnId);
    if (!turn || !entry || turn.role !== "assistant") return;

    entry.row.dataset.status = turn.status;
    const generation = entry.generation;
    generation.hidden = turn.status !== "streaming" || turn.imageProgress?.state !== "generating";
    const percentage = turn.imageProgress?.percentage;
    const known = Number.isFinite(percentage);
    generation.toggleAttribute("data-percentage", known);
    generation.style.setProperty("--image-progress", known ? Math.max(0, Math.min(100, percentage)) : 0);
    generation.querySelector(".image-generation-value").textContent = known ? `${percentage}%` : "";
    generation.querySelector(".image-generation-label").textContent = turn.imageProgress?.phase === "preparing" ? "Preparing image…" : "Creating image…";

    entry.contentEl.innerHTML = renderMarkdownSafe(turn.text);
    if (turn.status === "error") {
      entry.errorWrap.replaceChildren(buildTurnError(turn));
      entry.errorWrap.hidden = false;
    } else {
      entry.errorWrap.hidden = true;
      entry.errorWrap.replaceChildren();
    }
    entry.row.toggleAttribute("data-empty", !turn.text && !entry.mediaEl.childElementCount);
    followStream(entry);
    queueSizes();
  }

  function scheduleTurnRender(turnId, immediate = false) {
    if (immediate) {
      renderTurnNow(turnId);
      return;
    }
    let sched = renderSchedule.get(turnId);
    if (!sched) {
      sched = { queued: false, timerId: null, lastRenderTs: 0 };
      renderSchedule.set(turnId, sched);
    }
    if (sched.queued) return;
    sched.queued = true;
    const waitMs = Math.max(0, 50 - (performance.now() - sched.lastRenderTs));
    sched.timerId = setTimeout(() => {
      sched.timerId = null;
      nextFrame(() => { if (sched.queued) renderTurnNow(turnId); });
    }, waitMs);
  }

  // First real output: the prompt bows out and the response takes its place.
  function revealResponse(turn, entrance = "swapping") {
    const entry = turnNodes.get(turn.id);
    if (!entry?.bubble || !entry.row.hidden) return;
    renderTurnNow(turn.id);
    entry.row.classList.add("no-size-ease");
    entry.row.hidden = false;
    updateBubbleMax();
    syncBubbleSize(entry);
    void entry.row.offsetWidth;
    entry.row.classList.remove("no-size-ease");
    entry.row.classList.add(entrance);
    entry.row.addEventListener("animationend", () => entry.row.classList.remove(entrance), { once: true });

    for (const other of turns.slice()) if (other.role === "user") retireTurn(other);
    queueSizes();
    fitNow();
  }

  function retireTurn(turn, immediate = false) {
    const index = turns.indexOf(turn);
    if (index >= 0) turns.splice(index, 1);
    for (const file of turn.attachments || []) releasePreview(file.previewURL);
    const entry = turnNodes.get(turn.id);
    const sched = renderSchedule.get(turn.id);
    if (sched?.timerId) clearTimeout(sched.timerId);
    if (sched) sched.queued = false;
    renderSchedule.delete(turn.id);
    turnNodes.delete(turn.id);
    if (!entry) return;
    if (entry.inner) sizeObserver.unobserve(entry.inner);
    const { row } = entry;
    if (immediate || row.hidden || !QSettings.motionOn) {
      row.remove();
    } else {
      row.dataset.side = turn.role;
      row.removeAttribute("data-role");
      row.removeAttribute("aria-label");
      row.setAttribute("aria-hidden", "true");
      row.classList.remove("rising", "swapping");
      row.classList.add("leaving");
      setTimeout(() => { row.remove(); syncZone(); }, QSettings.timings.t2 + 30);
    }
    syncZone();
  }

  function dismissExchange(immediate = false) {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
    userScrolledUp = false;
    for (const turn of turns.slice()) retireTurn(turn, immediate);
    updateComposerMode();
  }

  function armAutoDismiss() {
    clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
    const seconds = QSettings.settings.autoDismiss;
    if (!seconds) return;
    const check = () => {
      const entry = responseEntry();
      if (!entry || isBusy()) return;
      if (entry.row.matches(":hover, :focus-within")) { autoDismissTimer = setTimeout(check, 1500); return; }
      dismissExchange();
    };
    autoDismissTimer = setTimeout(check, seconds * 1000);
  }

  function showCachedResponse(chat) {
    if (!chat.lastResponse) return;
    const turn = { id: crypto.randomUUID(), role: "assistant", text: chat.lastResponse, status: "done", chatKey: chat.key, prompt: chat.lastPrompt };
    turns.push(turn);
    el.zone.append(createResponseRow(turn));
    el.zone.hidden = false;
    revealResponse(turn);
  }

  // ---------------------------------------------------------------------------
  // 9. Composer
  // ---------------------------------------------------------------------------
  function updateComposerMode() {
    const active = isStreaming();
    const sendKey = QSettings.settings.sendKey === "ctrl" ? "Ctrl+Enter" : "Enter";
    el.btnSend.dataset.mode = active ? "stop" : "send";
    el.btnSend.firstElementChild.textContent = active ? GLYPH.stop : GLYPH.send;
    el.btnSend.title = active ? "Stop generating (Ctrl+.)" : `Send (${sendKey})`;
    el.btnSend.setAttribute("aria-label", active ? "Stop generating" : "Send");
    el.btnAttach.disabled = active || sending;
    el.btnSend.disabled = !active && (sending || pendingFiles.some((f) => f.state !== "ready") || (!el.promptInput.value.trim() && !pendingFiles.length));
    syncTabsDisabled();
  }

  function autoResizePrompt() {
    const input = el.promptInput;
    input.style.height = "auto";
    const full = input.scrollHeight;
    const style = getComputedStyle(input);
    const max = parseFloat(style.lineHeight) * 6 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    input.style.height = `${Math.min(full, max)}px`;
    input.style.overflowY = full > max + 1 ? "auto" : "hidden";
    updateComposerMode();
  }

  const IMAGE_PROMPT = /^(?:please\s+)?(?:generate|create|draw|paint|render|make|design)\b[\s\S]{0,100}\b(?:image|picture|photo|illustration|artwork|portrait)\b/i;

  async function sendPrompt(rawPrompt, { fromInput = false } = {}) {
    const prompt = String(rawPrompt ?? "").trim();
    if (isBusy() || pendingFiles.some((f) => f.state !== "ready") || (!prompt && !pendingFiles.length)) return;
    sending = true;
    const generation = chatGeneration;
    const chat = chats.current;
    const files = pendingFiles.slice();
    const draft = el.promptInput.value;
    const restoreDraft = () => {
      if (fromInput && !el.promptInput.value) { el.promptInput.value = draft; autoResizePrompt(); }
    };

    hideGlobalError();
    closeSlashMenu();
    hideClearConfirm();
    dismissExchange();
    sentThisSession = true;

    const userTurn = { id: crypto.randomUUID(), role: "user", text: prompt, status: "done", attachments: files.map((f) => ({ name: f.file.name, size: f.file.size, previewURL: imagePreview(f.file) })) };
    const assistantTurn = { id: crypto.randomUUID(), role: "assistant", text: "", status: "streaming", prompt, hadAttachments: files.length > 0, chatKey: chat.key };
    if (IMAGE_PROMPT.test(prompt)) assistantTurn.imageProgress = { state: "generating", phase: "preparing" };

    turns.push(userTurn, assistantTurn);
    const userRow = createUserRow(userTurn);
    userRow.classList.add("rising");
    userRow.addEventListener("animationend", (e) => { if (e.animationName === "rise-in") userRow.classList.remove("rising"); });
    el.zone.append(userRow, createResponseRow(assistantTurn));
    el.zone.hidden = false;
    if (assistantTurn.imageProgress) {
      // Image generation has a long silence up front: show its progress once the prompt has risen.
      renderTurnNow(assistantTurn.id);
      setTimeout(() => { if (assistantTurn.status === "streaming") revealResponse(assistantTurn); }, QSettings.timings.t4);
    }

    const label = prompt || files[0]?.file.name || "Attachment";
    chat.title = chat.title || label.slice(0, 40);
    chat.lastPrompt = label.slice(0, 4000);
    chat.lastActive = Date.now();
    saveChats();

    if (fromInput) { el.promptInput.value = ""; autoResizePrompt(); }
    updateGuestNotice();
    updateIdleChips();
    updateComposerMode();
    syncZone();

    try {
      await ensurePage(chat);
      if (generation !== chatGeneration) return;
      if (assistantTurn.status !== "streaming") throw { code: "stopped" };
      await invoke("chat_send", { id: assistantTurn.id, prompt, attachmentIds: files.map((f) => f.id) });
      page = { ...page, key: chat.key, pristine: false };
      for (const file of files) {
        const index = pendingFiles.indexOf(file);
        if (index >= 0) { pendingFiles.splice(index, 1); releasePreview(file.previewURL); }
      }
      if (generation === chatGeneration && assistantTurn.status === "done" && !assistantTurn.text && !assistantTurn.media?.length) dismissExchange();
    } catch (err) {
      if (generation !== chatGeneration) return;
      restoreDraft();
      if (assistantTurn.status === "done" && !assistantTurn.text && !assistantTurn.media?.length) {
        retireTurn(userTurn, true);
        retireTurn(assistantTurn, true);
        updateComposerMode();
        return;
      }
      if (assistantTurn.status !== "streaming") return;
      const code = errorCode(err);
      assistantTurn.status = "error";
      assistantTurn.code = code;
      assistantTurn.error = formatErrorCopy(code);
      revealResponse(assistantTurn);
      scheduleTurnRender(assistantTurn.id, true);
      updateComposerMode();
    } finally {
      if (generation === chatGeneration) sending = false;
      renderAttachments();
    }
  }

  async function stopStreaming() {
    if (!isStreaming()) return;
    try { await invoke("chat_stop"); } catch (_) {}
    for (const t of turns.slice()) {
      if (t.status === "streaming") {
        t.status = "done";
        recordPartial(t);
        const entry = turnNodes.get(t.id);
        if (t.text || t.media?.length) { revealResponse(t); scheduleTurnRender(t.id, true); }
        else if (entry && !entry.row.hidden) scheduleTurnRender(t.id, true);
      }
    }
    if (!sending && !turns.some((t) => t.role === "assistant" && (t.text || t.media?.length))) dismissExchange();
    updateComposerMode();
    queueSizes();
  }

  function discardPendingFiles() {
    for (const item of pendingFiles.slice()) removeAttachment(item);
    for (const url of [...imageURLs]) releasePreview(url);
  }

  async function startNewChat(notifyBackend = true) {
    for (const t of turns) recordPartial(t);
    chatGeneration++;
    sending = false;
    discardPendingFiles();
    el.promptInput.value = "";
    autoResizePrompt();
    hideGlobalError();
    closeSlashMenu();
    hideClearConfirm();
    dismissExchange();

    if (hasContent(chats.current)) { chats.current.lastActive = Date.now(); pushRecent(chats.current); }
    chats.current = freshChat();
    saveChats();
    renderTabs();
    updateIdleChips();
    updateComposerMode();

    if (notifyBackend) {
      const chat = chats.current;
      page = { key: chat.key, conv: null, pristine: false };
      pageSync = invoke("chat_new").catch(() => { page = { key: null, conv: null, pristine: false }; });
    }
    el.promptInput.focus();
  }

  // ---------------------------------------------------------------------------
  // 10. Recent-chat tabs
  // ---------------------------------------------------------------------------
  const elapsedLabel = (timestamp, now = Date.now()) => {
    const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  function tabsVisible() {
    const s = QSettings.settings;
    return s.showTabs && s.keepHistory && chats.recent.length > 0;
  }

  function syncTabsDisabled() {
    const busy = isBusy();
    for (const tab of el.tabs.children) tab.disabled = busy;
  }

  function renderTabs() {
    const visible = tabsVisible();
    el.tabs.hidden = !visible;
    if (!visible) { el.tabs.replaceChildren(); queueSizes(); return; }

    const existing = new Map([...el.tabs.children].map((node) => [node.dataset.key, node]));
    let fresh = 0;
    const nodes = chats.recent.map((chat) => {
      let tab = existing.get(chat.key);
      if (!tab) {
        tab = make("button", "tab glass glass-tiny pop");
        tab.type = "button";
        tab.dataset.key = chat.key;
        tab.style.setProperty("--i", String(fresh++));
        tab.append(makeIcon(GLYPH.clock), make("span", "tab-label"));
        tab.addEventListener("animationend", () => tab.classList.remove("pop"), { once: true });
        tab.addEventListener("click", () => switchToChat(tab.dataset.key));
      }
      const label = elapsedLabel(chat.lastActive);
      tab.querySelector(".tab-label").textContent = label;
      const title = chat.title || "Untitled chat";
      const when = label === "now" ? "just now" : `${label} ago`;
      tab.title = `${title}\nLast active ${when}`;
      tab.setAttribute("aria-label", `Switch to chat: ${title}, last active ${when}`);
      return tab;
    });
    el.tabs.replaceChildren(...nodes);
    syncTabsDisabled();
    queueSizes();
  }

  function switchToChat(key) {
    if (isBusy()) return;
    const index = chats.recent.findIndex((c) => c.key === key);
    if (index < 0) return;
    chatGeneration++;
    discardPendingFiles();
    hideGlobalError();
    closeSlashMenu();
    hideClearConfirm();
    dismissExchange();

    const now = Date.now();
    const target = chats.recent[index];
    const previous = chats.current;
    chats.recent.splice(index, 1);
    if (hasContent(previous)) { previous.lastActive = now; chats.recent.unshift(previous); }
    chats.recent = chats.recent.slice(0, MAX_RECENT);
    target.lastActive = now;
    chats.current = target;
    saveChats();
    renderTabs();
    updateIdleChips();
    showCachedResponse(target);

    // A chat without a server id reopens lazily: its first send starts fresh.
    if (target.conversationId) {
      pageSync = pageSync.catch(() => {}).then(() => {
        if (chats.current === target && page.conv !== target.conversationId) return openInPage(target);
      }).catch(() => {});
    }
    updateComposerMode();
    el.promptInput.focus();
  }

  // ---------------------------------------------------------------------------
  // 11. Slash commands
  // ---------------------------------------------------------------------------
  const COMMANDS = [
    { name: "settings", icon: GLYPH.settings, desc: () => "Open settings", run: () => invoke("open_settings").catch(() => {}) },
    { name: "new", icon: GLYPH.newChat, desc: () => "Start a new chat", run: () => startNewChat(true) },
    { name: "signin", icon: GLYPH.account, desc: () => (bridge.loggedIn ? "Manage account" : "Sign in to ChatGPT"), run: () => openSignin() },
    { name: "clear", icon: GLYPH.trash, desc: () => "Clear recent chats", run: () => showClearConfirm() },
    { name: "hide", icon: GLYPH.hide, desc: () => "Hide QChat", run: () => invoke("hide_main").catch(() => {}) }
  ];
  let slashMatches = [];
  let slashIndex = 0;

  const slashOpen = () => !el.slashMenu.hidden;

  function syncMenuFlag() {
    const away = slashOpen() || !el.clearConfirm.hidden;
    if (away) el.stack.dataset.menu = ""; else delete el.stack.dataset.menu;
  }

  function closeSlashMenu() {
    el.slashMenu.hidden = true;
    el.slashMenu.replaceChildren();
    slashMatches = [];
    el.promptInput.setAttribute("aria-expanded", "false");
    el.promptInput.removeAttribute("aria-activedescendant");
    syncMenuFlag();
    queueSizes();
  }

  function paintSlashSelection() {
    [...el.slashMenu.children].forEach((node, i) => {
      node.setAttribute("aria-selected", String(i === slashIndex));
      if (i === slashIndex) el.promptInput.setAttribute("aria-activedescendant", node.id);
    });
  }

  function updateSlashMenu() {
    const value = el.promptInput.value;
    const query = /^\/\S*$/.test(value) ? value.slice(1).toLowerCase() : null;
    const matches = query === null ? [] : COMMANDS.filter((c) => c.name.startsWith(query));
    if (!matches.length) { if (slashOpen()) closeSlashMenu(); return; }
    const wasOpen = slashOpen();
    slashMatches = matches;
    slashIndex = wasOpen ? Math.min(slashIndex, matches.length - 1) : 0;
    el.slashMenu.replaceChildren(...matches.map((cmd) => {
      const item = make("div", "slash-item");
      item.id = `slash-${cmd.name}`;
      item.setAttribute("role", "option");
      item.dataset.command = cmd.name;
      item.append(makeIcon(cmd.icon), make("span", "slash-name", `/${cmd.name}`), make("span", "slash-desc", cmd.desc()));
      item.addEventListener("mousedown", (e) => { e.preventDefault(); runCommand(cmd); });
      return item;
    }));
    el.slashMenu.hidden = false;
    el.promptInput.setAttribute("aria-expanded", "true");
    paintSlashSelection();
    syncMenuFlag();
    queueSizes();
  }

  function runCommand(cmd) {
    el.promptInput.value = "";
    closeSlashMenu();
    autoResizePrompt();
    cmd.run();
  }

  function showClearConfirm() {
    el.clearConfirm.hidden = false;
    syncMenuFlag();
    queueSizes();
    el.btnClearYes.focus();
  }

  function hideClearConfirm() {
    if (el.clearConfirm.hidden) return;
    el.clearConfirm.hidden = true;
    syncMenuFlag();
    queueSizes();
  }

  function submitFromInput() {
    const value = el.promptInput.value.trim();
    const exact = value.startsWith("/") && COMMANDS.find((c) => `/${c.name}` === value.toLowerCase());
    if (exact) { runCommand(exact); return; }
    closeSlashMenu();
    sendPrompt(el.promptInput.value, { fromInput: true });
  }

  // ---------------------------------------------------------------------------
  // 12. Status
  // ---------------------------------------------------------------------------
  // Readiness and authentication are separate while the ChatGPT page loads.
  function updateStatusHeader({ ready, loggedIn, errorState, signedOut }) {
    let state;
    let label;
    if (signedOut) { state = "signed-out"; label = "Signed out"; }
    else if (errorState) { state = "error"; label = "Error"; }
    else if (!ready) { state = "connecting"; label = loggedIn ? "Loading chat…" : "Connecting…"; }
    else if (loggedIn) { state = "ready"; label = "Ready"; }
    else { state = "guest"; label = "Guest"; }

    el.statusDot.dataset.state = state;
    el.statusLabel.textContent = label;
    el.orb.title = `Drag QChat · ${label}`;

    if (!errorState) {
      bridge.ready = Boolean(ready);
      bridge.loggedIn = Boolean(loggedIn);
      bridge.signedOut = Boolean(signedOut);
    }
    updateGuestNotice();
  }

  function updateGuestNotice() {
    const show = bridge.ready && !bridge.loggedIn && !guestDismissed && (bridge.signedOut || !sentThisSession);
    if (bridge.signedOut) {
      el.guestTitle.textContent = "Signed out";
      el.guestMessage.textContent = "Sign in again to keep chatting.";
    } else {
      el.guestTitle.textContent = "Guest mode";
      el.guestMessage.textContent = "Sign in to use your models and history.";
    }
    if (el.guestNotice.hidden === show) { el.guestNotice.hidden = !show; queueSizes(); }
  }

  function updateIdleChips() {
    const show = QSettings.settings.showSuggestions && !turns.length && !hasContent(chats.current) && !pendingFiles.length && !el.promptInput.value;
    if (el.suggestions.hidden === show) { el.suggestions.hidden = !show; queueSizes(); }
  }

  function showGlobalError(code, message) {
    el.globalErrorText.textContent = formatErrorCopy(code, message);
    el.btnErrorSignin.hidden = code !== "auth";
    el.globalError.hidden = false;
    updateStatusHeader({ ready: true, loggedIn: false, signedOut: code === "auth", errorState: code !== "auth" });
    queueSizes();
  }

  function hideGlobalError() {
    if (el.globalError.hidden) return;
    el.globalError.hidden = true;
    el.globalErrorText.textContent = "";
    el.btnErrorSignin.hidden = true;
    queueSizes();
  }

  const openSignin = () => invoke("show_signin").catch(() => {});

  // ---------------------------------------------------------------------------
  // 13. Clipboard
  // ---------------------------------------------------------------------------
  async function copyWithFeedback(text, buttonEl) {
    try {
      await navigator.clipboard.writeText(String(text ?? ""));
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = String(text ?? "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
    }
    if (!buttonEl) return;
    const icon = buttonEl.querySelector(".icon");
    const label = buttonEl.querySelector(".btn-label");
    if (buttonEl._copyTimer) clearTimeout(buttonEl._copyTimer);
    else {
      buttonEl._prevTitle = buttonEl.title;
      if (label) buttonEl._prevLabel = label.textContent;
    }
    if (icon) icon.textContent = GLYPH.check;
    if (label) label.textContent = "Copied";
    buttonEl.title = "Copied";
    buttonEl._copyTimer = setTimeout(() => {
      buttonEl._copyTimer = null;
      if (icon) icon.textContent = GLYPH.copy;
      if (label) label.textContent = buttonEl._prevLabel;
      buttonEl.title = buttonEl._prevTitle;
    }, 1200);
  }

  // ---------------------------------------------------------------------------
  // 14. Settings
  // ---------------------------------------------------------------------------
  let lastPrefs = "";

  function sendWindowPrefs() {
    const { alwaysOnTop, rememberPosition } = QSettings.settings;
    const prefs = JSON.stringify({ alwaysOnTop, rememberPosition });
    if (prefs === lastPrefs) return;
    lastPrefs = prefs;
    invoke("set_window_prefs", { alwaysOnTop, rememberPosition }).catch(() => {});
  }

  function onSettingsApplied() {
    const s = QSettings.settings;
    if (!s.keepHistory) {
      chats.recent = [];
      saveChats();
    }
    sendWindowPrefs();
    renderTabs();
    updateIdleChips();
    autoResizePrompt();
    if (!isBusy() && responseEntry()) armAutoDismiss();
    queueSizes();
  }

  function receiveSettings(raw) {
    QSettings.apply(document.documentElement, raw);
    onSettingsApplied();
  }

  // ---------------------------------------------------------------------------
  // 15. Event Wiring & Bridge Listener
  // ---------------------------------------------------------------------------
  el.zone.addEventListener("click", (e) => {
    const anchor = e.target.closest("a");
    if (anchor) {
      e.preventDefault();
      const safeUrl = sanitizeHref(anchor.getAttribute("href") || "");
      if (safeUrl) invoke("open_external", { url: safeUrl }).catch(() => {});
      return;
    }
    const actionBtn = e.target.closest("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    if (action === "copy-code") {
      const codeEl = actionBtn.closest(".code-block")?.querySelector("pre code");
      if (codeEl) copyWithFeedback(codeEl.textContent, actionBtn);
    } else if (action === "copy-turn") {
      const turn = turns.find((t) => t.id === actionBtn.dataset.id);
      if (turn) copyWithFeedback(turn.text, actionBtn);
    } else if (action === "dismiss-turn") {
      dismissExchange();
      el.promptInput.focus();
    } else if (action === "retry-turn") {
      const turn = turns.find((t) => t.id === actionBtn.dataset.id);
      if (turn && typeof turn.prompt === "string" && !isStreaming()) sendPrompt(turn.prompt);
    } else if (action === "view-media") {
      const row = actionBtn.closest(".turn-row");
      const media = row?.querySelector(".turn-media .media-card");
      if (media) media.scrollIntoView({ block: "nearest" });
      else openSignin();
    } else if (action === "signin") {
      openSignin();
    }
  });

  el.suggestions.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-suggestion]");
    if (!chip) return;
    el.promptInput.value = chip.dataset.suggestion;
    autoResizePrompt();
    updateIdleChips();
    el.promptInput.focus();
    const end = el.promptInput.value.length;
    el.promptInput.setSelectionRange(end, end);
  });

  el.promptInput.addEventListener("input", () => {
    autoResizePrompt();
    updateSlashMenu();
    updateIdleChips();
  });

  let filePickerOpen = false;
  el.btnAttach.addEventListener("click", () => { filePickerOpen = true; el.attachmentInput.click(); });
  el.attachmentInput.addEventListener("cancel", () => { filePickerOpen = false; });
  el.attachmentInput.addEventListener("change", () => { filePickerOpen = false; addFiles(el.attachmentInput.files); el.attachmentInput.value = ""; updateIdleChips(); });
  el.promptInput.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.stage.addEventListener("dragover", (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = isBusy() ? "none" : "copy"; }
  });
  el.stage.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });

  el.promptInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (slashOpen()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        slashIndex = (slashIndex + step + slashMatches.length) % slashMatches.length;
        paintSlashSelection();
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        const cmd = slashMatches[slashIndex];
        if (cmd) runCommand(cmd);
        return;
      }
    }
    if (e.key !== "Enter") return;
    const needsCtrl = QSettings.settings.sendKey === "ctrl";
    const wantsSend = needsCtrl ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
    if (!wantsSend) return;
    e.preventDefault();
    if (!isStreaming()) submitFromInput();
  });

  el.btnSend.addEventListener("click", () => {
    if (isStreaming()) stopStreaming();
    else submitFromInput();
    el.promptInput.focus();
  });

  el.btnGuestSignin.addEventListener("click", openSignin);
  el.btnGuestDismiss.addEventListener("click", () => {
    guestDismissed = true;
    updateGuestNotice();
    el.promptInput.focus();
  });
  el.btnErrorSignin.addEventListener("click", openSignin);
  el.btnErrorDismiss.addEventListener("click", () => {
    hideGlobalError();
    el.promptInput.focus();
  });
  el.btnClearYes.addEventListener("click", () => {
    clearRecentChats();
    hideClearConfirm();
    el.promptInput.focus();
  });
  el.btnClearNo.addEventListener("click", () => {
    hideClearConfirm();
    el.promptInput.focus();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (slashOpen()) { closeSlashMenu(); return; }
      if (!el.clearConfirm.hidden) { hideClearConfirm(); el.promptInput.focus(); return; }
      if (!isBusy() && (turns.length || !el.globalError.hidden)) {
        hideGlobalError();
        dismissExchange();
        el.promptInput.focus();
        return;
      }
      invoke("hide_main").catch(() => {});
    } else if ((e.ctrlKey || e.metaKey) && e.key === ".") {
      e.preventDefault();
      stopStreaming();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      startNewChat(true);
    }
  });

  // Focus handling: the settings window announces itself so opening it never hides the bar.
  let settingsFocusAt = 0;
  let blurTimer = null;
  window.addEventListener("blur", () => {
    document.documentElement.classList.add("inactive");
    if (!QSettings.settings.hideOnBlur) return;
    clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      if (document.hasFocus() || filePickerOpen || isBusy()) return;
      if (Date.now() - settingsFocusAt < 600) return;
      invoke("hide_main").catch(() => {});
    }, 220);
  });
  window.addEventListener("focus", () => {
    document.documentElement.classList.remove("inactive");
    filePickerOpen = false;
    clearTimeout(blurTimer);
  });
  window.addEventListener("resize", () => queueSizes());

  listen("bridge", ({ payload: evt }) => {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "status":
        updateStatusHeader({ ready: Boolean(evt.ready), loggedIn: Boolean(evt.loggedIn) });
        settleReadyWaiters(evt);
        break;
      case "start": {
        // A late "start" must not reopen a turn that already finished or was stopped.
        const turn = turns.find((t) => t.id === evt.id);
        if (turn?.status === "streaming") {
          scheduleTurnRender(turn.id, true);
          updateComposerMode();
        }
        break;
      }
      case "delta": {
        const turn = turns.find((t) => t.id === evt.id);
        if (turn) {
          turn.status = "streaming";
          turn.text = String(evt.text ?? "");
          if (turn.text) revealResponse(turn);
          scheduleTurnRender(turn.id, false);
        }
        break;
      }
      case "media": {
        const turn = turns.find((t) => t.id === evt.id && t.role === "assistant");
        if (turn) {
          turn.media = evt.items;
          appendMedia(turn, evt.items);
          revealResponse(turn);
          turnNodes.get(turn.id)?.row.toggleAttribute("data-empty", false);
          queueSizes();
        }
        break;
      }
      case "image_progress": {
        const turn = turns.find((t) => t.id === evt.id && t.role === "assistant");
        if (turn && turn.status === "streaming") {
          turn.imageProgress = { state: evt.state, percentage: Number.isFinite(evt.percentage) ? evt.percentage : null };
          revealResponse(turn);
          scheduleTurnRender(turn.id, true);
        }
        break;
      }
      case "done": {
        const turn = turns.find((t) => t.id === evt.id);
        if (turn) {
          if (typeof evt.text === "string") turn.text = evt.text;
          turn.status = "done";
          if (turn.chatKey === chats.current.key) {
            const chat = chats.current;
            if (typeof evt.conversationId === "string" && evt.conversationId) {
              chat.conversationId = evt.conversationId;
              page = { key: chat.key, conv: evt.conversationId, pristine: false };
            }
            chat.lastResponse = turn.text.slice(0, MAX_RESPONSE);
            chat.lastActive = Date.now();
            saveChats();
          }
          if (turn.text || turn.media?.length) revealResponse(turn);
          scheduleTurnRender(turn.id, true);
          updateComposerMode();
          armAutoDismiss();
          queueSizes();
        }
        break;
      }
      case "error": {
        const turn = evt.id ? turns.find((t) => t.id === evt.id) : null;
        if (turn) {
          turn.status = "error";
          turn.code = evt.code;
          turn.error = formatErrorCopy(evt.code, evt.message);
          recordPartial(turn);
          revealResponse(turn);
          scheduleTurnRender(turn.id, true);
          updateComposerMode();
          if (evt.code === "auth") updateStatusHeader({ ready: true, loggedIn: false, signedOut: true });
        } else {
          showGlobalError(evt.code, evt.message);
          updateComposerMode();
        }
        break;
      }
    }
  });

  listen("qchat://shown", () => {
    el.promptInput.focus();
    refreshTheme();
    renderTabs();
    invoke("chat_status").catch(() => {});
    queueSizes();
  });

  listen("qchat://new-chat", () => startNewChat(true));
  listen("qchat://settings-closed", () => el.promptInput.focus());
  listen("qchat://settings-focus", () => { settingsFocusAt = Date.now(); clearTimeout(blurTimer); });
  listen("qchat://settings-changed", ({ payload }) => receiveSettings(payload));
  listen("qchat://clear-chats", () => clearRecentChats());

  window.addEventListener("storage", (e) => {
    if (e.key === QSettings.STORAGE_KEY) receiveSettings(QSettings.load());
    else if (e.key === "qchat.chats.clear") clearRecentChats();
  });

  QSettings.watchEnvironment(onSettingsApplied);
  setInterval(() => renderTabs(), 20000);

  sendWindowPrefs();
  renderTabs();
  updateIdleChips();
  autoResizePrompt();
  updateBubbleMax();
  fitNow();
  el.promptInput.focus();
  refreshTheme();
  invoke("chat_status").catch(() => {});
})();
