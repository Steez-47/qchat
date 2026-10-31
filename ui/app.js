(function () {
  "use strict";

  const IS_MOCK = window.__QCHAT_MOCK__ === true;
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const listen = (event, cb) => window.__TAURI__.event.listen(event, cb);
  const GUTTER = 28;
  const CHATS_KEY = "qchat.chats";
  const CHATS_VERSION = 1;
  const MAX_RECENT = 49;
  const OPEN_TIMEOUT = 12000;
  const FRESH_TIMEOUT = 2500;
  const MAX_STORED_TEXT = 40000;
  const REASONING_LEVELS = ["low", "medium", "high"];
  const REASONING_LABELS = { low: "Low", medium: "Medium", high: "High" };
  const validReasoning = (value) => (REASONING_LEVELS.includes(value) ? value : null);
  const CONNECT_DEADLINE = Number(window.__mock?.connectTimeout) || 25000;

  // rAF stalls while the native window is hidden, so never let work depend on it alone.
  function nextFrame(fn) {
    let ran = false;
    let frame, timer;
    const cancel = () => { ran = true; cancelAnimationFrame(frame); clearTimeout(timer); };
    const run = () => { if (!ran) { cancel(); fn(); } };
    frame = requestAnimationFrame(run);
    timer = setTimeout(run, 120);
    return cancel;
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

    // Old saved replies can still hold the site's layout tags. Never reading material; their
    // words stay. Code spans and blocks do not come through here, so examples are untouched.
    const LAYOUT_TAG = /<\/?(?:box|row|col|column|stack|grid|grid-item|text|title|caption|divider|icon|card|section|[A-Z][A-Za-z]*)\b[^>]*>/g;
    renderer.html = (token) => escapeHtml(String(typeof token === "string" ? token : (token?.text ?? "")).replace(LAYOUT_TAG, ""));
    renderer.image = (href, _title, text) => {
      const raw = typeof href === "string" ? href : href?.href;
      const label = escapeHtml(typeof text === "string" ? text : (href?.text || "Image"));
      const web = /^qchat-web:([\w-]+)$/.exec(String(raw || ""));
      if (web) return `<span class="web-figure" data-web="${web[1]}"${label && label !== "Image" ? ` title="${label}"` : ""}><span class="web-image"></span>${label && label !== "Image" ? `<span class="web-caption">${label}</span>` : ""}</span>`;
      const url = sanitizeHref(raw);
      return url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label || "Image source"}</a>`
        : `<button type="button" class="hyperlink-btn" data-action="view-media">${label || "Image"}</button>`;
    };

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

  // QMath swaps formulas for private-use tokens before Markdown sees them, so
  // emphasis and lists cannot touch the TeX. Put the inert spans back after.
  function expandMath(html, formulas) {
    if (!formulas?.length) return html;
    return html.replace(/\uE000(\d+)\uE001/g, (token, index) => formulas[Number(index)]?.html ?? "");
  }

  function renderMarkdownSafe(markdownText, sources = []) {
    const citation = refs => refs.split(/[,;\s]+/).map(ref => {
      const source = sources.find(item => item.id === ref);
      return source ? `[${sources.indexOf(source) + 1}](<${source.url}>)` : "";
    }).filter(Boolean).join(" ");
    const src = String(markdownText ?? "")
      .replace(/<Entity\b[^>]*?\bvalue\s*=\s*"([^"]*)"[^>]*?(?:\/>|>(?:\s*<\/Entity>)?)/g, "$1")
      .replace(/<Cite\b[^>]*\bref=["']([^"']+)["'][^>]*\/?\s*>(?:<\/Cite>)?/gi, (_, refs) => citation(refs))
      .replace(/\uE200cite\uE202([^\uE201]*)\uE201/g, (_, refs) => citation(refs.replace(/\uE202/g, " ")));
    if (!src) return "";
    const prepared = window.QMath?.prepare(src);
    const html = window.marked ? window.marked.parse(prepared ? prepared.text : src) : `<p>${escapeHtml(src)}</p>`;
    return prepared ? expandMath(html, prepared.formulas) : html;
  }

  // Parse through the same safe renderer, but keep unchanged blocks and update
  // text nodes in place. Streaming must not reset selection or code scrollbars.
  function highlightCode(root) {
    for (const code of root.querySelectorAll("pre code")) window.QHighlight?.highlightInto(code, code.textContent, code.className.replace("language-", ""));
  }

  function syncMarkdownNodes(parent, next, offset = 0) {
    const children = Array.from(next.childNodes);
    for (let i = 0; i < children.length; i++) {
      const incoming = children[i];
      const current = parent.childNodes[i + offset];
      if (!current) { parent.append(incoming); continue; }
      if (current.isEqualNode(incoming)) continue;
      // Rendered maths is filled in after sync; keep the node and its output
      // instead of parsing over it on every stream frame.
      if (current.nodeType === Node.ELEMENT_NODE && incoming.nodeType === Node.ELEMENT_NODE &&
          current.hasAttribute("data-qmath") && incoming.hasAttribute("data-qmath") &&
          current.getAttribute("aria-label") === incoming.getAttribute("aria-label") &&
          current.getAttribute("data-display") === incoming.getAttribute("data-display")) continue;
      // Same for a web image that has already loaded.
      if (current.nodeType === Node.ELEMENT_NODE && incoming.nodeType === Node.ELEMENT_NODE && current.hasAttribute("data-web") &&
          current.getAttribute("data-web") === incoming.getAttribute("data-web")) continue;
      if (current.nodeType !== incoming.nodeType || current.nodeName !== incoming.nodeName) {
        current.replaceWith(incoming);
      } else if (current.nodeType === Node.TEXT_NODE) {
        current.nodeValue = incoming.nodeValue;
      } else if (current.nodeType === Node.ELEMENT_NODE) {
        for (const attr of Array.from(current.attributes)) if (!incoming.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of incoming.attributes) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        syncMarkdownNodes(current, incoming);
      } else {
        current.replaceWith(incoming);
      }
    }
    while (parent.childNodes.length > children.length + offset) parent.lastChild.remove();
  }

  // Web images in a reply load when they scroll near view, through the same broker as all media.
  const webImageLoader = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      webImageLoader.unobserve(entry.target);
      loadWebImage(entry.target);
    }
  }, { rootMargin: "600px" });

  // The browser loads these directly, which is far quicker. The broker is the fallback.
  function loadWebImage(figure) {
    let url = null;
    try {
      const parsed = new URL(atob(figure.dataset.web.replace(/-/g, "+").replace(/_/g, "/")));
      if (parsed.protocol === "https:" && parsed.hostname === "images.openai.com") url = parsed.href;
    } catch (_) {}
    if (!url) { void loadBrokeredImage(figure); return; }
    const image = make("img");
    image.alt = figure.title || "Image";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => queueSizes());
    image.addEventListener("error", () => { void loadBrokeredImage(figure); }, { once: true });
    image.src = url;
    figure.querySelector(".web-image")?.replaceChildren(image);
  }

  async function loadBrokeredImage(figure) {
    try {
      const meta = await invoke("media_load", { mediaId: `webimage:${figure.dataset.web}`, revision: 0 });
      if (!safeMediaSource(meta, "image")) throw new Error("Unsupported media");
      const image = make("img");
      image.alt = figure.title || "Image";
      image.addEventListener("load", () => queueSizes());
      image.src = meta.src;
      figure.querySelector(".web-image")?.replaceChildren(image);
    } catch (_) { figure.dataset.failed = ""; }
  }

  function hydrateWebImages(root) {
    for (const figure of root.querySelectorAll(".web-figure:not([data-watched])")) {
      figure.dataset.watched = "";
      webImageLoader.observe(figure);
    }
  }

  function parseReply(markdown, sources) {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdownSafe(markdown, sources);
    highlightCode(template.content);
    return template.content;
  }

  // While streaming, finished blocks are parsed once and left alone; only the tail is
  // reparsed, with its unfinished syntax closed so markers never flash and then jump.
  function renderReply(entry, text, sources, streaming) {
    if (!streaming) {
      entry.stable = null;
      syncMarkdownNodes(entry.contentEl, parseReply(text, sources));
      return;
    }
    let stable = entry.stable;
    if (!stable || !text.startsWith(stable.text)) stable = entry.stable = { text: "", nodes: 0 };
    const boundary = window.QStream.stableBoundary(text);
    const next = document.createDocumentFragment();
    let settled = 0;
    if (boundary > stable.text.length) {
      const blocks = parseReply(text.slice(stable.text.length, boundary), sources);
      settled = blocks.childNodes.length;
      next.append(blocks);
    }
    const tail = text.slice(Math.max(boundary, stable.text.length));
    next.append(parseReply(window.QStream.stabilize(tail), sources));
    syncMarkdownNodes(entry.contentEl, next, stable.nodes);
    if (settled) { stable.nodes += settled; stable.text = text.slice(0, boundary); }
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
    reasoning_unavailable: "ChatGPT couldn't select that reasoning level. Choose Medium or open ChatGPT to check its thinking controls.",
    invalid_reasoning_effort: "Choose Low, Medium or High reasoning.",
    stream_failed: "The response was interrupted.",
    timeout: "ChatGPT took too long to respond.",
    open_timeout: "That chat is taking too long to open. Try sending again.",
    invalid_id: "That chat can't be reopened. Start a new one with /new.",
    offline: "Can't reach ChatGPT. Check your connection, then try again."
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
    historyControls: $("history-controls"),
    historyButton: $("btn-history"),
    historyLabel: $("history-label"),
    historyStatus: $("history-status"),
    historyPanel: $("history-panel"),
    btnAllChats: $("btn-all-chats"),
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
    btnReasoning: $("btn-reasoning"),
    btnSend: $("btn-send"),
    btnAttach: $("btn-attach"),
    btnSnapshot: $("btn-snapshot"),
    attachmentInput: $("attachment-input"),
    attachments: $("attachments")
  };

  const prompts = [];
  let recallIndex = -1;
  const turns = [];
  const turnNodes = new Map();
  const renderSchedule = new Map();
  const pendingFiles = [];
  const imageURLs = new Set();
  let stageQueue = Promise.resolve();
  let sending = false;
  let snapshotCapturing = false;
  let chatGeneration = 0;
  let userScrolledUp = false;
  let guestDismissed = false;
  let sentThisSession = false;
  let firstRunHint = false;
  let autoDismissTimer = null;
  let historyOpen = false;
  let historyChatKey = null;
  let historyHideTimer = null;
  let historyHeld = false;
  const backfilled = new WeakSet();
  let backfillTimer = null;
  const bridge = { ready: false, loggedIn: false, signedOut: false };
  let connectTimer = null;
  let connectErrorShown = false;

  const isStreaming = () => turns.some((t) => t.status === "streaming");
  const isBusy = () => sending || isStreaming();
  const stopBackend = () => invoke("chat_stop").catch(() => {});

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
    lastHasMedia: false,
    transcript: [],
    draft: "",
    createdAt: Date.now()
  });

  const hasContent = (chat) => Boolean(chat.transcript?.length || chat.lastPrompt || chat.lastResponse || chat.lastHasMedia || chat.conversationId);

  // Media handles and signed image URLs belong to one bridge session. History
  // keeps prose and a hint to view prior media in ChatGPT.
  function completedSnapshot(value, hasMedia = false) {
    let media = Boolean(hasMedia);
    const ephemeral = /^(?:qchat-media:|sandbox:|attachment:|https?:\/\/qchat-media\.localhost(?:[/:]|$)|https?:\/\/[^/]*oaiusercontent\.com\/)/i;
    let text = String(value || "");
    text = text.replace(/(!?)\[([^\]\n]*)\]\(([^\n]*?)\)/g, (match, image, label, href) => {
      if (/^qchat-web:/.test(href) || (!image && !ephemeral.test(href.trim().replace(/^</, "")))) return match;
      media = true;
      return "";
    });
    text = text.replace(/(?:qchat-media:|sandbox:|attachment:|https?:\/\/qchat-media\.localhost\/|https?:\/\/[^\s/]*oaiusercontent\.com\/)[^\s<>)]*/gi, () => {
      media = true;
      return "";
    });
    return { text: text.trim(), hasMedia: media };
  }

  // Files by id only: signed URLs never go into saved chats.
  function cleanStoredMedia(items) {
    return (Array.isArray(items) ? items : []).filter(item => typeof item?.file === "string" && /^[A-Za-z0-9_-]{4,120}$/.test(item.file)).slice(0, 40)
      .map(item => ({ file: item.file, kind: item.kind === "image" ? "image" : "file", name: String(item.name || "Attachment").slice(0, 200), before: Boolean(item.before), ...(typeof item.mime === "string" ? { mime: item.mime.slice(0, 100) } : {}) }));
  }

  function cleanTranscript(raw, lastSnapshot) {
    if (Array.isArray(raw.transcript)) return raw.transcript.filter(item => item &&
      typeof item.id === "string" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string")
      .map(item => {
        const snapshot = item.role === "user" ? { text: item.text, hasMedia: Boolean(item.hasMedia) } : completedSnapshot(item.text, item.hasMedia);
        return { id: item.id, role: item.role, text: snapshot.text, hasMedia: snapshot.hasMedia, media: cleanStoredMedia(item.media), hadAttachments: Boolean(item.hadAttachments), stopped: item.role === "assistant" && Boolean(item.stopped), sources: cleanSources(item.sources) };
      });
    // Older versions saved only the latest exchange; earlier turns are unavailable.
    const transcript = [];
    if (raw.lastPrompt) transcript.push({ id: crypto.randomUUID(), role: "user", text: String(raw.lastPrompt) });
    if (lastSnapshot.text || lastSnapshot.hasMedia) transcript.push({ id: crypto.randomUUID(), role: "assistant", text: lastSnapshot.text, hasMedia: lastSnapshot.hasMedia, stopped: false, sources: cleanSources(raw.lastSources) });
    return transcript;
  }

  function snapshotTurn(turn, text = turn.text) {
    const hasMedia = Boolean(turn.media?.length || turn.attachments?.length || turn.cachedMedia);
    const snapshot = turn.role === "user" ? { text: String(text || ""), hasMedia } : completedSnapshot(text, hasMedia);
    return {
      id: turn.id,
      role: turn.role,
      text: snapshot.text,
      hasMedia: snapshot.hasMedia,
      hadAttachments: Boolean(turn.hadAttachments),
      sources: cleanSources(turn.sources),
      stopped: turn.role === "assistant" && Boolean(turn.stopped)
    };
  }

  function rememberTurn(turn) {
    if (!turn || (turn.chatKey && turn.chatKey !== chats.current.key)) return;
    const transcript = chats.current.transcript;
    const item = snapshotTurn(turn);
    const index = transcript.findIndex(existing => existing.id === item.id);
    if (index < 0) transcript.push(item);
    else transcript[index] = { ...item, media: transcript[index].media };
  }

  function historyItems() {
    const items = chats.current.transcript.slice();
    for (const turn of turns) {
      if (turn.chatKey && turn.chatKey !== chats.current.key) continue;
      const entry = turnNodes.get(turn.id);
      const visible = turn.status === "streaming" && entry?.reveal ? entry.reveal.visible : turn.text;
      const item = snapshotTurn(turn, visible);
      const index = items.findIndex(existing => existing.id === item.id);
      if (index < 0) items.push(item);
      else items[index] = { ...item, media: items[index].media };
    }
    return items.filter(item => item.text || item.hasMedia);
  }

  // The same bubble markup as the live view, without its per-reply viewport:
  // the panel is the only scroller, so a message never gets its own cutoff.
  function createHistoryRow(item) {
    const row = make("article", "turn-row history-row");
    row.dataset.id = item.id;
    row.dataset.role = item.role;
    row.setAttribute("aria-label", item.role === "user" ? "You said" : "ChatGPT replied");
    const content = make("div", "turn-content");
    const media = make("div", "turn-media");
    if (item.role === "user") {
      const bubble = make("div", "bubble bubble-user glass glass-tiny");
      bubble.append(content, media);
      row.append(bubble);
    } else {
      const bubble = make("div", "bubble bubble-response glass");
      const inner = make("div", "bubble-inner turn-body");
      inner.append(content, media);
      bubble.append(inner);
      const tools = make("div", "bubble-tools glass glass-tiny");
      const copy = make("button", "tool-btn");
      copy.type = "button";
      copy.dataset.action = "history-copy";
      copy.title = "Copy";
      copy.setAttribute("aria-label", "Copy reply");
      copy.append(makeIcon(GLYPH.copy));
      tools.append(copy);
      row.append(bubble, tools);
    }
    return row;
  }

  function renderHistory() {
    if (!historyOpen) {
      // Called on every streamed frame, so this path must not touch the message text.
      const shown = el.zone.querySelectorAll(".turn-row:not(.leaving):not([hidden])").length;
      const saved = chats.current.transcript.filter(item => item.text || item.hasMedia).length;
      const moreOnPage = chats.current.conversationId && !backfilled.has(chats.current);
      el.historyControls.hidden = saved <= shown && !moreOnPage;
      return;
    }
    el.historyControls.hidden = false;
    const items = historyItems();
    const panel = el.historyPanel;
    if (historyChatKey !== chats.current.key) {
      panel.replaceChildren();
      historyChatKey = chats.current.key;
    }
    // Hold the reader's place: follow the end only if they are already there, and
    // keep the same message on screen when older ones arrive above it.
    const fromBottom = panel.scrollHeight - panel.scrollTop;
    const atEnd = fromBottom - panel.clientHeight <= 2 && !historyHeld;
    const prepended = panel.childElementCount > 0 && panel.firstElementChild.dataset.id !== items[0]?.id;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let row = panel.children[i];
      if (!row || row.dataset.id !== item.id) {
        row = createHistoryRow(item);
        panel.insertBefore(row, panel.children[i] || null);
      }
      const stoppedNote = row.querySelector(".turn-note");
      if (item.role === "assistant" && item.stopped) {
        if (!stoppedNote) row.append(make("div", "turn-note", "Stopped"));
      } else if (stoppedNote) stoppedNote.remove();
      // Completed messages are immutable during a stream; avoid reparsing them.
      const fingerprint = JSON.stringify([item.text, item.hasMedia, item.media, item.sources, item.stopped]);
      if (row._historyFingerprint === fingerprint) continue;
      row._historyFingerprint = fingerprint;
      row._copyText = item.text;
      row.toggleAttribute("data-wide", /\n/.test(item.text));
      const content = row.querySelector(".turn-content");
      const template = document.createElement("template");
      if (item.role === "user") template.content.append(document.createTextNode(item.text));
      else template.innerHTML = renderMarkdownSafe(item.text, item.sources);
      highlightCode(template.content);
      syncMarkdownNodes(content, template.content);
      window.QMath?.renderInto(content);
      hydrateWebImages(content);
      row.toggleAttribute("data-media-first", Boolean(item.media?.some(file => file.before)));
      const media = row.querySelector(".turn-media");
      if (item.media?.length && chats.current.conversationId) {
        media.replaceChildren(...item.media.map(file => storedMediaCard(file, chats.current.conversationId)));
      } else if (item.hasMedia && !media.childElementCount) {
        const view = make("button", "hyperlink-btn", "View attachments in ChatGPT");
        view.type = "button";
        view.dataset.action = "history-media";
        media.append(view);
      } else if (!item.hasMedia) media.replaceChildren();
    }
    while (panel.children.length > items.length) panel.lastElementChild.remove();
    // Only write when following: any write would cancel a wheel scroll in progress.
    if (prepended) panel.scrollTop = panel.scrollHeight - fromBottom;
    else if (atEnd) panel.scrollTop = panel.scrollHeight;
    syncHistoryEdge();
    queueSizes();
  }

  // A file from a saved conversation, loaded when it scrolls near view.
  const storedMediaLoader = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      storedMediaLoader.unobserve(entry.target);
      entry.target._load?.();
    }
  }, { rootMargin: "600px" });

  function storedMediaCard(file, conversationId) {
    const card = make("div", "media-card stored-media");
    card.dataset.file = file.file;
    const mediaId = `stored:${file.file}:${conversationId}`;
    const preview = make("div", "media-preview");
    const status = make("span", "media-status");
    const actions = make("div", "media-actions");
    const save = make("button", "btn btn-compact", "Save to Downloads");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await invoke("media_save", { mediaId, revision: 0 }); status.textContent = "Saved to Downloads"; }
      catch (_) { status.textContent = "Could not save. View in ChatGPT to download."; }
      finally { save.disabled = false; }
    });
    actions.append(save);
    if (file.kind !== "image") {
      card.append(make("div", "attachment-name", file.name), status, actions);
      return card;
    }
    let image = null;
    actions.prepend(imageCopyButton(async () => image));
    card.append(preview, status, actions);
    actions.hidden = true;
    const load = async () => {
      status.textContent = "Loading…";
      try {
        const meta = await invoke("media_load", { mediaId, revision: 0 });
        if (!safeMediaSource(meta, "image")) throw new Error("Unsupported media");
        image = make("img");
        image.alt = file.name;
        image.crossOrigin = "anonymous";
        image.addEventListener("load", () => { queueSizes(); });
        image.addEventListener("error", () => { status.textContent = "Preview unavailable."; });
        image.src = meta.src;
        preview.replaceChildren(image);
        status.textContent = "";
        actions.hidden = false;
      } catch (_) {
        status.textContent = "";
        const retry = make("button", "btn btn-compact", "Retry image");
        retry.type = "button";
        retry.addEventListener("click", () => { retry.remove(); void load(); });
        status.append(retry);
      }
    };
    card._load = load;
    storedMediaLoader.observe(card);
    return card;
  }

  function syncHistoryEdge() {
    const panel = el.historyPanel;
    panel.toggleAttribute("data-below", panel.scrollHeight - panel.scrollTop - panel.clientHeight > 4);
  }

  // Only as tall as its messages, up to the same cap as a long reply.
  function syncHistoryHeight() {
    const panel = el.historyPanel;
    const last = panel.lastElementChild;
    const content = last ? last.offsetTop + last.offsetHeight + parseFloat(getComputedStyle(panel).paddingBottom) : 0;
    panel.style.height = `${Math.min(content, bubbleMax)}px`;
  }

  function hideHistoryPanel() {
    clearTimeout(historyHideTimer);
    historyHideTimer = null;
    const panel = el.historyPanel;
    panel.hidden = true;
    panel.removeAttribute("data-leaving");
    panel.style.removeProperty("--leave-bottom");
    panel.style.height = "";
    panel.replaceChildren();
    historyChatKey = null;
  }

  function setHistoryOpen(open) {
    if (open === historyOpen) return;
    const panel = el.historyPanel;
    el.historyButton.setAttribute("aria-expanded", String(open));
    el.historyLabel.textContent = open ? "Latest" : "History";
    if (open) {
      hideHistoryPanel();
      // A long reply being read keeps its text exactly where it is on screen.
      const live = responseEntry();
      const reading = live?.row.hasAttribute("data-capped")
        ? { id: live.row.dataset.id, fromBottom: live.bubble.offsetHeight + 8 + live.scroller.scrollTop } : null;
      historyOpen = true;
      historyHeld = false;
      el.stack.toggleAttribute("data-history", true);
      panel.hidden = false;
      renderHistory();
      updateBubbleMax();
      syncHistoryHeight();
      panel.scrollTop = panel.scrollHeight;
      const held = reading && [...panel.children].find(row => row.dataset.id === reading.id);
      if (held) panel.scrollTop = held.offsetTop - panel.offsetHeight + reading.fromBottom;
      syncHistoryEdge();
      fitNow();
      void panel.offsetHeight;
      clearTimeout(autoDismissTimer);
      panel.focus({ preventScroll: true });
      syncHistoryButton();
      backfillHistory(chats.current);
    } else {
      const bottom = el.stack.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom;
      historyOpen = false;
      el.stack.toggleAttribute("data-history", false);
      setHistoryStatus("");
      if (QSettings.motionOn) {
        // Fades out where it stands while the live bubble returns beneath it.
        panel.style.setProperty("--leave-bottom", `${bottom}px`);
        panel.setAttribute("data-leaving", "");
        historyHideTimer = setTimeout(hideHistoryPanel, QSettings.timings.t2 + 30);
      } else hideHistoryPanel();
      el.promptInput.focus({ preventScroll: true });
      const entry = responseEntry();
      if (entry) {
        updateBubbleMax();
        syncBubbleSize(entry);
        // History ended at the latest line, so the live reply picks up from there.
        userScrolledUp = false;
        entry.scroller.scrollTop = entry.scroller.scrollHeight;
        entry.followTop = entry.scroller.scrollTop;
      }
      if (!isBusy() && entry) armAutoDismiss();
      renderHistory();
      syncHistoryButton();
    }
    queueSizes();
  }

  // For a long reply the control belongs to the top of the text: it steps aside
  // while reading further down. Its space stays reserved so nothing shifts.
  function syncHistoryButton() {
    const entry = responseEntry();
    const away = !historyOpen && Boolean(entry?.row.hasAttribute("data-capped")) && entry.scroller.scrollTop > 6;
    el.historyControls.toggleAttribute("data-away", away);
    el.historyButton.tabIndex = away ? -1 : 0;
  }

  let historyStatusTimer = null;
  function setHistoryStatus(text, clearAfter = 0) {
    clearTimeout(historyStatusTimer);
    el.historyStatus.textContent = text;
    el.historyStatus.hidden = !text || !historyOpen;
    if (clearAfter) historyStatusTimer = setTimeout(() => setHistoryStatus(""), clearAfter);
  }

  function backfillFailed(chat) {
    clearTimeout(backfillTimer);
    backfillTimer = null;
    backfilled.delete(chat);
    if (chats.current === chat) setHistoryStatus("Couldn't load earlier messages", 4000);
  }

  // ChatGPT holds the messages from before this PC kept a transcript. Read them
  // once per chat; any failure just leaves the local transcript as it is.
  function backfillHistory(chat) {
    if (!chat.conversationId || backfilled.has(chat) || isBusy()) return;
    backfilled.add(chat);
    setHistoryStatus("Loading earlier messages");
    backfillTimer = setTimeout(() => backfillFailed(chat), 20000);
    invoke("chat_read_transcript", { conversationId: chat.conversationId }).catch(() => backfillFailed(chat));
  }

  // No account record and a different chat on the page: open it once and read what renders.
  function backfillFromPage(chat) {
    pageSync = pageSync.catch(() => {}).then(() => {
      if (chats.current !== chat || isBusy()) { backfillFailed(chat); return; }
      chat.readFromPage = true;
      return openInPage(chat).then(() => invoke("chat_read_transcript", { conversationId: chat.conversationId }));
    }).catch(() => backfillFailed(chat));
  }

  const comparable = (text) => String(text || "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

  // Adds only what comes before the oldest local prompt; local turns keep their
  // original markdown and sources. Repeat reads find nothing new to add.
  function mergePageTranscript(chat, messages, complete = false) {
    if (!Array.isArray(messages)) { backfillFailed(chat); return; }
    clearTimeout(backfillTimer);
    backfillTimer = null;
    setHistoryStatus("");
    const older = cleanTranscript({ transcript: messages.map(item => ({ ...item, id: crypto.randomUUID() })) }).filter(item => item.text || item.hasMedia);
    const local = chat.transcript.filter(item => item.text || item.hasMedia);
    if (complete) {
      // The account's record is the truth, including anything said on the website. A longer
      // local list means messages this PC misfiled or lost the text of, never more truth.
      // Messages this PC already has keep their markdown and sources.
      const known = new Map();
      for (const item of local) {
        if (!item.text) continue;
        const key = `${item.role}:${comparable(item.text)}`;
        if (!known.has(key)) known.set(key, []);
        known.get(key).push(item);
      }
      chat.transcript = older.map(item => {
        const mine = known.get(`${item.role}:${comparable(item.text)}`)?.shift();
        return mine ? { ...mine, text: item.text || mine.text, media: item.media, sources: item.sources?.length ? item.sources : mine.sources, hasMedia: item.hasMedia || mine.hasMedia } : item;
      });
      if (chat === chats.current) refreshAfterRecord(chat);
      saveChats();
      renderHistory();
      return;
    }
    let end = older.length;
    if (local.length) {
      const anchor = local.find(item => item.role === "user" && comparable(item.text));
      if (!anchor) return;
      const key = comparable(anchor.text);
      const isAnchor = item => item.role === "user" && comparable(item.text) === key;
      // A repeated prompt: count back from the end, as the local copy is the tail.
      const matches = older.flatMap((item, index) => isAnchor(item) ? [index] : []);
      end = matches[matches.length - local.filter(isAnchor).length] ?? -1;
    }
    if (end <= 0) return;
    chat.transcript = [...older.slice(0, end), ...chat.transcript];
    saveChats();
    renderHistory();
  }

  // Bubbles on screen were built from the old local copy. Any not in the record must not write
  // themselves back into it when they leave, and a stale restored reply is rebuilt.
  function refreshAfterRecord(chat) {
    for (const turn of turns) {
      if (turn.status !== "streaming" && !chat.transcript.some(item => item.id === turn.id)) turn.chatKey = "superseded";
    }
    const shown = turns.find(turn => turn.role === "assistant");
    if (isBusy() || historyOpen || !shown?.restored) return;
    const latest = chat.transcript.findLast(item => item.role === "assistant");
    if (!latest) return;
    // Only when the record shows more than the bubble does: the words alone often differ in
    // Markdown detail, and rebuilding for that would flicker at the end of every reply.
    const news = comparable(latest.text) !== comparable(shown.text) || /qchat-web:/.test(latest.text) && !/qchat-web:/.test(shown.text) ||
      (latest.media?.length && !turnNodes.get(shown.id)?.mediaEl?.querySelector(".stored-media"));
    if (!news) return;
    const scroller = turnNodes.get(shown.id)?.scroller;
    const reading = userScrolledUp && scroller ? scroller.scrollTop : null;
    dismissExchange(true);
    showCachedResponse(chat);
    if (reading !== null) {
      const entry = responseEntry();
      if (entry) { userScrolledUp = true; entry.scroller.scrollTop = reading; syncScrollState(entry); }
    }
  }

  const capText = (value) => {
    const text = String(value ?? "");
    return text.length > MAX_STORED_TEXT ? `${text.slice(0, MAX_STORED_TEXT - 1)}…` : text;
  };

  function cleanChat(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key) return null;
    const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
    const time = (value) => (Number.isFinite(value) && value > 0 ? value : Date.now());
    const snapshot = completedSnapshot(text(raw.lastResponse, Infinity), raw.lastHasMedia === true);
    const reasoningEffort = validReasoning(raw.reasoningEffort);
    return {
      key: raw.key,
      conversationId: typeof raw.conversationId === "string" && raw.conversationId ? raw.conversationId : null,
      title: text(raw.title, 40),
      lastActive: time(raw.lastActive),
      lastPrompt: text(raw.lastPrompt, Infinity),
      lastHadAttachments: raw.lastHadAttachments === true,
      lastResponse: snapshot.text,
      lastHasMedia: snapshot.hasMedia,
      lastSources: cleanSources(raw.lastSources),
      transcript: cleanTranscript(raw, snapshot),
      draft: text(raw.draft, Infinity),
      createdAt: time(raw.createdAt),
      ...(reasoningEffort ? { reasoningEffort } : {})
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
        .filter((chat, i, all) => !chat.conversationId || (chat.conversationId !== current.conversationId && all.findIndex((c) => c.conversationId === chat.conversationId) === i))
        .sort((a, b) => b.lastActive - a.lastActive)
        .slice(0, MAX_RECENT);
      return { current, recent };
    } catch (_) {
      return empty;
    }
  }

  const chats = loadChats();

  // Saved default for new chats; a chat's own pick overrides it until a new chat.
  const savedReasoning = () => validReasoning(QSettings.settings.defaultReasoning) || "medium";
  const effectiveReasoning = (chat = chats.current) => validReasoning(chat?.reasoningEffort) || savedReasoning();
  let sentReasoning = null;

  function syncReasoningButton() {
    const busy = isBusy();
    if (!busy) sentReasoning = null;
    const value = busy && sentReasoning ? sentReasoning : effectiveReasoning();
    const label = REASONING_LABELS[value];
    el.btnReasoning.querySelector(".reasoning-label").textContent = label;
    el.btnReasoning.setAttribute("aria-label", `Reasoning: ${label}`);
    el.btnReasoning.dataset.value = value;
    el.btnReasoning.disabled = busy;
  }

  function chooseReasoning(value) {
    if (isBusy() || !validReasoning(value)) return;
    chats.current.reasoningEffort = value;
    saveChats();
    syncReasoningButton();
    queueSizes();
  }

  function showReasoningPicker() {
    if (isBusy()) return;
    if (featureListAnchor === el.btnReasoning) { closeFeatureList(); return; }
    const selected = effectiveReasoning();
    showFeatureList("Reasoning", REASONING_LEVELS.map((value) => ({
      title: REASONING_LABELS[value],
      meta: value === "low" ? "Instant / Light" : value === "medium" ? "Standard" : "Extended",
      selected: value === selected,
      run: () => chooseReasoning(value)
    })), false, el.btnReasoning);
  }

  function storedChat(chat, capped = false) {
    if (!capped) return chat;
    return {
      ...chat,
      lastPrompt: capText(chat.lastPrompt),
      lastResponse: capText(chat.lastResponse),
      draft: capText(chat.draft),
      transcript: (chat.transcript || []).map(item => ({ ...item, text: capText(item.text) }))
    };
  }

  function saveChats() {
    if (!QSettings.settings.keepHistory) {
      try { localStorage.removeItem(CHATS_KEY); } catch (_) {}
      return;
    }
    const source = chats.current.temporary ? freshChat() : chats.current;
    let current = storedChat(source);
    let recent = chats.recent.map(chat => storedChat(chat));
    const write = () => localStorage.setItem(CHATS_KEY, JSON.stringify({ v: CHATS_VERSION, current, recent }));
    try { write(); return; } catch (_) {}
    // Drop oldest transcripts before trimming metadata; preserve full current text.
    for (let i=recent.length-1;i>=0;i--) {
      recent[i] = {...recent[i], transcript:[], lastResponse:""};
      try { write(); return; } catch (_) {}
    }
    while (recent.length > 1) {
      recent.pop();
      try { write(); return; } catch (_) {}
    }
    current = storedChat(source, true);
    recent = recent.map(chat => storedChat(chat, true));
    try { write(); return; } catch (_) {}
    current = {...current, draft:"", transcript:current.transcript.slice(-2)};
    try { write(); } catch (_) {}

  }

  function pushRecent(chat) {
    if (!QSettings.settings.keepHistory || chat.temporary) return;
    chats.recent = [chat, ...chats.recent.filter((c) => c.key !== chat.key && !(chat.conversationId && c.conversationId === chat.conversationId))].slice(0, MAX_RECENT);
  }

  function recordPartial(turn) {
    if (!turn || turn.role !== "assistant" || (!turn.text && !turn.media?.length) || turn.chatKey !== chats.current.key) return;
    rememberTurn(turn);
    const snapshot = completedSnapshot(turn.text, turn.media?.length || turn.cachedMedia);
    chats.current.lastResponse = snapshot.text;
    chats.current.lastHasMedia = snapshot.hasMedia;
    chats.current.lastSources = cleanSources(turn.sources);
    chats.current.lastActive = Date.now();
    saveChats();
  }

  function clearRecentChats() {
    chats.recent = [];
    dismissExchange();
    chats.current = freshChat();
    setModeLabel("");
    el.promptInput.value = "";
    autoResizePrompt();
    saveChats();
    renderTabs();
    updateIdleChips();
    updateComposerMode();
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
    await invoke("chat_new", { preserveUploads: true, temporary: Boolean(chat.temporary) });
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
    if (isStreaming() || sending) {
      showGlobalError("attachment_failed", "Finish or stop the reply first.");
      return false;
    }
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
    return true;
  }

  const snapshotRoom = () => pendingFiles.length < 10
    && pendingFiles.reduce((n, f) => n + f.file.size, 0) < MAX_BYTES;

  function snapshotFile(snapshot) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("no image returned");
    const { name, mime, data } = snapshot;
    if (typeof name !== "string" || !name || typeof data !== "string" || !data) throw new Error("no image returned");
    if (String(mime || "").toLowerCase() !== "image/png") throw new Error("image was not a PNG");
    const binary = atob(data);
    if (!binary) throw new Error("no image returned");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name, { type: "image/png" });
  }

  function snapshotErrorCopy(err) {
    const raw = String(err?.message || err?.code || err || "")
      .replace(/^\s*snapshot_[a-z_]+\s*:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return raw && raw.length <= 160 && !/^error$/i.test(raw)
      ? `Couldn't take a snapshot: ${raw}`
      : "Couldn't take a snapshot. Put the window you want in front, then try again.";
  }

  async function captureSnapshot() {
    if (snapshotCapturing || isBusy()) return;
    if (!snapshotRoom()) {
      showGlobalError("attachment_failed", "Attach up to 10 files, totalling at most 512 MB.");
      return;
    }
    const generation = chatGeneration;
    snapshotCapturing = true;
    hideGlobalError();
    updateComposerMode();
    try {
      const file = snapshotFile(await invoke("snapshot_capture"));
      // New chat or a chat switch abandons this capture rather than feeding the new draft.
      if (generation !== chatGeneration) return;
      if (!snapshotRoom() || file.size > MAX_BYTES
        || pendingFiles.reduce((n, f) => n + f.file.size, 0) + file.size > MAX_BYTES) {
        showGlobalError("attachment_failed", "Attach up to 10 files, totalling at most 512 MB.");
        return;
      }
      addFiles([file]);
      updateIdleChips();
    } catch (err) {
      if (generation !== chatGeneration) return;
      showGlobalError(null, snapshotErrorCopy(err));
    } finally {
      snapshotCapturing = false;
      updateComposerMode();
      if (generation === chatGeneration && document.hasFocus()
        && [document.body, el.btnSnapshot, el.promptInput].includes(document.activeElement)) {
        el.promptInput.focus();
      }
    }
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
  function cleanSources(items) {
    const result = [], seen = new Set();
    for (const item of Array.isArray(items) ? items.slice(0, 100) : []) {
      const url = sanitizeHref(item?.url);
      if (!url || !/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      result.push({ id: String(item.id || url).slice(0, 200), url, title: String(item.title || new URL(url).hostname).slice(0, 300) });
    }
    return result;
  }
  function renderSources(turn) {
    const entry = turnNodes.get(turn.id);
    if (!entry) return;
    const items = cleanSources(turn.sources);
    if (!items.length) { entry.sourcesEl?.remove(); entry.sourcesEl = null; return; }
    if (!entry.sourcesEl) {
      entry.sourcesEl = make("details", "turn-sources");
      entry.sourcesEl.append(make("summary"), make("ol"));
      entry.sourcesEl.addEventListener("toggle", () => queueSizes());
      entry.mediaEl.before(entry.sourcesEl);
    }
    entry.sourcesEl.querySelector("summary").textContent = `Sources (${items.length})`;
    const list = entry.sourcesEl.querySelector("ol");
    list.replaceChildren(...items.map(item => {
      const row = make("li"), link = make("a", "", item.title);
      link.href = item.url;
      link.rel = "noopener noreferrer";
      row.append(link);
      return row;
    }));
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
  let promptTargetHeight = 0;

  const responseEntry = () => {
    for (const turn of turns) {
      const entry = turnNodes.get(turn.id);
      if (entry?.bubble && !entry.row.hidden) return entry;
    }
    return null;
  };

  function updateBubbleMax() {
    const kept = [...el.zone.querySelectorAll('.turn-row[data-role="user"]:not(.leaving)')].reduce((sum, row) => sum + row.offsetHeight + 8, 0);
    const chrome = el.stack.offsetHeight - (historyOpen ? el.historyPanel.offsetHeight : (el.zone.hidden ? 0 : el.zone.offsetHeight)) + kept;
    const pct = QSettings.settings.maxHeightPct / 100;
    bubbleMax = Math.max(120, Math.round(pct * window.screen.availHeight) - chrome - 2 * GUTTER);
  }

  // Layout reads only; the bubble's width and height ease towards what the text needs.
  function syncBubbleSize(entry) {
    if (!entry?.bubble || entry.row.hidden || historyOpen) return;
    const capped = entry.inner.offsetHeight > bubbleMax;
    if (capped !== entry.row.hasAttribute("data-capped")) entry.row.toggleAttribute("data-capped", capped);
    const column = Math.min(el.stack.offsetWidth, QSettings.settings.replyWidth || Infinity);
    const width = capped || entry.row.dataset.status === "streaming" || entry.row.hasAttribute("data-wide")
      ? column : Math.min(entry.inner.offsetWidth, column);
    const target = Math.min(entry.inner.offsetHeight, bubbleMax);
    entry.targetHeight = target;
    entry.bubble.style.width = `${width}px`;
    entry.bubble.style.height = `${target}px`;
    followStream(entry);
    syncHistoryButton();
  }

  const scrollGap = (scroller) => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

  function syncScrollState(entry) {
    const { scroller, row, jump } = entry;
    const capped = row.hasAttribute("data-capped");
    jump.hidden = !capped || scrollGap(scroller) <= 2 || (!userScrolledUp && QSettings.settings.followStream !== false);
    scroller.toggleAttribute("data-above", capped && scroller.scrollTop > 2);
    scroller.toggleAttribute("data-below", capped && scrollGap(scroller) > 2);
  }

  // The reader's intent decides, not their distance from the end: one wheel notch upward
  // stops following at once. Only reaching the very end again resumes it.
  function holdStream(entry) {
    if (!entry.row.hasAttribute("data-capped")) return;
    userScrolledUp = true;
    entry.heldAt = performance.now();
    syncScrollState(entry);
  }

  // Eases towards the end instead of snapping a whole line per frame.
  function followStream(entry) {
    syncScrollState(entry);
    if (!entry.row.hasAttribute("data-capped") || userScrolledUp || QSettings.settings.followStream === false || entry.following) return;
    entry.following = true;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const { scroller } = entry;
      const gap = scrollGap(scroller);
      if (userScrolledUp || turnNodes.get(entry.row.dataset.id) !== entry || gap <= 0.5) {
        entry.following = false;
        syncScrollState(entry);
        return;
      }
      const eased = gap * (1 - Math.exp(-Math.max(1, now - last) / 90));
      last = now;
      scroller.scrollTop = !QSettings.motionOn || gap > 600 ? scroller.scrollHeight : scroller.scrollTop + Math.max(1, eased);
      entry.followTop = scroller.scrollTop;
      nextFrame(step);
    };
    step();
  }

  const scrollToBottom = () => { const entry = responseEntry(); if (entry) followStream(entry); };

  function queueSizes() {
    if (sizesQueued) return;
    sizesQueued = true;
    nextFrame(() => {
      sizesQueued = false;
      updateBubbleMax();
      if (historyOpen) syncHistoryHeight();
      const entry = responseEntry();
      if (entry && !historyOpen) syncBubbleSize(entry);
      queueFit();
    });
  }

  function wantedSize() {
    let height = el.stack.offsetHeight;
    // Reserve the destination before the textarea eases into it. This keeps
    // native window growth out of the per-frame CSS animation.
    height += Math.max(0, promptTargetHeight - el.promptInput.offsetHeight);
    const entry = responseEntry();
    if (entry && !historyOpen) {
      // Reserve the complete streaming viewport once. Native bottom anchoring must
      // not move the whole conversation each time another line is revealed.
      const target = entry.row.dataset.status === "streaming" ? bubbleMax : entry.targetHeight;
      height += Math.max(0, target - entry.bubble.offsetHeight);
    }
    // Same for the history viewport: the window grows first, then the panel eases into it.
    if (historyOpen) height += Math.max(0, parseFloat(el.historyPanel.style.height || 0) - el.historyPanel.offsetHeight);
    const content = height + 2 * GUTTER;
    // The window keeps its full height, and the empty part is click-through. Resizing it as
    // things open and close made everything jump: the webview follows a frame behind the window.
    const reserve = Math.round(window.screen.availHeight * QSettings.settings.maxHeightPct / 100) + 2 * GUTTER + 96;
    return { width: el.stack.offsetWidth + 2 * GUTTER, height: Math.max(content, reserve), content };
  }

  function sendFit(width, height, content = height) {
    if (width === lastFit.width && height === lastFit.height && content === lastFit.content) return;
    lastFit = { width, height, content };
    invoke("fit_window", { width, height, content }).catch(() => {});
  }

  function fitNow() {
    const want = wantedSize();
    const entry = responseEntry();
    const growing = !historyOpen && isStreaming() && entry && !entry.row.hasAttribute("data-capped");
    if (want.height > lastFit.height || want.width !== lastFit.width) {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
      // wantedSize already reserves the streaming viewport.
      const height = want.height > lastFit.height ? want.height : lastFit.height;
      sendFit(want.width, height, want.content);
    } else if (want.height < lastFit.height) {
      if (growing || shrinkTimer) return;
      // Shrink only after the exit animation, so nothing leaving gets clipped.
      shrinkTimer = setTimeout(() => {
        shrinkTimer = null;
        if (!historyOpen && isStreaming() && responseEntry()) return;
        const now = wantedSize();
        sendFit(now.width, now.height, now.content);
      }, QSettings.timings.t3 + 60);
    } else {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
      // Same window, but the bar may need to come down if the content no longer fits above it.
      if (want.content !== lastFit.content) sendFit(want.width, want.height, want.content);
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
    renderHistory();
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
    const activity = make("div", "tool-activity");
    activity.hidden = true;
    activity.setAttribute("role", "status");
    activity.setAttribute("aria-live", "polite");
    activity.append(makeProgressRing(), make("span", "tool-activity-label"), make("span", "tool-activity-track"));
    const generation = make("div", "image-generation");
    generation.hidden = true; generation.setAttribute("role", "status"); generation.setAttribute("aria-live", "polite");
    generation.append(makeProgressRing(), make("span", "image-generation-label", "Creating image…"), make("span", "image-generation-value"));
    const errorWrap = make("div", "turn-error");
    errorWrap.hidden = true;
    inner.append(activity, contentEl, mediaEl, generation, errorWrap);
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
    const retryBtn = make("button", "tool-btn");
    retryBtn.append(makeIcon("\uE72C"));
    retryBtn.type = "button"; retryBtn.dataset.action = "retry-reply"; retryBtn.dataset.id = turn.id;
    retryBtn.title = "Retry"; retryBtn.setAttribute("aria-label", "Retry");
    const openBtn = make("button", "tool-btn");
    openBtn.append(makeIcon("\uE8A7"));
    openBtn.type = "button"; openBtn.title = "Open in ChatGPT"; openBtn.setAttribute("aria-label", openBtn.title);
    openBtn.addEventListener("click", () => { if (chats.current.conversationId) invoke("open_external", { url: `https://chatgpt.com/c/${chats.current.conversationId}` }).catch(() => {}); });
    tools.append(copyBtn, retryBtn, openBtn, closeBtn);

    const jump = make("button", "jump-chip glass glass-tiny");
    jump.type = "button";
    jump.hidden = true;
    jump.title = "Jump to latest";
    jump.append(makeIcon(GLYPH.down), document.createTextNode("Latest"));
    jump.addEventListener("click", () => {
      userScrolledUp = false;
      jump.hidden = true;
      scroller.scrollTop = scroller.scrollHeight;
      const entry = turnNodes.get(turn.id);
      if (entry) { entry.followTop = scroller.scrollTop; syncScrollState(entry); }
    });

    scroller.addEventListener("wheel", (e) => {
      if (e.deltaY < 0) { const entry = turnNodes.get(turn.id); if (entry) holdStream(entry); }
    }, { passive: true });
    // The scrollbar, or a text selection that following would drag along.
    scroller.addEventListener("pointerdown", () => {
      const entry = turnNodes.get(turn.id);
      if (entry && row.dataset.status === "streaming") holdStream(entry);
    });
    scroller.addEventListener("scroll", () => {
      syncHistoryButton();
      const entry = turnNodes.get(turn.id);
      if (!entry) return;
      // Text keeps arriving, so a reader heading down counts as back once they are close.
      const heading = scroller.scrollTop > (entry.lastTop ?? 0);
      entry.lastTop = scroller.scrollTop;
      // A scroll event from following's last write may still be in flight when the reader
      // takes over; it must not count as them returning, or the wheel feels stuck again.
      const settled = performance.now() - (entry.heldAt ?? -Infinity) > 150;
      if (settled && (scrollGap(scroller) <= 2 || (heading && scrollGap(scroller) <= 48))) userScrolledUp = false;
      else if (scroller.scrollTop < (entry.followTop ?? 0) - 1) userScrolledUp = true;
      if (!userScrolledUp) { entry.followTop = scroller.scrollTop; followStream(entry); }
      syncScrollState(entry);
    }, { passive: true });

    row.append(bubble, tools, jump);
    const entry = { row, bubble, scroller, inner, contentEl, errorWrap, mediaEl, generation, activity, jump, mediaItems: new Map(), targetHeight: 0 };
    turnNodes.set(turn.id, entry);
    sizeObserver.observe(inner);
    // The viewport can shrink after following has caught up, reopening a small gap.
    sizeObserver.observe(scroller);
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
      sched.cancelFrame?.();
      sched.cancelFrame = null;
    }

    const turn = turns.find((t) => t.id === turnId);
    const entry = turnNodes.get(turnId);
    if (!turn || !entry || turn.role !== "assistant") return;

    entry.row.dataset.status = turn.status;
    const retryTool = entry.row.querySelector('[data-action="retry-reply"]');
    if (retryTool) retryTool.hidden = turn.status !== "done" || !turn.prompt || turn.hadAttachments;
    const openTool = entry.row.querySelector('[aria-label="Open in ChatGPT"]');
    if (openTool) openTool.hidden = !chats.current.conversationId;
    const activity = entry.activity;
    activity.hidden = turn.status !== "streaming" || turn.backendDone || turn.activity?.state !== "running";
    activity.dataset.kind = turn.activity?.kind || "tool";
    activity.querySelector(".tool-activity-label").textContent = turn.activity?.label || "Using a tool…";
    const generation = entry.generation;
    generation.hidden = turn.status !== "streaming" || turn.imageProgress?.state !== "generating";
    const percentage = turn.imageProgress?.percentage;
    const known = Number.isFinite(percentage);
    generation.toggleAttribute("data-percentage", known);
    generation.style.setProperty("--image-progress", known ? Math.max(0, Math.min(100, percentage)) : 0);
    generation.querySelector(".image-generation-value").textContent = known ? `${percentage}%` : "";
    generation.querySelector(".image-generation-label").textContent = turn.imageProgress?.phase === "preparing" ? "Preparing image…" : "Creating image…";

    const visibleText = entry.reveal ? entry.reveal.visible : turn.text;
    const streaming = turn.status === "streaming";
    // The stream's patched-up tail gives way to one full parse of the finished text.
    if (!streaming && entry.stable) entry.renderedText = null;
    if (entry.renderedText !== visibleText) {
      renderReply(entry, visibleText, turn.sources, streaming);
      window.QMath?.renderInto(entry.contentEl);
      hydrateWebImages(entry.contentEl);
      entry.renderedText = visibleText;
      if (streaming) noteRevealed(entry);
    }
    if (!streaming) clearFade(entry);
    if (turn.status === "error") {
      entry.errorWrap.replaceChildren(buildTurnError(turn));
      entry.errorWrap.hidden = false;
    } else {
      entry.errorWrap.hidden = true;
      entry.errorWrap.replaceChildren();
    }
    entry.row.toggleAttribute("data-empty", !turn.text && !entry.mediaEl.childElementCount && activity.hidden);
    followStream(entry);
    renderHistory();
    queueSizes();
  }

  // Keep transport snapshots separate from their paced presentation. The full
  // text remains on the turn for history/copy even while the visible tail drains.
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const streamStyle = () => QSettings.motionOn ? QSettings.settings.streamStyle || "paragraph" : "instant";

  // New words surface from low contrast. This is paint only (the CSS Highlight API), so it
  // adds no DOM, keeps selections intact and cannot change the layout of the text around it.
  const FADE_STEPS = [70, 150, 240];
  const fadeHighlights = typeof Highlight === "function" && window.CSS?.highlights;

  function clearFade(entry) {
    if (!entry?.fade) return;
    entry.fade = null;
    if (fadeHighlights) FADE_STEPS.forEach((_, i) => CSS.highlights.delete(`qchat-fade-${i}`));
  }

  function noteRevealed(entry) {
    if (!fadeHighlights || !["fade", "paragraph"].includes(streamStyle())) return;
    const length = entry.contentEl.textContent.length;
    const fade = entry.fade ||= { length: 0, recent: [], running: false };
    if (length > fade.length) fade.recent.push({ count: Math.min(length - fade.length, 800), at: performance.now() });
    fade.length = length;
    if (!fade.running) { fade.running = true; paintFade(entry, fade); }
  }

  function paintFade(entry, fade) {
    if (entry.fade !== fade) return;
    const now = performance.now();
    fade.recent = fade.recent.filter(item => now - item.at < FADE_STEPS.at(-1));
    const sets = FADE_STEPS.map(() => new Highlight());
    let node = entry.contentEl;
    while (node.lastChild) node = node.lastChild;
    const walker = document.createTreeWalker(entry.contentEl, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    let text = node.nodeType === Node.TEXT_NODE ? node : walker.previousNode();
    let end = text ? text.length : 0;
    for (let i = fade.recent.length - 1; i >= 0 && text; i--) {
      const age = now - fade.recent[i].at;
      const set = sets[FADE_STEPS.findIndex(limit => age < limit)];
      let left = fade.recent[i].count;
      while (left > 0 && text) {
        const take = Math.min(left, end);
        if (take) {
          const range = new Range();
          range.setStart(text, end - take);
          range.setEnd(text, end);
          set.add(range);
        }
        left -= take;
        end -= take;
        if (end === 0) { text = walker.previousNode(); end = text ? text.length : 0; }
      }
    }
    sets.forEach((set, i) => CSS.highlights.set(`qchat-fade-${i}`, set));
    if (fade.recent.length) requestAnimationFrame(() => paintFade(entry, fade));
    else fade.running = false;
  }

  function cancelReveal(entry) {
    entry?.reveal?.cancel?.();
    if (entry?.reveal) entry.reveal.cancel = null;
  }

  function finishReveal(turn, entry) {
    if (!turn.backendDone || turn.status !== "streaming") return;
    turn.status = "done";
    el.statusLabel.textContent = "ChatGPT replied";
    // Multiline answers keep their wrapping width when the streaming class ends.
    entry.row.toggleAttribute("data-wide", /\n/.test(turn.text) || entry.inner.offsetHeight > 72);
    renderTurnNow(turn.id);
    updateComposerMode();
    armAutoDismiss();
    if (historyOpen) backfillHistory(chats.current);
    // Images in a reply exist only in the saved record, so read it once the page has saved it.
    // Rich replies get a second look, as the page can finish saving them a little later.
    const chat = chats.current;
    if (turn.chatKey === chat.key && chat.conversationId && bridge.loggedIn && !chat.temporary) {
      turn.restored = true;
      // Stops as soon as the bubble has been rebuilt from the record.
      const read = () => { if (chats.current === chat && !isBusy() && turns.some(t => t.id === turn.id)) { backfilled.delete(chat); backfillHistory(chat); } };
      setTimeout(read, 700);
      if (turn.rich) { setTimeout(read, 2200); setTimeout(read, 6000); }
    }
    queueSizes();
  }

  function flushReveal(turn) {
    const entry = turnNodes.get(turn.id);
    cancelReveal(entry);
    clearTimeout(entry?.reveal?.holdTimer);
    if (entry?.reveal) entry.reveal.visible = turn.text;
    if (entry) finishReveal(turn, entry);
  }

  // Where the reveal may pause. Whole words by default, so a word never starts on one line
  // and jumps to the next as it grows; the last word waits briefly in case it is unfinished.
  function revealPlan(turn, state) {
    const style = streamStyle();
    if (style === "paragraph") {
      // Live tokens can be rough until a block is finished, so only finished blocks show.
      clearTimeout(state.holdTimer);
      state.holdTimer = null;
      return window.QStream.revealStops(turn.backendDone ? turn.text : turn.text.slice(0, window.QStream.completeBoundary(turn.text)));
    }
    if (style === "type") {
      const stops = [];
      for (const part of graphemes.segment(turn.text)) stops.push(part.index + part.segment.length);
      return stops;
    }
    const stops = window.QStream.revealStops(turn.text);
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
    if (!turn.backendDone && stops.length && !/\s$/.test(turn.text)) {
      stops.pop();
      const target = turn.text;
      state.holdTimer = setTimeout(() => {
        if (state.target !== target || turn.status !== "streaming") return;
        state.stops.push(target.length);
        paceTurn(turn);
      }, 220);
    }
    return stops;
  }

  function paceTurn(turn) {
    const entry = turnNodes.get(turn.id);
    if (!entry || turn.status !== "streaming") return;
    let state = entry.reveal;
    if (!state) state = entry.reveal = { visible: "", target: null, stops: [], index: 0, last: Date.now(), credit: 0, rate: 0, cancel: null, sawDone: false };
    if (state.target !== turn.text || state.sawDone !== Boolean(turn.backendDone)) {
      // Only unseen tails are paced. A correction to visible text (including an
      // extended final grapheme) replaces the snapshot once, without replay.
      const shown = state.visible.length;
      const intact = turn.text.startsWith(state.visible) && (!shown || shown === turn.text.length ||
        (() => { const g = graphemes.segment(turn.text).containing(shown - 1); return g.index + g.segment.length === shown; })());
      state.target = turn.text;
      state.sawDone = Boolean(turn.backendDone);
      state.stops = revealPlan(turn, state);
      if (!intact) {
        cancelReveal(entry);
        clearTimeout(state.holdTimer);
        state.index = state.stops.length;
        state.visible = streamStyle() === "paragraph" && !turn.backendDone ? turn.text.slice(0, state.stops.at(-1) || 0) : turn.text;
        state.credit = 0;
        state.last = Date.now();
        if (turn.text) revealResponse(turn);
        renderTurnNow(turn.id);
        finishReveal(turn, entry);
        return;
      }
      state.index = state.stops.findIndex(stop => stop > shown);
      if (state.index < 0) state.index = state.stops.length;
    }
    if (streamStyle() === "instant") {
      flushReveal(turn);
      if (turn.text) revealResponse(turn);
      renderTurnNow(turn.id);
      return;
    }
    if (state.cancel) return;
    if (state.index >= state.stops.length) {
      if (turn.backendDone || !state.holdTimer) renderTurnNow(turn.id);
      finishReveal(turn, entry);
      return;
    }
    const tick = () => {
      state.cancel = null;
      if (turnNodes.get(turn.id) !== entry || turn.status !== "streaming") return;
      if (streamStyle() === "instant") { flushReveal(turn); renderTurnNow(turn.id); return; }
      const now = Date.now();
      const elapsed = Math.min(64, Math.max(0, now - state.last));
      state.last = now;
      const remaining = (state.stops.at(-1) ?? state.visible.length) - state.visible.length;
      const base = 95 * (QSettings.settings.streamSpeed || 1);
      // Drain a backlog gradually: the rate glides, so a burst from the network reads as
      // a slightly faster flow rather than a lurch.
      const wanted = turn.backendDone
        ? Math.max(base, remaining / Math.max(0.04, ((state.deadline ?? now + 1200) - now) / 1000))
        : Math.max(base, remaining / 1.4);
      state.rate = !state.rate || turn.backendDone ? wanted : state.rate + (wanted - state.rate) * Math.min(1, elapsed / 280);
      state.credit += elapsed * state.rate / 1000;
      let moved = false;
      while (state.index < state.stops.length && state.stops[state.index] - state.visible.length <= state.credit) {
        const stop = state.stops[state.index++];
        state.credit -= stop - state.visible.length;
        state.visible = state.target.slice(0, stop);
        moved = true;
      }
      if (moved) {
        revealResponse(turn);
        renderTurnNow(turn.id);
      }
      if (state.index < state.stops.length) state.cancel = nextFrame(tick);
      else { state.credit = 0; finishReveal(turn, entry); }
    };
    state.last = Date.now();
    state.cancel = nextFrame(tick);
  }

  function scheduleTurnRender(turnId, immediate = false) {
    if (immediate) {
      renderTurnNow(turnId);
      return;
    }
    let sched = renderSchedule.get(turnId);
    if (!sched) {
      sched = { queued: false, cancelFrame: null };
      renderSchedule.set(turnId, sched);
    }
    if (sched.queued) return;
    sched.queued = true;
    sched.cancelFrame = nextFrame(() => {
      if (sched.queued && renderSchedule.get(turnId) === sched) renderTurnNow(turnId);
    });
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

    if (!QSettings.settings.showPrompt) for (const other of turns.slice()) if (other.role === "user") retireTurn(other);
    queueSizes();
    fitNow();
  }

  function retireTurn(turn, immediate = false) {
    rememberTurn(turn);
    const index = turns.indexOf(turn);
    if (index >= 0) turns.splice(index, 1);
    for (const file of turn.attachments || []) releasePreview(file.previewURL);
    const entry = turnNodes.get(turn.id);
    cancelReveal(entry);
    clearTimeout(entry?.reveal?.holdTimer);
    clearFade(entry);
    const sched = renderSchedule.get(turn.id);
    sched?.cancelFrame?.();
    if (sched) sched.queued = false;
    renderSchedule.delete(turn.id);
    turnNodes.delete(turn.id);
    if (!entry) return;
    if (entry.inner) { sizeObserver.unobserve(entry.inner); sizeObserver.unobserve(entry.scroller); }
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
    let stopping = false;
    for (const turn of turns.slice()) {
      if (turn.status === "streaming") { stopping = true; turn.status = "done"; turn.stopped = true; }
      retireTurn(turn, immediate);
    }
    if (stopping) void stopBackend();
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
      if (historyOpen || entry.row.matches(":hover, :focus-within")) { autoDismissTimer = setTimeout(check, 1500); return; }
      dismissExchange();
    };
    autoDismissTimer = setTimeout(check, seconds * 1000);
  }

  function showCachedResponse(chat) {
    renderHistory();
    const cachedTurn = chat.transcript.findLast(item => item.role === "assistant");
    const snapshot = completedSnapshot(cachedTurn ? cachedTurn.text : chat.lastResponse, cachedTurn ? cachedTurn.hasMedia : chat.lastHasMedia);
    const stored = chat.conversationId ? (cachedTurn?.media || []) : [];
    const fallback = !stored.length && (snapshot.hasMedia || (!snapshot.text && chat.conversationId && chat.lastPrompt));
    if (!snapshot.text && !fallback && !stored.length) return;
    const turn = { id: cachedTurn?.id || crypto.randomUUID(), role: "assistant", text: snapshot.text, sources: cleanSources(cachedTurn ? cachedTurn.sources : chat.lastSources), status: "done", restored: true, cachedMedia: Boolean(fallback), chatKey: chat.key, prompt: chat.lastPrompt, hadAttachments: cachedTurn?.hadAttachments || chat.lastHadAttachments, stopped: Boolean(cachedTurn?.stopped) };
    turns.push(turn);
    el.zone.append(createResponseRow(turn));
    const entry = turnNodes.get(turn.id);
    renderSources(turn);
    if (stored.length) {
      entry.mediaEl.append(...stored.map(file => storedMediaCard(file, chat.conversationId)));
      entry.row.toggleAttribute("data-media-first", stored.some(file => file.before));
      entry.row.toggleAttribute("data-wide", true);
    }
    if (fallback) {
      const view = make("button", "hyperlink-btn", "View in ChatGPT");
      view.type = "button";
      view.dataset.action = "view-media";
      entry.mediaEl.append(view);
    }
    // Restored context is already complete: no entrance or letter replay.
    renderTurnNow(turn.id);
    entry.row.hidden = false;
    entry.row.toggleAttribute("data-wide", /\n/.test(turn.text) || entry.inner.offsetHeight > 72);
    el.zone.hidden = false;
    syncBubbleSize(entry);
    queueSizes();
  }

  // ---------------------------------------------------------------------------
  // 9. Composer
  // ---------------------------------------------------------------------------
  function updateComposerMode() {
    const active = isStreaming();
    const sendKey = QSettings.settings.sendKey === "ctrl" ? "Ctrl+Enter" : "Enter";
    const placeholder = QSettings.settings.placeholderText || "Ask anything";
    el.promptInput.placeholder = bridge.ready ? (firstRunHint ? `${placeholder}, or type / for commands` : placeholder) : "Connecting…";
    el.btnSend.dataset.mode = active ? "stop" : "send";
    el.btnSend.firstElementChild.textContent = active ? GLYPH.stop : GLYPH.send;
    el.btnSend.title = active ? "Stop generating (Ctrl+.)" : `Send (${sendKey})`;
    el.btnSend.setAttribute("aria-label", active ? "Stop generating" : "Send");
    const staging = pendingFiles.some((f) => f.state === "staging");
    const attachable = pendingFiles.some((f) => f.state === "ready");
    el.btnAttach.disabled = active || sending;
    el.btnSnapshot.disabled = active || sending || snapshotCapturing;
    el.btnSend.disabled = !active && (!bridge.ready || sending || staging || snapshotCapturing || (!el.promptInput.value.trim() && !attachable));
    syncReasoningButton();
    syncTabsDisabled();
  }

  let promptMeasure;
  function autoResizePrompt() {
    const input = el.promptInput;
    if (!promptMeasure) {
      promptMeasure = document.createElement("textarea");
      promptMeasure.className = "bar-input prompt-measure";
      promptMeasure.tabIndex = -1;
      promptMeasure.setAttribute("aria-hidden", "true");
      promptMeasure.rows = 1;
      input.parentElement.append(promptMeasure);
    }
    promptMeasure.style.width = `${input.getBoundingClientRect().width}px`;
    promptMeasure.value = input.value;
    const full = promptMeasure.scrollHeight;
    const style = getComputedStyle(input);
    const max = parseFloat(style.lineHeight) * 6 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    promptTargetHeight = Math.min(full, max);
    input.style.height = `${promptTargetHeight}px`;
    input.style.overflowY = full > max + 1 ? "auto" : "hidden";
    updateComposerMode();
    queueSizes();
  }

  const IMAGE_PROMPT = /^(?:please\s+)?(?:generate|create|draw|paint|render|make|design)\b[\s\S]{0,100}\b(?:image|picture|photo|illustration|artwork|portrait)\b/i;

  async function sendPrompt(rawPrompt, { fromInput = false } = {}) {
    const prompt = String(rawPrompt ?? "").trim();
    const files = pendingFiles.filter((f) => f.state === "ready");
    if (snapshotCapturing || isBusy() || pendingFiles.some((f) => f.state === "staging") || (!prompt && !files.length)) return;
    prompts.push(prompt); recallIndex = -1; firstRunHint = false;
    try { localStorage.setItem("qchat.introduced", "1"); } catch (_) {}
    el.promptInput.placeholder = QSettings.settings.placeholderText || "Ask anything";
    const chat = chats.current;
    const reasoningEffort = effectiveReasoning(chat);
    sending = true;
    sentReasoning = reasoningEffort;
    const generation = chatGeneration;
    const draft = el.promptInput.value;
    const restoreDraft = () => {
      if (fromInput && !el.promptInput.value) { el.promptInput.value = draft; autoResizePrompt(); }
    };

    hideGlobalError();
    closeSlashMenu();
    if (!featureList.hidden) closeFeatureList();
    hideClearConfirm();
    setHistoryOpen(false);
    dismissExchange();
    sentThisSession = true;

    const userTurn = { id: crypto.randomUUID(), role: "user", text: prompt, status: "done", chatKey: chat.key, attachments: files.map((f) => ({ name: f.file.name, size: f.file.size, previewURL: imagePreview(f.file) })) };
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
    chat.lastPrompt = prompt;
    chat.lastHadAttachments = files.length > 0;
    rememberTurn(userTurn);
    rememberTurn(assistantTurn);
    chat.lastActive = Date.now();
    saveChats();

    if (fromInput) { el.promptInput.value = ""; chat.draft = ""; autoResizePrompt(); }
    updateGuestNotice();
    updateIdleChips();
    updateComposerMode();
    syncZone();

    try {
      await ensurePage(chat);
      if (generation !== chatGeneration) return;
      if (assistantTurn.status !== "streaming") throw { code: "stopped" };
      await invoke("chat_send", { id: assistantTurn.id, prompt, attachmentIds: files.map((f) => f.id), reasoningEffort });
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
      flushReveal(assistantTurn);
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
    const stopping = turns.filter((t) => t.status === "streaming");
    for (const t of stopping) {
      if (t.status !== "streaming") continue;
      flushReveal(t);
      t.status = "done";
      if (!t.text && !t.media?.length) {
        // Nothing arrived, so there is no reply to keep: restore the prompt and
        // remove the empty exchange instead of leaving a completed-looking one.
        if (!el.promptInput.value) { el.promptInput.value = t.prompt || ""; autoResizePrompt(); }
        for (const turn of turns.slice()) retireTurn(turn, true);
        continue;
      }
      t.stopped = true;
      recordPartial(t);
      const entry = turnNodes.get(t.id);
      if (entry) { revealResponse(t); scheduleTurnRender(t.id, true); }
    }
    updateComposerMode();
    queueSizes();
    await stopBackend();
    if (!sending && !turns.some((t) => t.role === "assistant" && (t.text || t.media?.length))) dismissExchange();
    updateComposerMode();
    queueSizes();
  }

  function discardPendingFiles() {
    for (const item of pendingFiles.slice()) removeAttachment(item);
    for (const url of [...imageURLs]) releasePreview(url);
  }

  async function startNewChat(notifyBackend = true) {
    if (isStreaming()) await stopStreaming();
    chats.current.draft = el.promptInput.value;
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
    setModeLabel("");
    setHistoryOpen(false);
    renderHistory();
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

  const allChatsTab = make("button", "tab-all glass glass-tiny");
  allChatsTab.type = "button";
  allChatsTab.title = "All chats (Ctrl+P)";
  allChatsTab.setAttribute("aria-label", "All chats");
  allChatsTab.append(makeIcon("\uE81C"));
  allChatsTab.addEventListener("click", () => showChatList(allChatsTab));

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
    const nodes = chats.recent.slice(0, QSettings.settings.tabCount || 3).map((chat) => {
      let tab = existing.get(chat.key);
      if (!tab) {
        tab = make("button", "tab glass glass-tiny pop");
        tab.type = "button";
        tab.dataset.key = chat.key;
        tab.style.setProperty("--i", String(fresh++));
        tab.append(makeIcon(GLYPH.clock), make("span", "tab-title"), make("span", "tab-label"));
        tab.addEventListener("animationend", () => tab.classList.remove("pop"), { once: true });
        tab.addEventListener("click", () => switchToChat(tab.dataset.key));
      }
      const label = elapsedLabel(chat.lastActive);
      tab.querySelector(".tab-label").textContent = label;
      const title = chat.title || "Untitled chat";
      const characters = Array.from(title);
      tab.querySelector(".tab-title").textContent = characters.length > 24
        ? `${characters.slice(0, 23).join("")}…` : title;
      const when = label === "now" ? "just now" : `${label} ago`;
      tab.title = `${title}\nLast active ${when}`;
      tab.setAttribute("aria-label", `Switch to chat: ${title}, last active ${when}`);
      return tab;
    });
    el.tabs.replaceChildren(...nodes, allChatsTab);
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
    previous.draft = el.promptInput.value;
    chats.recent.splice(index, 1);
    if (hasContent(previous) && !previous.temporary) { previous.lastActive = now; chats.recent.unshift(previous); }
    chats.recent = chats.recent.slice(0, MAX_RECENT);
    target.lastActive = now;
    chats.current = target;
    el.promptInput.value = target.draft || "";
    autoResizePrompt();
    setHistoryOpen(false);
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
    // Bring the whole chat up to date as soon as it is opened.
    if (target.conversationId) backfillHistory(target);
  }

  // ---------------------------------------------------------------------------
  // 11. Slash commands
  // ---------------------------------------------------------------------------
  const modeChip = make("div", "mode-chip glass glass-tiny"); modeChip.id = "mode-chip"; modeChip.hidden = true; el.tabs.before(modeChip);
  const modelChip = modeChip.cloneNode(false);
  modelChip.id = 'model-chip';
  const modeChips = make("div", "mode-chips");
  modeChip.before(modeChips); modeChips.append(modeChip, modelChip);
  function setModelLabel(label) { modelChip.textContent = String(label || '').split('\n')[0].slice(0,28); modelChip.hidden = !modelChip.textContent; queueSizes(); }
  function setModeLabel(label) { modeChip.textContent = label; modeChip.hidden = !label; queueSizes(); }
  const COMMANDS = [
    { name: "settings", icon: GLYPH.settings, desc: () => "Open settings", run: () => invoke("open_settings").catch(() => showGlobalError(null, "Couldn't open settings. Try again.")) },
    { name: "new", icon: GLYPH.newChat, desc: () => "Start a new chat", run: () => startNewChat(true) },
    { name: "signin", icon: GLYPH.account, desc: () => (bridge.loggedIn ? "Manage account" : "Sign in to ChatGPT"), run: () => openSignin() },
    { name: "clear", icon: GLYPH.trash, desc: () => "Clear recent chats", run: () => showClearConfirm() },
    { name: "hide", icon: GLYPH.hide, desc: () => "Hide QChat", run: () => invoke("hide_main").catch(() => {}) }
  ];
  COMMANDS.push(
    { name: "model", icon: GLYPH.settings, desc: () => "Model", run: () => { showFeatureList("Loading models…", []); invoke("chat_models").catch(() => showModels({ error: "unavailable" })); } },
    { name: "temp", icon: GLYPH.newChat, desc: () => "Temporary chat", run: async () => { await startNewChat(false); chats.current.temporary = true; setModeLabel("Temporary"); pageSync = freshInPage(chats.current); } },
    { name: "chats", icon: GLYPH.clock, desc: () => "Chats", run: showChatList },
    { name: "keys", icon: GLYPH.settings, desc: () => "Keyboard shortcuts", run: async () => {
      let hotkey = "Alt+Q"; try { hotkey = await invoke("get_hotkey") || hotkey; } catch (_) {}
      const shortcuts = [[hotkey, "Show QChat"], [QSettings.settings.sendKey === "ctrl" ? "Ctrl+Enter" : "Enter", "Send"], ["Shift+Enter", "New line"], ["Esc", "Close"], ["Ctrl+N", "New chat"], ["Ctrl+K", "Menu"], ["Ctrl+P", "Chats"], ["Ctrl+.", "Stop"], ["ArrowUp / ArrowDown", "Recall prompts"], ["Paste / drop", "Attach files"]];
      showFeatureList("Keyboard shortcuts", shortcuts.map(([key, action]) => ({ keys: key, title: action })));
    } }
  );
  const featureList = make("section", "feature-list glass");
  featureList.hidden = true; featureList.tabIndex = -1; el.slashMenu.before(featureList);
  // The control that opened the list. A pointer-down on it must not close the
  // list, or its click would reopen it and the panel would flash.
  let featureListAnchor = null;
  let featureListHideTimer = null;
  function hideFeatureList() {
    clearTimeout(featureListHideTimer);
    featureListHideTimer = null;
    featureList.hidden = true;
    featureList.removeAttribute("data-leaving");
    featureList.style.removeProperty("--leave-height");
    featureListAnchor = null;
    queueSizes();
  }
  function closeFeatureList() {
    featureListAnchor = null;
    if (featureList.hidden || featureList.hasAttribute("data-leaving")) return;
    clearTimeout(featureListHideTimer);
    featureListHideTimer = null;
    if (QSettings.motionOn) {
      // Fade and collapse first; the list leaves the layout only once it is gone.
      featureList.style.setProperty("--leave-height", `${featureList.offsetHeight}px`);
      featureList.setAttribute("data-leaving", "");
      featureListHideTimer = setTimeout(hideFeatureList, QSettings.timings.t2 + 30);
    } else hideFeatureList();
    queueSizes();
    el.promptInput.focus();
  }
  function showFeatureList(title, rows, searchable = false, anchor = null) {
    closeSlashMenu();
    clearTimeout(featureListHideTimer);
    featureListHideTimer = null;
    featureList.removeAttribute("data-leaving");
    featureList.style.removeProperty("--leave-height");
    featureListAnchor = anchor;
    const keysCard = typeof rows !== "function" && rows.some(row => row.keys);
    featureList.classList.toggle("feature-keys", keysCard);
    featureList.replaceChildren(); featureList.hidden = false;
    const getRows = typeof rows === "function" ? rows : () => rows;
    const field = make("input", "feature-search"); field.placeholder = "Search chats"; field.setAttribute("aria-label", "Search chats");
    if (searchable) featureList.append(field); else featureList.append(make("div", "feature-heading", title));
    const results = make("div", "feature-results"); featureList.append(results);
    let lines = [], selected = 0;
    const mark = () => lines.forEach((entry, i) => { if (i === selected) entry.line.dataset.selected = ""; else delete entry.line.dataset.selected; });
    const paint = () => {
      results.replaceChildren(); lines = []; selected = 0;
      const query = `${field.value}`.toLowerCase();
      for (const row of getRows().filter(row => `${row.title} ${row.prompt || ""}`.toLowerCase().includes(query))) {
        const line = make("div", "feature-row");
        if (row.selected !== undefined) {
          const check = makeIcon(GLYPH.check, "icon feature-check");
          check.style.visibility = row.selected ? "visible" : "hidden";
          line.append(check);
        }
        if (row.run) {
          const button = make("button", "feature-choice"); button.type = "button";
          button.append(make("span", "feature-title", row.title), make("span", "feature-meta", row.meta || ""));
          button.onclick = () => { closeFeatureList(); row.run(); };
          line.append(button); lines.push({ line, row });
        } else {
          line.append(make("kbd", "key", row.keys), make("span", "feature-title", row.title));
        }
        if (row.remove) { const remove = make("button", "tool-btn"); remove.type = "button"; remove.setAttribute("aria-label", "Remove chat"); remove.append(makeIcon(GLYPH.close)); remove.onclick = row.remove; line.append(remove); }
        results.append(line);
      }
      mark();
      if (title === "Chats" && !lines.length) results.append(make("p", "feature-heading", accountChats.loading ? "Loading your chats…" : query ? "No chats match" : "No chats yet"));
    };
    featureList._repaint = searchable ? () => { const scroll = results.scrollTop; paint(); results.scrollTop = scroll; } : null;
    field.oninput = paint;
    featureList.onkeydown = e => {
      if (e.key === "Escape") { e.stopPropagation(); closeFeatureList(); }
      else if (keysCard) { if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") { e.preventDefault(); closeFeatureList(); } }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + lines.length) % lines.length; mark(); }
      else if (e.key === "Enter") { e.preventDefault(); const entry = lines[selected] || lines[0]; if (entry) { closeFeatureList(); entry.row.run(); } }
    };
    paint(); queueSizes(); (searchable ? field : featureList).focus();
  }
  function showModels(event) {
    const models = event.models || [];
    showFeatureList(models.length ? "Model" : event.error ? "Couldn't read the model list" : "Sign in to choose a model", models.length ? models.map(model => ({ title: model.label, selected: Boolean(model.selected), run: () => invoke("chat_model_choose", { id: model.id }).catch(() => {}) })) : [{ title: event.error ? "Open ChatGPT" : "Sign in", run: openSignin }]);
  }
  listen("bridge", ({ payload }) => { if (payload.type === "models") showModels(payload); else if (payload.type === "model-chosen") setModelLabel(payload.model.label); });
  // Every chat on the account, read through the signed-in page, with this PC's chats first.
  const accountChats = { items: [], loading: false, loaded: false, at: 0 };

  function loadAccountChats() {
    if (accountChats.loading || !bridge.loggedIn) return;
    // ChatGPT rate-limits this list, so reopening the menu reuses a recent copy.
    if (accountChats.loaded && Date.now() - accountChats.at < 120000) return;
    accountChats.loading = true;
    accountChats.items = [];
    invoke("chat_list_conversations", { offset: 0 }).catch(() => { accountChats.loading = false; });
  }

  function receiveAccountChats(event) {
    const seen = new Set(accountChats.items.map(item => item.id));
    for (const item of Array.isArray(event.items) ? event.items : []) if (!seen.has(item.id)) accountChats.items.push(item);
    const more = !event.error && event.items?.length && accountChats.items.length < Math.min(event.total || 0, 600);
    if (more) setTimeout(() => invoke("chat_list_conversations", { offset: accountChats.items.length }).catch(() => { accountChats.loading = false; }), 500);
    else { accountChats.loading = false; accountChats.loaded = !event.error; accountChats.at = Date.now(); }
    if (!featureList.hidden) featureList._repaint?.();
  }

  function openAccountChat(item) {
    if (isBusy()) return;
    const chat = { ...freshChat(), conversationId: item.id, title: (item.title || "Untitled chat").slice(0, 40), lastActive: item.updated || Date.now() };
    chats.recent.unshift(chat);
    switchToChat(chat.key);
    setHistoryOpen(true);
  }

  function chatRows() {
    const local = chats.recent.map(chat => ({ title: chat.title || "Untitled chat", meta: elapsedLabel(chat.lastActive), prompt: chat.lastPrompt, run: () => switchToChat(chat.key), remove: () => { chats.recent = chats.recent.filter(c => c.key !== chat.key); saveChats(); renderTabs(); featureList._repaint?.(); } }));
    const known = new Set([chats.current.conversationId, ...chats.recent.map(chat => chat.conversationId)]);
    const account = accountChats.items.filter(item => !known.has(item.id)).map(item => ({ title: item.title || "Untitled chat", meta: item.updated ? elapsedLabel(item.updated) : "", run: () => openAccountChat(item) }));
    return [...local, ...account];
  }

  function showChatList(anchor = null) {
    loadAccountChats();
    showFeatureList("Chats", chatRows, true, anchor);
  }
  document.addEventListener("pointerdown", e => {
    if (featureList.hidden || featureList.contains(e.target)) return;
    // Let the opener's click decide; closing here would flash before it runs.
    if (featureListAnchor?.contains(e.target)) return;
    closeFeatureList();
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !featureList.hidden) { e.stopImmediatePropagation(); e.preventDefault(); closeFeatureList(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); showChatList(); }
  }, true);
  let slashMatches = [];
  let slashIndex = 0;

  const slashOpen = () => !el.slashMenu.hidden;

  function syncMenuFlag() {
    const away = slashOpen() || !el.clearConfirm.hidden;
    if (away) el.stack.dataset.menu = ""; else delete el.stack.dataset.menu;
  }

  function closeSlashMenu() {
    commandMenu = false;
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

  let commandMenu = false;
  function updateSlashMenu() {
    const value = el.promptInput.value;
    const query = commandMenu ? "" : /^\/\S*$/.test(value) ? value.slice(1).toLowerCase() : null;
    let matches = query === null ? [] : COMMANDS.filter((c) => c.name.startsWith(query));
    if (commandMenu) { const order = ["new", "chats", "model", "temp", "settings", "signin", "clear", "keys", "hide"]; matches = order.map(name => COMMANDS.find(c => c.name === name)); }
    if (!matches.length) { if (slashOpen()) closeSlashMenu(); return; }
    const wasOpen = slashOpen();
    const previous = slashMatches.map((c) => c.name).join(",");
    slashMatches = matches;
    const changed = matches.map((c) => c.name).join(",") !== previous;
    slashIndex = wasOpen && !changed ? Math.min(slashIndex, matches.length - 1) : 0;
    el.slashMenu.replaceChildren(...matches.map((cmd) => {
      const item = make("div", "slash-item");
      item.id = `slash-${cmd.name}`;
      item.setAttribute("role", "option");
      item.dataset.command = cmd.name;
      item.append(makeIcon(cmd.icon), make("span", "slash-name", (commandMenu ? cmd.name : `/${cmd.name}`)), make("span", "slash-desc", cmd.desc()));
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
  function paintStatusDot() {
    let state;
    let label;
    if (bridge.signedOut) { state = "signed-out"; label = "Signed out"; }
    else if (!bridge.ready) { state = "connecting"; label = bridge.loggedIn ? "Loading chat…" : "Connecting…"; }
    else if (bridge.loggedIn) { state = "ready"; label = "Ready"; }
    else { state = "guest"; label = "Guest"; }

    el.statusDot.dataset.state = state;
    el.statusLabel.textContent = label;
    el.orb.title = "QChat menu";
  }

  function setStatusError() {
    el.statusDot.dataset.state = "error";
    el.statusLabel.textContent = "Error";
    el.orb.title = "QChat menu";
  }

  let startupRead = false;
  function updateStatusHeader({ ready, loggedIn, signedOut }) {
    bridge.ready = Boolean(ready);
    bridge.loggedIn = Boolean(loggedIn);
    bridge.signedOut = Boolean(signedOut);
    paintStatusDot();
    if (bridge.ready && bridge.loggedIn && !startupRead) {
      startupRead = true;
      backfillHistory(chats.current);
    }
    if (bridge.ready) {
      clearTimeout(connectTimer);
      connectTimer = null;
      if (connectErrorShown) hideGlobalError();
    }
    updateGuestNotice();
    updateComposerMode();
  }

  function armConnectDeadline() {
    clearTimeout(connectTimer);
    connectTimer = null;
    if (bridge.ready) return;
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!bridge.ready) showGlobalError("offline");
    }, CONNECT_DEADLINE);
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
    const retry = code === "offline";
    el.btnErrorSignin.hidden = !(code === "auth" || retry);
    el.btnErrorSignin.textContent = retry ? "Try again" : "Sign in";
    el.btnErrorSignin.dataset.action = retry ? "retry-connect" : "signin";
    connectErrorShown = retry;
    el.globalError.hidden = false;
    setStatusError();
    queueSizes();
  }

  function hideGlobalError() {
    if (el.globalError.hidden) return;
    el.globalError.hidden = true;
    el.globalErrorText.textContent = "";
    el.btnErrorSignin.hidden = true;
    el.btnErrorSignin.textContent = "Sign in";
    el.btnErrorSignin.dataset.action = "signin";
    connectErrorShown = false;
    paintStatusDot();
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
    invoke("set_selection_clipboard", { enabled: QSettings.settings.selectionClipboard }).catch(() => {});
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
    if (!QSettings.motionOn) for (const turn of turns) { flushReveal(turn); scheduleTurnRender(turn.id, true); }
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
  // Announcement is handled by the polite status label; the log itself would
  // otherwise repeat every streamed snapshot.
  el.zone.setAttribute("aria-live", "off");
  el.historyButton.addEventListener("click", () => setHistoryOpen(!historyOpen));
  el.btnAllChats.addEventListener("click", () => showChatList(el.btnAllChats));
  el.historyPanel.addEventListener("scroll", () => {
    syncHistoryEdge();
    if (el.historyPanel.scrollHeight - el.historyPanel.scrollTop - el.historyPanel.clientHeight <= 2) historyHeld = false;
  }, { passive: true });
  el.historyPanel.addEventListener("wheel", (e) => { if (e.deltaY < 0) historyHeld = true; }, { passive: true });
  el.historyPanel.addEventListener("pointerdown", () => { historyHeld = true; });
  el.historyPanel.addEventListener("click", (e) => {
    const anchor = e.target.closest("a");
    if (anchor) {
      e.preventDefault();
      const url = sanitizeHref(anchor.getAttribute("href") || "");
      if (url) invoke("open_external", { url }).catch(() => {});
    }
    const button = e.target.closest("[data-action]");
    if (button?.dataset.action === "copy-code") {
      const code = button.closest(".code-block")?.querySelector("pre code");
      if (code) copyWithFeedback(code.textContent, button);
    } else if (button?.dataset.action === "history-copy") {
      copyWithFeedback(button.closest(".history-row")?._copyText || "", button);
    } else if (button?.dataset.action === "history-media") {
      const chat = chats.current;
      button.disabled = true;
      pageSync = pageSync.catch(() => {}).then(() => {
        if (chats.current === chat && chat.conversationId && page.conv !== chat.conversationId) return openInPage(chat);
      });
      void pageSync.then(() => { if (chats.current === chat) openSignin(); })
        .catch(err => showGlobalError(errorCode(err))).finally(() => { button.disabled = false; });
    }
  });

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
    } else if (action === "retry-turn" || action === "retry-reply") {
      const turn = turns.find((t) => t.id === actionBtn.dataset.id);
      if (turn && turn.prompt && !turn.hadAttachments && !isStreaming()) {
        sendPrompt(turn.prompt);
        el.promptInput.focus();
      }
    } else if (action === "view-media") {
      const row = actionBtn.closest(".turn-row");
      const turn = turns.find((t) => t.id === row?.dataset.id);
      if (turn?.cachedMedia) {
        const chat = chats.current;
        actionBtn.disabled = true;
        pageSync = pageSync.catch(() => {}).then(() => {
          if (chats.current === chat && chat.conversationId && page.conv !== chat.conversationId) return openInPage(chat);
        });
        void pageSync.then(() => {
          if (chats.current === chat) openSignin();
        }).catch((err) => showGlobalError(errorCode(err))).finally(() => { actionBtn.disabled = false; });
        return;
      }
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
    recallIndex = -1;
    autoResizePrompt();
    updateSlashMenu();
    updateIdleChips();
  });

  function openCommandMenu() { commandMenu = true; updateSlashMenu(); el.promptInput.focus(); }
  el.orb.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCommandMenu(); } });
  let orbDown = null, orbDragged = false;
  el.orb.addEventListener("pointerdown", e => { if (e.button !== 0) return; orbDown = [e.clientX, e.clientY]; orbDragged = false; el.orb.setPointerCapture?.(e.pointerId); });
  el.orb.addEventListener("pointermove", e => { if (orbDown && !orbDragged && Math.hypot(e.clientX-orbDown[0], e.clientY-orbDown[1]) >= 4) { orbDragged = true; window.__TAURI__.window?.getCurrentWindow().startDragging().catch(() => {}); } });
  el.orb.addEventListener("pointerup", () => { if (orbDown && !orbDragged) openCommandMenu(); orbDown = null; });
  document.addEventListener("pointerdown", e => { if (!el.slashMenu.contains(e.target) && !el.orb.contains(e.target) && e.target !== el.promptInput) closeSlashMenu(); });
  window.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCommandMenu(); } });
  let filePickerOpen = false;
  el.btnAttach.addEventListener("click", () => { filePickerOpen = true; el.attachmentInput.click(); });
  el.btnSnapshot.addEventListener("click", () => { void captureSnapshot(); });
  el.attachmentInput.addEventListener("cancel", () => { filePickerOpen = false; });
  el.attachmentInput.addEventListener("change", () => { filePickerOpen = false; addFiles(el.attachmentInput.files); el.attachmentInput.value = ""; updateIdleChips(); });
  el.promptInput.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length && addFiles(files)) e.preventDefault();
  });
  el.stage.addEventListener("dragover", (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = isBusy() ? "none" : "copy"; }
  });
  el.stage.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length && addFiles(e.dataTransfer.files)) e.preventDefault();
  });

  el.promptInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (!slashOpen() && (e.key === "ArrowUp" || e.key === "ArrowDown") && (!el.promptInput.value || recallIndex >= 0)) {
      e.preventDefault();
      recallIndex = e.key === "ArrowUp" ? Math.min(prompts.length - 1, recallIndex + 1) : Math.max(-1, recallIndex - 1);
      el.promptInput.value = recallIndex < 0 ? "" : prompts[prompts.length - 1 - recallIndex] || "";
      autoResizePrompt(); return;
    }
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
    // Leave Enter alone while a reply streams so the textarea inserts a newline.
    if (isStreaming()) return;
    e.preventDefault();
    if (!bridge.ready) return;
    submitFromInput();
  });

  el.btnSend.addEventListener("click", () => {
    if (isStreaming()) stopStreaming();
    else submitFromInput();
    el.promptInput.focus();
  });
  el.btnReasoning.addEventListener("click", showReasoningPicker);

  el.btnGuestSignin.addEventListener("click", openSignin);
  el.btnGuestDismiss.addEventListener("click", () => {
    guestDismissed = true;
    updateGuestNotice();
    el.promptInput.focus();
  });
  el.btnErrorSignin.addEventListener("click", () => {
    if (el.btnErrorSignin.dataset.action === "retry-connect") {
      hideGlobalError();
      invoke(bridge.loggedIn && !bridge.ready ? "chat_new" : "chat_status").catch(() => {});
      armConnectDeadline();
      el.promptInput.focus();
      return;
    }
    openSignin();
  });

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
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (historyOpen) { setHistoryOpen(false); return; }
      if (slashOpen()) { closeSlashMenu(); return; }
      if (!el.clearConfirm.hidden) { hideClearConfirm(); el.promptInput.focus(); return; }
      if (!isBusy() && (turns.length || !el.globalError.hidden)) {
        hideGlobalError();
        dismissExchange();
        el.promptInput.focus();
        return;
      }
      invoke("hide_main").catch(() => {});
    } else if ((e.key === "PageUp" || e.key === "PageDown") && !slashOpen()) {
      // Read from the keyboard while the cursor stays in the composer.
      const entry = historyOpen ? null : responseEntry();
      const target = historyOpen ? el.historyPanel : entry?.row.hasAttribute("data-capped") ? entry.scroller : null;
      if (!target) return;
      e.preventDefault();
      if (e.key === "PageUp") { if (entry) holdStream(entry); else historyHeld = true; }
      target.scrollBy({ top: (e.key === "PageUp" ? -0.85 : 0.85) * target.clientHeight, behavior: QSettings.motionOn ? "smooth" : "auto" });
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
      case "transcript":
        if (evt.conversationId && evt.conversationId === chats.current.conversationId) {
          if (evt.notOnPage && !chats.current.readFromPage) backfillFromPage(chats.current);
          else mergePageTranscript(chats.current, evt.messages, evt.complete === true);
        }
        break;
      case "conversations":
        receiveAccountChats(evt);
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
        if (turn?.status === "streaming" && !turn.backendDone) {
          turn.text = String(evt.text ?? "");
          paceTurn(turn);
        }
        break;
      }
      case "sources": {
        const turn = turns.find(t => t.id === evt.id && t.role === "assistant");
        if (turn) {
          turn.sources = cleanSources(evt.items);
          renderSources(turn);
          const entry = turnNodes.get(turn.id);
          if (entry) entry.renderedText = null;
          scheduleTurnRender(turn.id, true);
          if (turn.backendDone) recordPartial(turn);
          queueSizes();
        }
        break;
      }
      case "media": {
        const turn = turns.find((t) => t.id === evt.id && t.role === "assistant");
        if (turn) {
          turn.media = evt.items;
          appendMedia(turn, evt.items);
          if (turn.backendDone) recordPartial(turn);
          revealResponse(turn);
          turnNodes.get(turn.id)?.row.toggleAttribute("data-empty", false);
          queueSizes();
        }
        break;
      }
      case "activity": {
        const turn = turns.find(t => t.id === evt.id && t.role === "assistant");
        if (turn?.status === "streaming" && !turn.backendDone) {
          const labels = { search: "Searching the web…", browse: "Reading sources…", code: "Running code…", tool: "Using a tool…" };
          const kind = Object.hasOwn(labels, evt.kind) ? evt.kind : "tool";
          turn.activity = { kind, state: evt.state === "running" ? "running" : "complete", label: labels[kind] };
          if (turn.activity.state === "running") revealResponse(turn);
          scheduleTurnRender(turn.id, true);
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
        if (turn?.status === "streaming" && !turn.backendDone) {
          // An empty final snapshot means the page lost track, not that the reply was erased.
          if (typeof evt.text === "string" && (evt.text || !turn.text)) turn.text = evt.text;
          turn.rich = evt.rich === true;
          turn.backendDone = true;
          turn.activity = null;
          if (turnNodes.get(turn.id)?.activity) turnNodes.get(turn.id).activity.hidden = true;
          if (turn.chatKey === chats.current.key) {
            const chat = chats.current;
            if (typeof evt.conversationId === "string" && evt.conversationId) {
              chat.conversationId = evt.conversationId;
              page = { key: chat.key, conv: evt.conversationId, pristine: false };
            }
            backfilled.delete(chat);
            rememberTurn(turn);
            const snapshot = completedSnapshot(turn.text, turn.media?.length);
            chat.lastResponse = snapshot.text;
            chat.lastHasMedia = snapshot.hasMedia;
            chat.lastSources = cleanSources(turn.sources);
            chat.lastActive = Date.now();
            saveChats();
          }
          paceTurn(turn);
          const state = turnNodes.get(turn.id)?.reveal;
          if (state) state.deadline = Date.now() + 1200;
          if (turn.media?.length) revealResponse(turn);
          updateComposerMode();
          queueSizes();
        }
        break;
      }
      case "error": {
        const turn = evt.id ? turns.find((t) => t.id === evt.id) : null;
        if (turn?.status === "streaming" && !turn.backendDone) {
          flushReveal(turn);
          turn.status = "error";
          turn.code = evt.code;
          turn.error = formatErrorCopy(evt.code, evt.message);
          recordPartial(turn);
          revealResponse(turn);
          scheduleTurnRender(turn.id, true);
          updateComposerMode();
          if (evt.code === "auth") updateStatusHeader({ ready: true, loggedIn: false, signedOut: true });
        } else if (!turn) {
          showGlobalError(evt.code, evt.message);
          updateComposerMode();
        }
        break;
      }
    }
  });

  listen("qchat://selection", ({ payload }) => {
    if (typeof payload !== "string" || !payload) return;
    const quote = payload.replace(/\r\n?/g, "\n").split("\n").map(line => "> " + line).join("\n");
    el.promptInput.value += (el.promptInput.value ? "\n\n" : "") + quote + "\n\n";
    el.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    el.promptInput.focus();
    el.promptInput.setSelectionRange(el.promptInput.value.length, el.promptInput.value.length);
    autoResizePrompt();
  });
  listen("qchat://shown", () => {
    el.promptInput.focus();
    try { if (!localStorage.getItem("qchat.introduced")) { firstRunHint = true; updateComposerMode(); } } catch (_) {}
    refreshTheme();
    renderTabs();
    if (connectErrorShown) hideGlobalError();
    invoke("chat_status").catch(() => {});
    armConnectDeadline();
    // The first placement can use a stale size. Settle it now, not on the first click.
    lastFit = { width: 0, height: 0 };
    queueSizes();
  });

  listen("qchat://new-chat", () => startNewChat(true));
  listen("qchat://settings-closed", () => el.promptInput.focus());
  listen("qchat://settings-focus", () => { settingsFocusAt = Date.now(); clearTimeout(blurTimer); });
  listen("qchat://settings-changed", ({ payload }) => { receiveSettings(payload); refreshTheme(); });
  listen("qchat://clear-chats", () => clearRecentChats());

  window.addEventListener("storage", (e) => {
    if (e.key === QSettings.STORAGE_KEY) receiveSettings(QSettings.load());
    else if (e.key === "qchat.chats.clear") clearRecentChats();
  });

  QSettings.watchEnvironment(onSettingsApplied);
  setInterval(() => renderTabs(), 20000);

  sendWindowPrefs();
  renderTabs();
  if (hasContent(chats.current)) saveChats();
  showCachedResponse(chats.current);
  updateIdleChips();
  if (chats.current.draft) el.promptInput.value = chats.current.draft;
  autoResizePrompt();
  updateBubbleMax();
  fitNow();
  el.promptInput.focus();
  refreshTheme();
  invoke("chat_status").catch(() => {});
  armConnectDeadline();
})();
