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

    renderer.html = (token) => escapeHtml(typeof token === "string" ? token : (token?.text ?? ""));
    renderer.image = (href, _title, text) => {
      const url = sanitizeHref(typeof href === "string" ? href : href?.href);
      const label = escapeHtml(typeof text === "string" ? text : (href?.text || "Image"));
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

  function syncMarkdownNodes(parent, next) {
    const children = Array.from(next.childNodes);
    for (let i = 0; i < children.length; i++) {
      const incoming = children[i];
      const current = parent.childNodes[i];
      if (!current) { parent.append(incoming); continue; }
      if (current.isEqualNode(incoming)) continue;
      // Rendered maths is filled in after sync; keep the node and its output
      // instead of parsing over it on every stream frame.
      if (current.nodeType === Node.ELEMENT_NODE && incoming.nodeType === Node.ELEMENT_NODE &&
          current.hasAttribute("data-qmath") && incoming.hasAttribute("data-qmath") &&
          current.getAttribute("aria-label") === incoming.getAttribute("aria-label") &&
          current.getAttribute("data-display") === incoming.getAttribute("data-display")) continue;
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
    while (parent.childNodes.length > children.length) parent.lastChild.remove();
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

  const prompts = [];
  let recallIndex = -1;
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
  let firstRunHint = false;
  let autoDismissTimer = null;
  let historyOpen = false;
  let historyChatKey = null;
  let historyHideTimer = null;
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
      if (!image && !ephemeral.test(href.trim().replace(/^</, ""))) return match;
      media = true;
      return "";
    });
    text = text.replace(/(?:qchat-media:|sandbox:|attachment:|https?:\/\/qchat-media\.localhost\/|https?:\/\/[^\s/]*oaiusercontent\.com\/)[^\s<>)]*/gi, () => {
      media = true;
      return "";
    });
    return { text: text.trim(), hasMedia: media };
  }

  function cleanTranscript(raw, lastSnapshot) {
    if (Array.isArray(raw.transcript)) return raw.transcript.filter(item => item &&
      typeof item.id === "string" && (item.role === "user" || item.role === "assistant") && typeof item.text === "string")
      .map(item => {
        const snapshot = item.role === "user" ? { text: item.text, hasMedia: Boolean(item.hasMedia) } : completedSnapshot(item.text, item.hasMedia);
        return { id: item.id, role: item.role, text: snapshot.text, hasMedia: snapshot.hasMedia, hadAttachments: Boolean(item.hadAttachments), stopped: item.role === "assistant" && Boolean(item.stopped), sources: cleanSources(item.sources) };
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
    else transcript[index] = item;
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
      else items[index] = item;
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
    const items = historyItems();
    const shown = el.zone.querySelectorAll(".turn-row:not(.leaving):not([hidden])").length;
    const moreOnPage = chats.current.conversationId && !backfilled.has(chats.current);
    el.historyControls.hidden = !historyOpen && items.length <= shown && !moreOnPage;
    if (!historyOpen) return;
    const panel = el.historyPanel;
    if (historyChatKey !== chats.current.key) {
      panel.replaceChildren();
      historyChatKey = chats.current.key;
    }
    // Hold the reader's place: follow the end only if they are already there, and
    // keep the same message on screen when older ones arrive above it.
    const fromBottom = panel.scrollHeight - panel.scrollTop;
    const atEnd = fromBottom - panel.clientHeight <= 28;
    const scrollTop = panel.scrollTop;
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
      const fingerprint = JSON.stringify([item.text, item.hasMedia, item.sources, item.stopped]);
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
      const media = row.querySelector(".turn-media");
      if (item.hasMedia && !media.childElementCount) {
        const view = make("button", "hyperlink-btn", "View attachments in ChatGPT");
        view.type = "button";
        view.dataset.action = "history-media";
        media.append(view);
      } else if (!item.hasMedia) media.replaceChildren();
    }
    while (panel.children.length > items.length) panel.lastElementChild.remove();
    if (prepended) panel.scrollTop = panel.scrollHeight - fromBottom;
    else panel.scrollTop = atEnd ? panel.scrollHeight : scrollTop;
    motion.top = panel.scrollTop;
    syncHistoryEdge();
    wakeHistoryMotion();
    queueSizes();
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
    // Without motion nothing ticks, so the reading position is held here instead.
    if (motion.pin && !QSettings.motionOn) {
      panel.scrollTop = motion.pin.row.offsetTop - panel.offsetHeight + motion.pin.fromBottom;
      motion.top = panel.scrollTop;
      motion.pin = null;
    }
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
      // Start from the space already on screen; older messages then roll in above.
      const zoneHeight = el.zone.hidden ? 0 : el.zone.offsetHeight + 8;
      const start = el.historyControls.offsetHeight + zoneHeight + 8;
      // A long reply being read keeps its text exactly where it is on screen.
      const live = responseEntry();
      const reading = live?.row.hasAttribute("data-capped")
        ? { id: live.row.dataset.id, fromBottom: live.bubble.offsetHeight + 8 + live.scroller.scrollTop } : null;
      historyOpen = true;
      el.stack.toggleAttribute("data-history", true);
      panel.hidden = false;
      panel.style.height = `${start}px`;
      renderHistory();
      panel.scrollTop = panel.scrollHeight;
      startHistoryMotion(reading);
      void panel.offsetHeight;
      clearTimeout(autoDismissTimer);
      panel.focus({ preventScroll: true });
      syncHistoryButton();
      backfillHistory(chats.current);
    } else {
      const bottom = el.stack.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom;
      historyOpen = false;
      el.stack.toggleAttribute("data-history", false);
      stopHistoryMotion();
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

  // Latest glides down through the conversation before handing back to the live bubble.
  function returnToLatest() {
    if (!historyOpen) return;
    const panel = el.historyPanel;
    const from = panel.scrollTop;
    const distance = panel.scrollHeight - panel.clientHeight - from;
    if (!QSettings.motionOn || distance < 2) { setHistoryOpen(false); return; }
    motion.pin = null;
    motion.glide = { from, start: performance.now(), duration: Math.min(620, 240 + distance / 6) };
    wakeHistoryMotion();
  }

  // The bubbles behave like they are on springs. Each lags behind the scroll in
  // proportion to its distance from the pointer, so gaps open and close (push and
  // pull), and each pops in or out as it crosses the panel's edges.
  const POP_FROM = 0.8;
  const motion = { frame: null, time: 0, top: 0, pointer: null, pin: null, glide: null, opening: null, active: new Map() };

  function wakeHistoryMotion() {
    if (motion.frame || !historyOpen || !QSettings.motionOn) return;
    motion.time = performance.now();
    motion.frame = requestAnimationFrame(tickHistoryMotion);
  }

  function clearRowMotion(row) {
    row.style.removeProperty("transform");
    row.style.removeProperty("opacity");
  }

  function stopHistoryMotion() {
    if (motion.frame) cancelAnimationFrame(motion.frame);
    motion.frame = null;
    motion.pin = motion.glide = motion.opening = null;
    // The panel fades out as it stands; only half-popped bubbles settle first.
    for (const row of motion.active.keys()) clearRowMotion(row);
    motion.active.clear();
  }

  function startHistoryMotion(reading) {
    const panel = el.historyPanel;
    const liveRow = reading ? [...panel.children].find(row => row.dataset.id === reading.id) : panel.lastElementChild;
    if (reading && liveRow) {
      motion.pin = { row: liveRow, fromBottom: reading.fromBottom, until: performance.now() + QSettings.timings.t3 + 80 };
      panel.scrollTop = liveRow.offsetTop - panel.offsetHeight + reading.fromBottom;
    }
    motion.top = panel.scrollTop;
    if (!QSettings.motionOn) return;
    motion.pointer = null;
    motion.opening = { liveRow };
    wakeHistoryMotion();
  }

  function tickHistoryMotion(now) {
    motion.frame = null;
    if (!historyOpen) return;
    if (!QSettings.motionOn) { stopHistoryMotion(); return; }
    const panel = el.historyPanel;
    const dt = Math.min(0.032, Math.max(0.001, (now - motion.time) / 1000));
    motion.time = now;
    if (motion.pin) {
      if (now > motion.pin.until) motion.pin = null;
      else { panel.scrollTop = motion.pin.row.offsetTop - panel.offsetHeight + motion.pin.fromBottom; motion.top = panel.scrollTop; }
    }
    if (motion.glide) {
      const { from, start, duration } = motion.glide;
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      panel.scrollTop = from + (panel.scrollHeight - panel.clientHeight - from) * eased;
      if (t === 1) { setHistoryOpen(false); return; }
    }
    const top = panel.scrollTop;
    const height = panel.clientHeight;
    const delta = top - motion.top;
    motion.top = top;
    const pointer = motion.pointer ?? height;

    // Rows are in document order, so the on-screen ones are a contiguous run.
    const rows = panel.children;
    let low = 0, high = rows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rows[mid].offsetTop + rows[mid].offsetHeight > top - 120) high = mid; else low = mid + 1;
    }
    const seen = [];
    for (let i = low; i < rows.length && rows[i].offsetTop - top < height + 120; i++) seen.push(rows[i]);

    let moving = Boolean(motion.pin || motion.glide);
    const opening = motion.opening;
    seen.forEach((row, index) => {
      const rowTop = row.offsetTop - top;
      const rowHeight = row.offsetHeight;
      let state = motion.active.get(row);
      if (!state) {
        const settled = opening && opening.liveRow === row;
        state = { y: 0, vy: 0, scale: settled ? 1 : POP_FROM, vs: 0, alpha: settled ? 1 : 0, shown: settled, wait: opening ? (seen.length - 1 - index) * 0.05 : 0 };
        motion.active.set(row, state);
      }
      const visible = Math.min(rowTop + rowHeight, height - 4) - Math.max(rowTop, 30);
      const need = Math.min(rowHeight * 0.4, 30);
      state.shown = visible >= (state.shown ? need * 0.4 : need);
      if (delta) {
        const centre = Math.max(rowTop, Math.min(pointer, rowTop + rowHeight));
        const reach = Math.min(1, Math.abs(centre - pointer) / height);
        state.y = Math.max(-30, Math.min(30, state.y + delta * reach * 0.24));
      }
      state.vy += (-240 * state.y - 24 * state.vy) * dt;
      state.y += state.vy * dt;
      if (state.wait > 0 && state.shown) state.wait -= dt;
      const target = state.shown && state.wait <= 0 ? 1 : POP_FROM;
      state.vs += (-320 * (state.scale - target) - 19 * state.vs) * dt;
      state.scale += state.vs * dt;
      const alphaTarget = target === 1 ? 1 : 0;
      state.alpha += (alphaTarget - state.alpha) * Math.min(1, dt * (alphaTarget ? 17 : 24));
      const resting = Math.abs(state.y) < 0.1 && Math.abs(state.vy) < 1 && Math.abs(state.scale - target) < 0.002 && Math.abs(state.vs) < 0.02 && Math.abs(state.alpha - alphaTarget) < 0.01;
      if (resting && target === 1) { state.y = state.vy = state.vs = 0; state.scale = state.alpha = 1; clearRowMotion(row); return; }
      if (!resting) moving = true;
      // A tall bubble only needs a hint of the scale to read as the same pop.
      const scale = 1 + (state.scale - 1) * Math.min(1, 220 / rowHeight);
      row.style.transform = `translate3d(0, ${state.y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
      row.style.opacity = state.alpha.toFixed(3);
    });
    const inView = new Set(seen);
    for (const row of motion.active.keys()) if (!inView.has(row)) { clearRowMotion(row); motion.active.delete(row); }
    motion.opening = null;
    if (moving) wakeHistoryMotion();
  }

  // Overscrolling at either end stretches the column, then it springs back.
  function pullHistory(event) {
    const panel = el.historyPanel;
    motion.pointer = event.clientY - panel.getBoundingClientRect().top;
    motion.pin = motion.glide = null;
    const atTop = panel.scrollTop <= 0 && event.deltaY < 0;
    const atEnd = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 1 && event.deltaY > 0;
    if (atTop || atEnd) {
      for (const [row, state] of motion.active) {
        const rowTop = row.offsetTop - panel.scrollTop;
        const reach = 0.35 + 0.65 * Math.min(1, Math.abs(rowTop + row.offsetHeight / 2 - motion.pointer) / panel.clientHeight);
        state.vy = Math.max(-340, Math.min(340, state.vy - event.deltaY * 1.5 * reach));
      }
    }
    wakeHistoryMotion();
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
    pageSync = pageSync.catch(() => {}).then(() => {
      if (chats.current === chat && page.conv !== chat.conversationId) return openInPage(chat);
    }).then(() => {
      if (chats.current !== chat) { backfilled.delete(chat); return; }
      backfillTimer = setTimeout(() => backfillFailed(chat), 20000);
      return invoke("chat_read_transcript", { conversationId: chat.conversationId });
    }).catch(() => backfillFailed(chat));
  }

  const comparable = (text) => String(text || "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

  // Adds only what comes before the oldest local prompt; local turns keep their
  // original markdown and sources. Repeat reads find nothing new to add.
  function mergePageTranscript(chat, messages) {
    if (!Array.isArray(messages)) { backfillFailed(chat); return; }
    clearTimeout(backfillTimer);
    backfillTimer = null;
    setHistoryStatus("");
    const older = cleanTranscript({ transcript: messages.map(item => ({ ...item, id: crypto.randomUUID() })) }).filter(item => item.text || item.hasMedia);
    const local = chat.transcript.filter(item => item.text || item.hasMedia);
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

  const capText = (value) => {
    const text = String(value ?? "");
    return text.length > MAX_STORED_TEXT ? `${text.slice(0, MAX_STORED_TEXT - 1)}…` : text;
  };

  function cleanChat(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key) return null;
    const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
    const time = (value) => (Number.isFinite(value) && value > 0 ? value : Date.now());
    const snapshot = completedSnapshot(text(raw.lastResponse, Infinity), raw.lastHasMedia === true);
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
        .filter((chat, i, all) => !chat.conversationId || (chat.conversationId !== current.conversationId && all.findIndex((c) => c.conversationId === chat.conversationId) === i))
        .sort((a, b) => b.lastActive - a.lastActive)
        .slice(0, MAX_RECENT);
      return { current, recent };
    } catch (_) {
      return empty;
    }
  }

  const chats = loadChats();

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
    let recent = chats.recent.map((chat, i) => i < 7 ? storedChat(chat) : { ...storedChat(chat), transcript: [], draft: "" });
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
    const chrome = el.stack.offsetHeight - (historyOpen ? el.historyPanel.offsetHeight : (el.zone.hidden ? 0 : el.zone.offsetHeight));
    const pct = QSettings.settings.maxHeightPct / 100;
    bubbleMax = Math.max(120, Math.round(pct * window.screen.availHeight) - chrome - 2 * GUTTER);
  }

  // Layout reads only; the bubble's width and height ease towards what the text needs.
  function syncBubbleSize(entry) {
    if (!entry?.bubble || entry.row.hidden || historyOpen) return;
    const capped = entry.inner.offsetHeight > bubbleMax;
    if (capped !== entry.row.hasAttribute("data-capped")) entry.row.toggleAttribute("data-capped", capped);
    const barWidth = el.stack.offsetWidth;
    const width = capped || entry.row.dataset.status === "streaming" || entry.row.hasAttribute("data-wide")
      ? barWidth : Math.min(entry.inner.offsetWidth, barWidth);
    const target = Math.min(entry.inner.offsetHeight, bubbleMax);
    entry.targetHeight = target;
    entry.bubble.style.width = `${width}px`;
    entry.bubble.style.height = `${target}px`;
    followStream(entry);
    syncHistoryButton();
  }

  function followStream(entry) {
    if (!entry.row.hasAttribute("data-capped")) {
      if (entry.jump) entry.jump.hidden = true;
      return;
    }
    if (!userScrolledUp) {
      entry.scroller.scrollTop = entry.scroller.scrollHeight;
      entry.followTop = entry.scroller.scrollTop;
    }
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
    const growing = !historyOpen && isStreaming() && entry && !entry.row.hasAttribute("data-capped");
    if (want.height > lastFit.height || want.width !== lastFit.width) {
      clearTimeout(shrinkTimer);
      shrinkTimer = null;
      // wantedSize already reserves the streaming viewport.
      const height = want.height > lastFit.height ? want.height : lastFit.height;
      sendFit(want.width, height);
    } else if (want.height < lastFit.height) {
      if (growing || shrinkTimer) return;
      // Shrink only after the exit animation, so nothing leaving gets clipped.
      shrinkTimer = setTimeout(() => {
        shrinkTimer = null;
        if (!historyOpen && isStreaming() && responseEntry()) return;
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
    const retryBtn = make("button", "tool-btn", "↻");
    retryBtn.type = "button"; retryBtn.dataset.action = "retry-reply"; retryBtn.dataset.id = turn.id;
    retryBtn.title = "Retry"; retryBtn.setAttribute("aria-label", "Retry");
    const openBtn = make("button", "tool-btn", "↗");
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
      if (entry) entry.followTop = scroller.scrollTop;
    });

    scroller.addEventListener("scroll", () => {
      syncHistoryButton();
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 28;
      const entry = turnNodes.get(turn.id);
      if (!nearBottom && !userScrolledUp && scroller.scrollTop === entry?.followTop) return;
      userScrolledUp = !nearBottom;
      jump.hidden = nearBottom || !row.hasAttribute("data-capped");
    });

    row.append(bubble, tools, jump);
    const entry = { row, bubble, scroller, inner, contentEl, errorWrap, mediaEl, generation, activity, jump, mediaItems: new Map(), targetHeight: 0 };
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
    if (entry.renderedText !== visibleText) {
      const template = document.createElement("template");
      template.innerHTML = renderMarkdownSafe(visibleText, turn.sources);
      highlightCode(template.content);
      syncMarkdownNodes(entry.contentEl, template.content);
      window.QMath?.renderInto(entry.contentEl);
      entry.renderedText = visibleText;
    }
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
    queueSizes();
  }

  function flushReveal(turn) {
    const entry = turnNodes.get(turn.id);
    cancelReveal(entry);
    if (entry?.reveal) entry.reveal.visible = turn.text;
    if (entry) finishReveal(turn, entry);
  }

  function paceTurn(turn) {
    const entry = turnNodes.get(turn.id);
    if (!entry || turn.status !== "streaming") return;
    let state = entry.reveal;
    if (!state) state = entry.reveal = { visible: "", target: "", ends: [], index: 0, last: Date.now(), credit: 0, cancel: null };
    if (state.target !== turn.text) {
      const parts = Array.from(graphemes.segment(turn.text));
      // Only unseen tails are paced. A correction to visible text (including
      // an extended final grapheme) replaces the snapshot once, without replay.
      const shown = Array.from(graphemes.segment(state.visible));
      let common = 0;
      while (common < shown.length && common < parts.length && shown[common].segment === parts[common].segment) common++;
      state.ends = parts.map(part => part.index + part.segment.length);
      state.target = turn.text;
      if (common < shown.length) {
        cancelReveal(entry);
        state.index = state.ends.length;
        state.visible = turn.text;
        state.credit = 0;
        state.last = Date.now();
        if (turn.text) revealResponse(turn);
        renderTurnNow(turn.id);
        finishReveal(turn, entry);
        return;
      }
      state.index = common;
      state.visible = turn.text.slice(0, state.ends[common - 1] || 0);
    }
    if (!QSettings.motionOn) {
      flushReveal(turn);
      if (turn.text) revealResponse(turn);
      renderTurnNow(turn.id);
      return;
    }
    if (state.cancel) return;
    if (state.index === state.ends.length) {
      renderTurnNow(turn.id);
      finishReveal(turn, entry);
      return;
    }
    const tick = () => {
      state.cancel = null;
      if (turnNodes.get(turn.id) !== entry || turn.status !== "streaming") return;
      if (!QSettings.motionOn) { flushReveal(turn); renderTurnNow(turn.id); return; }
      const now = Date.now();
      const remaining = state.ends.length - state.index;
      const seconds = turn.backendDone ? Math.max(0.04, (state.deadline - now) / 1000) : 1.5;
      const rate = Math.max(65, remaining / seconds);
      state.credit += Math.min(64, Math.max(0, now - state.last)) * rate / 1000;
      state.last = now;
      const count = Math.min(remaining, Math.floor(state.credit));
      if (count) {
        state.credit -= count;
        state.index += count;
        state.visible = state.target.slice(0, state.ends[state.index - 1] || 0);
        revealResponse(turn);
        renderTurnNow(turn.id);
      }
      if (state.index < state.ends.length) state.cancel = nextFrame(tick);
      else finishReveal(turn, entry);
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

    for (const other of turns.slice()) if (other.role === "user") retireTurn(other);
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
    const sched = renderSchedule.get(turn.id);
    sched?.cancelFrame?.();
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
    const fallback = snapshot.hasMedia || (!snapshot.text && chat.conversationId && chat.lastPrompt);
    if (!snapshot.text && !fallback) return;
    const turn = { id: cachedTurn?.id || crypto.randomUUID(), role: "assistant", text: snapshot.text, sources: cleanSources(cachedTurn ? cachedTurn.sources : chat.lastSources), status: "done", cachedMedia: Boolean(fallback), chatKey: chat.key, prompt: chat.lastPrompt, hadAttachments: cachedTurn?.hadAttachments || chat.lastHadAttachments, stopped: Boolean(cachedTurn?.stopped) };
    turns.push(turn);
    el.zone.append(createResponseRow(turn));
    const entry = turnNodes.get(turn.id);
    renderSources(turn);
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
    el.promptInput.placeholder = bridge.ready ? (firstRunHint ? "Ask anything, or type / for commands" : "Ask anything") : "Connecting…";
    el.btnSend.dataset.mode = active ? "stop" : "send";
    el.btnSend.firstElementChild.textContent = active ? GLYPH.stop : GLYPH.send;
    el.btnSend.title = active ? "Stop generating (Ctrl+.)" : `Send (${sendKey})`;
    el.btnSend.setAttribute("aria-label", active ? "Stop generating" : "Send");
    const staging = pendingFiles.some((f) => f.state === "staging");
    const attachable = pendingFiles.some((f) => f.state === "ready");
    el.btnAttach.disabled = active || sending;
    el.btnSend.disabled = !active && (!bridge.ready || sending || staging || (!el.promptInput.value.trim() && !attachable));
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
    if (isBusy() || pendingFiles.some((f) => f.state === "staging") || (!prompt && !files.length)) return;
    prompts.push(prompt); recallIndex = -1; firstRunHint = false;
    try { localStorage.setItem("qchat.introduced", "1"); } catch (_) {}
    el.promptInput.placeholder = "Ask anything";
    sending = true;
    const generation = chatGeneration;
    const chat = chats.current;
    const draft = el.promptInput.value;
    const restoreDraft = () => {
      if (fromInput && !el.promptInput.value) { el.promptInput.value = draft; autoResizePrompt(); }
    };

    hideGlobalError();
    closeSlashMenu();
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
    const nodes = chats.recent.slice(0, 3).map((chat) => {
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
  function closeFeatureList() { featureList.hidden = true; queueSizes(); el.promptInput.focus(); }
  function showFeatureList(title, rows, searchable = false) {
    closeSlashMenu();
    const keysCard = rows.some(row => row.keys);
    featureList.classList.toggle("feature-keys", keysCard);
    featureList.replaceChildren(); featureList.hidden = false;
    const field = make("input", "feature-search"); field.placeholder = "Search chats"; field.setAttribute("aria-label", "Search chats");
    if (searchable) featureList.append(field); else featureList.append(make("div", "feature-heading", title));
    const results = make("div", "feature-results"); featureList.append(results);
    let lines = [], selected = 0;
    const mark = () => lines.forEach((entry, i) => { if (i === selected) entry.line.dataset.selected = ""; else delete entry.line.dataset.selected; });
    const paint = () => {
      results.replaceChildren(); lines = []; selected = 0;
      const query = `${field.value}`.toLowerCase();
      for (const row of rows.filter(row => `${row.title} ${row.prompt || ""}`.toLowerCase().includes(query))) {
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
      if (title === "Chats" && !lines.length) results.append(make("p", "feature-heading", "No chats yet"));
    };
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
  function showChatList() {
    showFeatureList("Chats", chats.recent.map(chat => ({ title: chat.title || "Untitled chat", meta: elapsedLabel(chat.lastActive), prompt: chat.lastPrompt, run: () => switchToChat(chat.key), remove: () => { chats.recent = chats.recent.filter(c => c.key !== chat.key); saveChats(); renderTabs(); showChatList(); } })), true);
  }
  document.addEventListener("pointerdown", e => { if (!featureList.hidden && !featureList.contains(e.target)) closeFeatureList(); });
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

  function updateStatusHeader({ ready, loggedIn, signedOut }) {
    bridge.ready = Boolean(ready);
    bridge.loggedIn = Boolean(loggedIn);
    bridge.signedOut = Boolean(signedOut);
    paintStatusDot();
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
  el.historyButton.addEventListener("click", () => { if (historyOpen) returnToLatest(); else setHistoryOpen(true); });
  el.historyPanel.addEventListener("scroll", () => { syncHistoryEdge(); wakeHistoryMotion(); }, { passive: true });
  el.historyPanel.addEventListener("wheel", pullHistory, { passive: true });
  el.historyPanel.addEventListener("pointerdown", () => { motion.pin = motion.glide = null; });
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
      if (historyOpen) { returnToLatest(); return; }
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
      case "transcript":
        if (evt.conversationId && evt.conversationId === chats.current.conversationId) mergePageTranscript(chats.current, evt.messages);
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
          if (typeof evt.text === "string") turn.text = evt.text;
          turn.backendDone = true;
          turn.activity = null;
          if (turnNodes.get(turn.id)?.activity) turnNodes.get(turn.id).activity.hidden = true;
          if (turn.chatKey === chats.current.key) {
            const chat = chats.current;
            if (typeof evt.conversationId === "string" && evt.conversationId) {
              chat.conversationId = evt.conversationId;
              page = { key: chat.key, conv: evt.conversationId, pristine: false };
            }
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
