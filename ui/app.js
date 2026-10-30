(function () {
  "use strict";

  const IS_MOCK = typeof window.__TAURI__ === "undefined";

  // ---------------------------------------------------------------------------
  // 1. Mock Tauri Backend (installed when window.__TAURI__ is undefined)
  // ---------------------------------------------------------------------------
  if (IS_MOCK) {
    const listeners = new Map();
    let mockTimer = null;
    let mockLoggedIn = false;
    const mockFiles = new Map();
    const MOCK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";

    const emitMock = (event, payload) => {
      for (const cb of listeners.get(event) || []) {
        try { cb({ event, payload }); } catch (e) { console.error(e); }
      }
    };

    const CANNED_REPLY = [
      "Here's a small **debounce** helper. It waits until the user stops typing before running the callback:",
      "",
      "```js",
      "function debounce(fn, ms = 250) {",
      "  let timer;",
      "  return (...args) => {",
      "    clearTimeout(timer);",
      "    timer = setTimeout(() => fn(...args), ms);",
      "  };",
      "}",
      "```",
      "",
      "| Delay | Feels like |",
      "| --- | --- |",
      "| `100 ms` | Instant |",
      "| `250 ms` | Natural typing pause |",
      "",
      "More detail is on [MDN](https://developer.mozilla.org/docs/Web/API/setTimeout)."
    ].join("\n");

    const XSS_REPLY =
      "Literal payload check: <img src=x onerror=alert(1)> and <script>alert('xss')</script> are rendered safely as plain text.";

    const clearMockStream = () => {
      if (mockTimer !== null) {
        clearInterval(mockTimer);
        clearTimeout(mockTimer);
        mockTimer = null;
      }
    };

    const emitStatus = (delay) => setTimeout(() => {
      emitMock("bridge", { type: "status", ready: true, loggedIn: mockLoggedIn, url: "https://chatgpt.com/" });
    }, delay);

    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args = {}) => {
          switch (cmd) {
            case "attachment_begin": {
              const id = crypto.randomUUID();
              const meta = { id, name: args.name, mime: args.mime, size: args.size, kind: "file", offset: 0 };
              mockFiles.set(id, meta);
              return meta;
            }
            case "attachment_chunk": {
              const file = mockFiles.get(args.id);
              if (!file || args.offset !== file.offset) throw new Error("Invalid attachment chunk");
              const size = atob(args.data).length;
              if (size > 512 * 1024 || file.offset + size > file.size) throw new Error("Invalid attachment size");
              file.offset += size;
              return null;
            }
            case "attachment_finish": {
              const file = mockFiles.get(args.id);
              if (!file || file.offset !== file.size) throw new Error("Incomplete file");
              return file;
            }
            case "attachment_remove": mockFiles.delete(args.id); return null;
            case "media_load": return { id: args.mediaId, name: "Demo image.png", kind: "image", mime: "image/png", src: MOCK_PNG };
            case "media_save": return "Demo image.png";
            case "chat_status":
              emitStatus(15);
              return null;
            case "get_theme":
              return {
                accent: "#0078D4",
                accentLight1: "#429CE3",
                accentLight2: "#8AC8F0",
                accentDark1: "#005A9E",
                dark: window.matchMedia("(prefers-color-scheme: dark)").matches
              };
            case "chat_send": {
              clearMockStream();
              const { id, prompt } = args;
              const params = new URLSearchParams(window.location.search);
              const cleanPrompt = String(prompt || "").trim().toLowerCase();
              const forceError = params.get("mock") === "error" || cleanPrompt === "error";

              setTimeout(() => emitMock("bridge", { type: "start", id }), 10);
              if (params.get("mock") === "media") setTimeout(() => emitMock("bridge", { type: "media", id, items: [{ id: "demo-raster", kind: "image", name: "Demo image.png", mime: "image/png" }, { id: "demo-file", kind: "file", name: "Demo file.txt" }] }), 40);
              for (const token of args.attachmentIds || []) mockFiles.delete(token);

              if (forceError) {
                mockTimer = setTimeout(() => {
                  mockTimer = null;
                  emitMock("bridge", { type: "error", id, code: "rate_limited", message: "Rate limit reached" });
                }, 80);
                return null;
              }

              const targetText = cleanPrompt === "xss" ? XSS_REPLY : CANNED_REPLY;
              const tokens = targetText.match(/\S+\s*/g) || [targetText];
              let idx = 0;
              let acc = "";

              mockTimer = setInterval(() => {
                if (idx < tokens.length) {
                  acc += tokens[idx++];
                  emitMock("bridge", { type: "delta", id, text: acc });
                } else {
                  clearMockStream();
                  emitMock("bridge", { type: "done", id, text: targetText, conversationId: "mock-conv-1" });
                }
              }, 30);
              return null;
            }
            case "chat_stop":
            case "chat_new":
              clearMockStream();
              return null;
            case "show_signin":
              mockLoggedIn = true;
              emitStatus(20);
              return null;
            case "hide_main":
            case "set_layout":
            case "open_external":
            default:
              return null;
          }
        }
      },
      event: {
        listen: async (eventName, handler) => {
          if (!listeners.has(eventName)) listeners.set(eventName, []);
          listeners.get(eventName).push(handler);
          return () => {
            const arr = listeners.get(eventName) || [];
            const i = arr.indexOf(handler);
            if (i !== -1) arr.splice(i, 1);
          };
        }
      }
    };
  }

  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const listen = (event, cb) => window.__TAURI__.event.listen(event, cb);

  // No Mica behind a plain browser tab: paint the solid base instead.
  if (IS_MOCK) document.documentElement.classList.add("solid");

  // ---------------------------------------------------------------------------
  // 2. Theme (system accent + light/dark)
  // ---------------------------------------------------------------------------
  const DEFAULT_ACCENT = { accent: "#0078D4", accentLight1: "#429CE3", accentLight2: "#8AC8F0", accentDark1: "#005A9E" };
  const ACCENT_VARS = { accent: "--accent", accentLight1: "--accent-light1", accentLight2: "--accent-light2", accentDark1: "--accent-dark1" };
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

  function applyTheme(theme) {
    const root = document.documentElement;
    const t = theme && typeof theme === "object" ? theme : {};
    for (const [key, cssVar] of Object.entries(ACCENT_VARS)) {
      root.style.setProperty(cssVar, isHex(t[key]) ? t[key] : DEFAULT_ACCENT[key]);
    }
    const dark = typeof t.dark === "boolean" ? t.dark : darkQuery.matches;
    root.dataset.theme = dark ? "dark" : "light";
  }

  async function refreshTheme() {
    try {
      applyTheme(await invoke("get_theme"));
    } catch (_) {
      applyTheme(null);
    }
  }

  applyTheme(null);
  darkQuery.addEventListener("change", refreshTheme);

  window.addEventListener("blur", () => document.documentElement.classList.add("inactive"));
  window.addEventListener("focus", () => document.documentElement.classList.remove("inactive"));

  // ---------------------------------------------------------------------------
  // 3. Security & Markdown Configuration
  // ---------------------------------------------------------------------------
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

  const GLYPH = {
    copy: "",
    check: "",
    send: "",
    stop: "",
    retry: "",
    statusCircle: "",
    errorX: "",
    checkCircle: ""
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
  // 4. Error Copy Mapping & State
  // ---------------------------------------------------------------------------
  const ERROR_MESSAGES = {
    not_ready: "ChatGPT is still loading. Try again in a moment.",
    busy: "ChatGPT is busy with another response.",
    rate_limited: "You've hit ChatGPT's usage limit for now.",
    auth: "Your session expired. Sign in again to continue.",
    send_failed: "Couldn't send your message to ChatGPT.",
    stream_failed: "The response was interrupted.",
    timeout: "ChatGPT took too long to respond."
  };

  const formatErrorCopy = (code, fallback) =>
    (code && ERROR_MESSAGES[code]) || fallback || "Something went wrong.";

  const $ = (id) => document.getElementById(id);
  const el = {
    statusLabel: $("status-label"),
    btnNewChat: $("btn-new-chat"),
    btnSettings: $("btn-settings"),
    btnHide: $("btn-hide"),
    chatView: $("chat-view"),
    guestNotice: $("guest-notice"),
    guestTitle: $("guest-title"),
    guestMessage: $("guest-message"),
    btnGuestSignin: $("btn-guest-signin"),
    btnGuestDismiss: $("btn-guest-dismiss"),
    globalError: $("global-error"),
    globalErrorText: $("global-error-text"),
    btnErrorSignin: $("btn-error-signin"),
    btnErrorDismiss: $("btn-error-dismiss"),
    emptyState: $("empty-state"),
    turnsList: $("turns-list"),
    btnJumpLatest: $("btn-jump-latest"),
    promptInput: $("prompt-input"),
    btnSend: $("btn-send"),
    btnAttach: $("btn-attach"),
    attachmentInput: $("attachment-input"),
    attachments: $("attachments"),
    settingsPage: $("settings-page"),
    btnCloseSettings: $("btn-close-settings"),
    accountStatus: $("account-status"),
    btnSheetSignin: $("btn-sheet-signin"),
    connectProgress: $("connect-progress"),
  };

  const turns = [];
  const turnNodes = new Map();
  const renderSchedule = new Map();
  const pendingFiles = [];
  let stageQueue = Promise.resolve();
  let sending = false;
  let chatGeneration = 0;
  let userScrolledUp = false;
  let settingsOpen = false;
  let settingsHideTimer = null;
  let guestDismissed = false;
  const bridge = { ready: false, loggedIn: false, signedOut: false };

  const isStreaming = () => turns.some((t) => t.status === "streaming");

  function updateComposerMode() {
    const active = isStreaming();
    el.btnSend.dataset.mode = active ? "stop" : "send";
    el.btnSend.firstElementChild.textContent = active ? GLYPH.stop : GLYPH.send;
    el.btnSend.title = active ? "Stop generating (Ctrl+.)" : "Send (Enter) · Shift+Enter for a new line";
    el.btnSend.setAttribute("aria-label", active ? "Stop generating" : "Send");
    el.btnAttach.disabled = active || sending;
    el.btnSend.disabled = !active && (sending || pendingFiles.some(f => f.state !== "ready") || (!el.promptInput.value.trim() && !pendingFiles.length));
  }

  // Compact = just the floating composer; expanded = conversation sheet or settings.
  // CSS animates the sheet; the native window grows at once and shrinks after the animation.
  let layoutExpanded = null;
  let layoutTimer = null;
  function syncLayout() {
    const expanded = turns.length > 0 || settingsOpen;
    if (expanded === layoutExpanded) return;
    layoutExpanded = expanded;
    clearTimeout(layoutTimer);
    document.documentElement.dataset.layout = expanded ? "expanded" : "compact";
    const apply = () => invoke("set_layout", { expanded }).catch(() => {});
    if (expanded) apply();
    else layoutTimer = setTimeout(apply, 280);
  }

  function updateWorkspaceVisibility() {
    const hasTurns = turns.length > 0;
    syncLayout();
    el.emptyState.hidden = hasTurns;
    el.turnsList.hidden = !hasTurns;
    if (!hasTurns) {
      userScrolledUp = false;
      el.btnJumpLatest.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Auto-scroll & Scroll Tracking
  // ---------------------------------------------------------------------------
  function scrollToBottom(force = false) {
    if (force) {
      userScrolledUp = false;
      el.btnJumpLatest.hidden = true;
    }
    if (!userScrolledUp) {
      el.turnsList.scrollTop = el.turnsList.scrollHeight;
    }
  }

  el.turnsList.addEventListener("scroll", () => {
    const nearBottom = el.turnsList.scrollHeight - el.turnsList.scrollTop - el.turnsList.clientHeight <= 28;
    userScrolledUp = !nearBottom;
    el.btnJumpLatest.hidden = nearBottom || turns.length === 0;
  });

  el.btnJumpLatest.addEventListener("click", () => scrollToBottom(true));

  // ---------------------------------------------------------------------------
  // 6. Turn DOM Creation & Throttled Re-rendering (<= 20 Hz / 50ms + rAF)
  // ---------------------------------------------------------------------------
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

  const CHUNK_SIZE = 512 * 1024;
  const MAX_BYTES = 512 * 1024 * 1024;
  const fileSize = bytes => bytes < 1048576 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  function renderAttachments() {
    el.attachments.replaceChildren();
    el.attachments.hidden = !pendingFiles.length;
    for (const item of pendingFiles) {
      const chip = make("div", "attachment-chip");
      chip.dataset.state = item.state;
      const label = make("span", "attachment-name", item.file.name);
      const status = item.state === "error" ? "Could not attach. Remove and try again." : item.state === "ready" ? fileSize(item.file.size) : `${Math.floor(item.offset / Math.max(1, item.file.size) * 100)}%`;
      const remove = make("button", "icon-btn", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${item.file.name}`);
      remove.disabled = sending;
      remove.addEventListener("click", () => removeAttachment(item));
      chip.append(label, make("span", "attachment-status", status), remove);
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
      const item = { file, offset: 0, state: "staging", cancelled: false, id: null };
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
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== "string" || entry.mediaItems.has(item.id)) continue;
      entry.mediaItems.add(item.id);
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
        try { await invoke("media_save", { mediaId: item.id }); status.textContent = "Saved to Downloads"; }
        catch (_) { status.textContent = "Could not save. View in ChatGPT to download."; }
        finally { save.disabled = false; }
      });
      actions.append(save, view);
      card.append(make("div", "attachment-name", typeof item.name === "string" ? item.name : "File"), preview, status, actions);
      entry.mediaEl.append(card);
      if (kind === "file") continue;
      const load = make("button", "btn btn-compact", "Load");
      load.type = "button";
      actions.prepend(load);
      let loaded = false;
      const loadMedia = async () => {
        if (loaded || load.disabled) return;
        load.disabled = true;
        try {
          const meta = await invoke("media_load", { mediaId: item.id });
          if (!safeMediaSource(meta, kind)) throw new Error("Unsupported media");
          if (turnNodes.get(turn.id) !== entry) return;
          const media = make(kind === "image" ? "img" : kind);
          if (kind === "image") { media.alt = typeof item.name === "string" ? item.name : "Image"; media.loading = "lazy"; }
          else { media.controls = true; media.preload = "none"; media.autoplay = false; }
          media.addEventListener("error", () => { status.textContent = "Preview unavailable. View in ChatGPT."; });
          media.src = meta.src;
          preview.append(media);
          loaded = true;
          load.hidden = true;
          status.textContent = "";
        } catch (_) { status.textContent = "Preview unavailable. View in ChatGPT."; }
        finally { load.disabled = false; }
      };
      load.addEventListener("click", loadMedia);
      if (kind === "image") void loadMedia();
    }
  }

  function createTurnRow(turn) {
    const row = make("article", "turn-row");
    row.dataset.id = turn.id;
    row.dataset.role = turn.role;
    row.dataset.status = turn.status;
    row.setAttribute("aria-label", turn.role === "user" ? "You said" : "ChatGPT replied");

    const body = make("div", "turn-body");
    const contentEl = make("div", "turn-content");
    body.appendChild(contentEl);
    const mediaEl = make("div", "turn-media");
    body.appendChild(mediaEl);
    for (const file of turn.attachments || []) mediaEl.append(make("div", "attachment-chip", `${file.name} · ${fileSize(file.size)}`));
    row.appendChild(body);

    let errorWrap = null;
    if (turn.role === "assistant") {
      const typing = make("div", "turn-typing");
      typing.setAttribute("role", "status");
      typing.setAttribute("aria-label", "ChatGPT is thinking");
      typing.append(make("span"), make("span"), make("span"));
      const progress = make("div", "turn-progress");
      progress.appendChild(makeProgressRing());
      body.append(typing, progress);

      const toolbar = make("div", "turn-toolbar");
      const copyBtn = make("button", "icon-btn");
      copyBtn.type = "button";
      copyBtn.dataset.action = "copy-turn";
      copyBtn.dataset.id = turn.id;
      copyBtn.title = "Copy";
      copyBtn.setAttribute("aria-label", "Copy reply");
      copyBtn.appendChild(makeIcon(GLYPH.copy));
      toolbar.appendChild(copyBtn);
      row.appendChild(toolbar);

      errorWrap = make("div", "turn-error");
      errorWrap.hidden = true;
      row.appendChild(errorWrap);
    }

    turnNodes.set(turn.id, { row, contentEl, errorWrap, mediaEl, mediaItems: new Set() });
    renderTurnNow(turn.id);
    return row;
  }

  function buildTurnError(turn) {
    const bar = make("div", "infobar");
    bar.dataset.severity = "critical";
    bar.setAttribute("role", "alert");
    const icon = make("span", "infobar-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.append(makeIcon(GLYPH.statusCircle, "icon ib-bg"), makeIcon(GLYPH.errorX, "icon ib-fg"));
    const text = make("p", "infobar-text", turn.error || "Something went wrong.");
    const actions = make("div", "turn-error-actions");
    if (turn.code === "auth") {
      const signin = make("button", "btn btn-compact btn-accent", "Sign in");
      signin.type = "button";
      signin.dataset.action = "signin";
      actions.appendChild(signin);
    }
    if ((!turn.hadAttachments && turn.prompt) || pendingFiles.some(f => f.state === "ready")) {
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
    bar.append(icon, text, actions);
    return bar;
  }

  function renderTurnNow(turnId) {
    const sched = renderSchedule.get(turnId);
    if (sched) {
      if (sched.rafId) cancelAnimationFrame(sched.rafId);
      if (sched.timerId) clearTimeout(sched.timerId);
      sched.rafId = null;
      sched.timerId = null;
      sched.lastRenderTs = performance.now();
    }

    const turn = turns.find((t) => t.id === turnId);
    const entry = turnNodes.get(turnId);
    if (!turn || !entry) return;

    entry.row.dataset.status = turn.status;

    if (turn.role === "user") {
      entry.contentEl.textContent = turn.text;
    } else {
      entry.contentEl.innerHTML = renderMarkdownSafe(turn.text);
      if (turn.status === "error" && entry.errorWrap) {
        entry.errorWrap.replaceChildren(buildTurnError(turn));
        entry.errorWrap.hidden = false;
      } else if (entry.errorWrap) {
        entry.errorWrap.hidden = true;
        entry.errorWrap.replaceChildren();
      }
    }
    scrollToBottom(false);
  }

  function scheduleTurnRender(turnId, immediate = false) {
    if (immediate) {
      renderTurnNow(turnId);
      return;
    }
    let sched = renderSchedule.get(turnId);
    if (!sched) {
      sched = { rafId: null, timerId: null, lastRenderTs: 0 };
      renderSchedule.set(turnId, sched);
    }
    if (sched.rafId || sched.timerId) return;

    const waitMs = Math.max(0, 50 - (performance.now() - sched.lastRenderTs));
    if (waitMs === 0) {
      sched.rafId = requestAnimationFrame(() => {
        sched.rafId = null;
        renderTurnNow(turnId);
      });
    } else {
      sched.timerId = setTimeout(() => {
        sched.timerId = null;
        sched.rafId = requestAnimationFrame(() => {
          sched.rafId = null;
          renderTurnNow(turnId);
        });
      }, waitMs);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Core Commands & Status Management
  // ---------------------------------------------------------------------------
  const PROMPT_MAX_HEIGHT = 132; // 6 lines of 20px + padding

  function autoResizePrompt() {
    const input = el.promptInput;
    input.style.height = "auto";
    const full = input.scrollHeight;
    input.style.height = `${Math.min(full, PROMPT_MAX_HEIGHT)}px`;
    input.style.overflowY = full > PROMPT_MAX_HEIGHT ? "auto" : "hidden";
    updateComposerMode();
  }

  async function sendPrompt(rawPrompt) {
    const prompt = String(rawPrompt ?? "").trim();
    if (sending || isStreaming() || pendingFiles.some(f => f.state !== "ready") || (!prompt && !pendingFiles.length)) return;
    sending = true;
    const generation = chatGeneration;
    const files = pendingFiles.slice();
    const draft = el.promptInput.value;

    hideGlobalError();
    const userTurn = { id: crypto.randomUUID(), role: "user", text: prompt, status: "done", attachments: files.map(f => ({ name: f.file.name, size: f.file.size })) };
    const assistantTurn = { id: crypto.randomUUID(), role: "assistant", text: "", status: "streaming", prompt, hadAttachments: files.length > 0 };

    turns.push(userTurn, assistantTurn);
    updateWorkspaceVisibility();
    el.turnsList.appendChild(createTurnRow(userTurn));
    el.turnsList.appendChild(createTurnRow(assistantTurn));
    updateComposerMode();
    scrollToBottom(true);

    try {
      await invoke("chat_send", { id: assistantTurn.id, prompt, attachmentIds: files.map(f => f.id) });
      for (const file of files) {
        const index = pendingFiles.indexOf(file);
        if (index >= 0) pendingFiles.splice(index, 1);
      }
      if (generation === chatGeneration && el.promptInput.value === draft) {
        el.promptInput.value = "";
        autoResizePrompt();
      }
    } catch (err) {
      if (generation !== chatGeneration) return;
      if (assistantTurn.status === "done" && !assistantTurn.text && !assistantTurn.media?.length) {
        for (const turn of [userTurn, assistantTurn]) {
          const index = turns.indexOf(turn);
          if (index >= 0) turns.splice(index, 1);
          turnNodes.get(turn.id)?.row.remove();
          turnNodes.delete(turn.id);
        }
        updateWorkspaceVisibility();
        updateComposerMode();
        return;
      }
      if (assistantTurn.status !== "streaming") return;
      assistantTurn.status = "error";
      assistantTurn.code = "send_failed";
      assistantTurn.error = formatErrorCopy("send_failed", err?.message || String(err));
      scheduleTurnRender(assistantTurn.id, true);
      updateComposerMode();
    } finally {
      sending = false;
      renderAttachments();
    }
  }

  async function stopStreaming() {
    if (!isStreaming()) return;
    try { await invoke("chat_stop"); } catch (_) {}
    for (const t of turns) {
      if (t.status === "streaming") {
        t.status = "done";
        scheduleTurnRender(t.id, true);
      }
    }
    updateComposerMode();
  }

  async function startNewChat(notifyBackend = true) {
    chatGeneration++;
    for (const item of pendingFiles.slice()) removeAttachment(item);
    el.promptInput.value = "";
    autoResizePrompt();
    for (const sched of renderSchedule.values()) {
      if (sched.rafId) cancelAnimationFrame(sched.rafId);
      if (sched.timerId) clearTimeout(sched.timerId);
    }
    renderSchedule.clear();
    turnNodes.clear();
    turns.length = 0;
    el.turnsList.replaceChildren();
    hideGlobalError();
    updateWorkspaceVisibility();
    updateComposerMode();
    if (settingsOpen) setSettingsOpen(false);
    if (notifyBackend) {
      try { await invoke("chat_new"); } catch (_) {}
    }
    el.promptInput.focus();
  }

  // Readiness and authentication are separate while the ChatGPT page loads.
  function updateStatusHeader({ ready, loggedIn, errorState, signedOut }) {
    let state;
    let label;
    if (signedOut) { state = "signed-out"; label = "Signed out"; }
    else if (errorState) { state = "error"; label = "Error"; }
    else if (!ready) { state = "connecting"; label = loggedIn ? "Loading chat…" : "Connecting…"; }
    else if (loggedIn) { state = "ready"; label = "Ready"; }
    else { state = "guest"; label = "Guest"; }

    el.statusLabel.dataset.state = state;
    el.statusLabel.textContent = label;

    if (!errorState) {
      bridge.ready = Boolean(ready);
      bridge.loggedIn = Boolean(loggedIn);
      bridge.signedOut = Boolean(signedOut);
    }
    updateGuestNotice();
    updateAccountStatus();
  }

  function updateGuestNotice() {
    const show = bridge.ready && !bridge.loggedIn && !guestDismissed;
    if (bridge.signedOut) {
      el.guestTitle.textContent = "Signed out";
      el.guestMessage.textContent = "Sign in again to keep chatting.";
    } else {
      el.guestTitle.textContent = "Guest mode";
      el.guestMessage.textContent = "Sign in to use your models and history.";
    }
    el.guestNotice.hidden = !show;
  }

  function updateAccountStatus() {
    let state;
    let text;
    if (!bridge.ready) { state = "connecting"; text = bridge.loggedIn ? "Signed in. Loading chat…" : "Connecting…"; }
    else if (bridge.loggedIn) { state = "signed-in"; text = "Signed in"; }
    else if (bridge.signedOut) { state = "signed-out"; text = "Signed out. Sign in again to continue."; }
    else { state = "guest"; text = "Using ChatGPT as a guest"; }
    el.accountStatus.dataset.state = state;
    el.accountStatus.textContent = text;
    el.btnSheetSignin.textContent = bridge.loggedIn ? "Manage account" : "Sign in";
  }

  function showGlobalError(code, message) {
    el.globalErrorText.textContent = formatErrorCopy(code, message);
    el.btnErrorSignin.hidden = code !== "auth";
    el.globalError.hidden = false;
    updateStatusHeader({ ready: true, loggedIn: false, signedOut: code === "auth", errorState: code !== "auth" });
  }

  function hideGlobalError() {
    el.globalError.hidden = true;
    el.globalErrorText.textContent = "";
    el.btnErrorSignin.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // 8. Settings page
  // ---------------------------------------------------------------------------
  function setSettingsOpen(open) {
    const root = document.documentElement;
    const wasOpen = settingsOpen;
    settingsOpen = Boolean(open);
    syncLayout();
    el.btnSettings.setAttribute("aria-expanded", String(settingsOpen));
    clearTimeout(settingsHideTimer);

    if (settingsOpen) {
      el.settingsPage.hidden = false;
      el.chatView.inert = true;
      if (!wasOpen) {
        void el.settingsPage.offsetWidth; // start the drill-in from its initial state
        root.classList.add("settings-open");
        updateAccountStatus();
      }
      if (!wasOpen) el.btnCloseSettings.focus();
    } else {
      root.classList.remove("settings-open");
      el.chatView.inert = false;
      settingsHideTimer = setTimeout(() => {
        if (!settingsOpen) el.settingsPage.hidden = true;
      }, 260);
      el.promptInput.focus();
    }
  }

  const openSignin = () => invoke("show_signin").catch(() => {});

  // ---------------------------------------------------------------------------
  // 9. Clipboard
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
  // 10. Event Wiring & Bridge Listener
  // ---------------------------------------------------------------------------
  el.turnsList.addEventListener("click", (e) => {
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

  el.emptyState.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-suggestion]");
    if (!chip) return;
    el.promptInput.value = chip.dataset.suggestion;
    autoResizePrompt();
    el.promptInput.focus();
    const end = el.promptInput.value.length;
    el.promptInput.setSelectionRange(end, end);
  });

  el.promptInput.addEventListener("input", autoResizePrompt);
  el.btnAttach.addEventListener("click", () => el.attachmentInput.click());
  el.attachmentInput.addEventListener("change", () => { addFiles(el.attachmentInput.files); el.attachmentInput.value = ""; });
  el.promptInput.addEventListener("paste", e => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.chatView.addEventListener("dragover", e => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = isStreaming() || sending ? "none" : "copy"; }
  });
  el.chatView.addEventListener("drop", e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!isStreaming()) sendPrompt(el.promptInput.value);
    }
  });

  el.btnSend.addEventListener("click", () => {
    if (isStreaming()) stopStreaming();
    else sendPrompt(el.promptInput.value);
    el.promptInput.focus();
  });

  el.btnNewChat.addEventListener("click", () => startNewChat(true));
  el.btnSettings.addEventListener("click", () => setSettingsOpen(!settingsOpen));
  el.btnCloseSettings.addEventListener("click", () => setSettingsOpen(false));
  el.btnHide.addEventListener("click", () => invoke("hide_main").catch(() => {}));

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

  el.btnSheetSignin.addEventListener("click", openSignin);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (settingsOpen) setSettingsOpen(false);
      else invoke("hide_main").catch(() => {});
    } else if ((e.ctrlKey || e.metaKey) && e.key === ".") {
      e.preventDefault();
      stopStreaming();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      startNewChat(true);
    }
  });

  listen("bridge", ({ payload: evt }) => {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "status":
        updateStatusHeader({ ready: Boolean(evt.ready), loggedIn: Boolean(evt.loggedIn) });
        break;
      case "start": {
        const turn = turns.find((t) => t.id === evt.id);
        if (turn) {
          turn.status = "streaming";
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
          scheduleTurnRender(turn.id, false);
        }
        break;
      }
      case "media": {
        const turn = turns.find(t => t.id === evt.id && t.role === "assistant");
        if (turn) appendMedia(turn, evt.items);
        break;
      }
      case "done": {
        const turn = turns.find((t) => t.id === evt.id);
        if (turn) {
          if (typeof evt.text === "string") turn.text = evt.text;
          turn.status = "done";
          scheduleTurnRender(turn.id, true);
          updateComposerMode();
        }
        break;
      }
      case "error": {
        const turn = evt.id ? turns.find((t) => t.id === evt.id) : null;
        if (turn) {
          turn.status = "error";
          turn.code = evt.code;
          turn.error = formatErrorCopy(evt.code, evt.message);
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
    if (!settingsOpen) el.promptInput.focus();
    refreshTheme();
    invoke("chat_status").catch(() => {});
  });

  listen("qchat://new-chat", () => startNewChat(true));

  syncLayout();
  updateComposerMode();
  el.promptInput.focus();
  refreshTheme();
  invoke("chat_status").catch(() => {});
})();
