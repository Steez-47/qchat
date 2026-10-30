(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // 1. Mock Tauri Backend (installed when window.__TAURI__ is undefined)
  // ---------------------------------------------------------------------------
  if (typeof window.__TAURI__ === "undefined") {
    const listeners = new Map();
    let mockTimer = null;
    let mockLoggedIn = false;

    const emitMock = (event, payload) => {
      for (const cb of listeners.get(event) || []) {
        try { cb({ event, payload }); } catch (e) { console.error(e); }
      }
    };

    const CANNED_REPLY = [
      "QChat is connected in **instrument mode**. Responses stream directly over the bridge channel with minimal overhead.",
      "",
      "- Frameless utility grid with strict hairline rhythm",
      "- Throttled Markdown rendering (`<= 20 Hz`) with raw HTML escaping",
      "- Keyboard-first control surface (`Alt+Q`, `Ctrl+N`, `Ctrl+.`)",
      "",
      "```js",
      "async function pingBridge(id, prompt) {",
      "  return window.__TAURI__.core.invoke('chat_send', { id, prompt });",
      "}",
      "```",
      "",
      "Reference documentation is available at [OpenAI Platform Docs](https://platform.openai.com/docs)."
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

    window.__TAURI__ = {
      core: {
        invoke: async (cmd, args = {}) => {
          switch (cmd) {
            case "chat_status":
              setTimeout(() => {
                emitMock("bridge", { type: "status", ready: true, loggedIn: mockLoggedIn, url: "https://chatgpt.com/" });
              }, 15);
              return null;
            case "chat_send": {
              clearMockStream();
              const { id, prompt } = args;
              const params = new URLSearchParams(window.location.search);
              const cleanPrompt = String(prompt || "").trim().toLowerCase();
              const forceError = params.get("mock") === "error" || cleanPrompt === "error";

              setTimeout(() => emitMock("bridge", { type: "start", id }), 10);

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
              setTimeout(() => {
                emitMock("bridge", { type: "status", ready: true, loggedIn: true, url: "https://chatgpt.com/" });
              }, 20);
              return null;
            case "import_session_token": {
              const cookie = String(args.cookie || "").trim();
              if (!cookie || cookie.length < 6) {
                throw new Error("Cookie value appears empty or invalid.");
              }
              mockLoggedIn = true;
              setTimeout(() => {
                emitMock("bridge", { type: "status", ready: true, loggedIn: true, url: "https://chatgpt.com/" });
              }, 20);
              return null;
            }
            case "hide_main":
            case "open_external":
              return null;
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

  // ---------------------------------------------------------------------------
  // 2. Security & Markdown Configuration
  // ---------------------------------------------------------------------------
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

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
    renderer.image = (href, _title, text) => escapeHtml(`[${typeof text === "string" ? text : (href?.text ?? "image")}]`);

    renderer.link = (href, title, text) => {
      const rawHref = typeof href === "string" ? href : (href?.href ?? "");
      const rawTitle = typeof title === "string" ? title : (href?.title ?? "");
      const labelHtml = typeof text === "string" ? text : (href?.text ?? "");
      const safeUrl = sanitizeHref(rawHref);
      if (!safeUrl) return labelHtml;
      const titleAttr = rawTitle ? ` title="${escapeHtml(rawTitle)}"` : "";
      return `<a href="${escapeHtml(safeUrl)}"${titleAttr} rel="noopener noreferrer">${labelHtml}</a>`;
    };

    renderer.code = (code, infostring) => {
      const rawCode = typeof code === "string" ? code : (code?.text ?? "");
      const rawLang = typeof infostring === "string" ? infostring : (code?.lang ?? "");
      const cleanLang = (rawLang.trim().split(/\s+/)[0] || "code").replace(/[^a-zA-Z0-9_+-]/g, "") || "code";
      const safeLang = escapeHtml(cleanLang);
      const safeCode = escapeHtml(rawCode.replace(/\n$/, ""));
      return (
        `<div class="code-block">` +
        `<div class="code-header"><span class="code-lang">${safeLang}</span>` +
        `<button type="button" class="code-copy-btn" data-action="copy-code">Copy</button></div>` +
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
    rate_limited: "ChatGPT says you've hit a limit.",
    auth: "Session expired. Sign in again.",
    send_failed: "Failed to send prompt to ChatGPT.",
    stream_failed: "Response stream was interrupted.",
    timeout: "Request timed out. Please try again."
  };

  const formatErrorCopy = (code, fallback) =>
    (code && ERROR_MESSAGES[code]) || fallback || "An unexpected error occurred.";

  const el = {
    statusPill: document.getElementById("status-pill"),
    statusLabel: document.getElementById("status-label"),
    btnNewChat: document.getElementById("btn-new-chat"),
    btnSettings: document.getElementById("btn-settings"),
    btnHide: document.getElementById("btn-hide"),
    guestNotice: document.getElementById("guest-notice"),
    btnGuestSignin: document.getElementById("btn-guest-signin"),
    globalError: document.getElementById("global-error"),
    globalErrorText: document.getElementById("global-error-text"),
    btnErrorSignin: document.getElementById("btn-error-signin"),
    btnErrorDismiss: document.getElementById("btn-error-dismiss"),
    emptyState: document.getElementById("empty-state"),
    turnsList: document.getElementById("turns-list"),
    btnJumpLatest: document.getElementById("btn-jump-latest"),
    settingsSheet: document.getElementById("settings-sheet"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    btnSheetSignin: document.getElementById("btn-sheet-signin"),
    cookieInput: document.getElementById("cookie-input"),
    btnImportCookie: document.getElementById("btn-import-cookie"),
    cookieFeedback: document.getElementById("cookie-feedback"),
    promptInput: document.getElementById("prompt-input"),
    btnSend: document.getElementById("btn-send"),
    streamHint: document.getElementById("stream-hint")
  };

  const turns = [];
  const turnNodes = new Map();
  const renderSchedule = new Map();
  let userScrolledUp = false;
  let settingsOpen = false;

  const isStreaming = () => turns.some((t) => t.status === "streaming");

  function updateComposerMode() {
    const active = isStreaming();
    el.btnSend.dataset.mode = active ? "stop" : "send";
    el.btnSend.title = active ? "Stop streaming (Ctrl+.)" : "Send (Enter)";
    el.btnSend.setAttribute("aria-label", active ? "Stop streaming" : "Send prompt");
    el.streamHint.hidden = !active;
  }

  function updateWorkspaceVisibility() {
    const hasTurns = turns.length > 0;
    el.emptyState.hidden = hasTurns;
    el.turnsList.hidden = !hasTurns;
    if (!hasTurns) {
      userScrolledUp = false;
      el.btnJumpLatest.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Auto-scroll & Scroll Tracking
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
  // 5. Turn DOM Creation & Throttled Re-rendering (<= 20 Hz / 50ms + rAF)
  // ---------------------------------------------------------------------------
  function createTurnRow(turn) {
    const row = document.createElement("article");
    row.className = "turn-row";
    row.dataset.id = turn.id;
    row.dataset.role = turn.role;
    row.dataset.status = turn.status;

    const gutter = document.createElement("div");
    gutter.className = "turn-gutter";
    const roleWrap = document.createElement("span");
    roleWrap.className = "turn-role-wrap";

    const roleLabel = document.createElement("span");
    roleLabel.className = "turn-role-label";
    roleLabel.textContent = turn.role === "user" ? "YOU" : "GPT";
    roleWrap.appendChild(roleLabel);

    if (turn.role === "assistant") {
      const tick = document.createElement("span");
      tick.className = "turn-stream-tick";
      tick.setAttribute("aria-hidden", "true");
      roleWrap.appendChild(tick);
    }
    gutter.appendChild(roleWrap);

    const body = document.createElement("div");
    body.className = "turn-body";
    const contentEl = document.createElement("div");
    contentEl.className = "turn-content";
    body.appendChild(contentEl);

    let errorWrap = null;
    if (turn.role === "assistant") {
      const actions = document.createElement("div");
      actions.className = "turn-actions";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "turn-copy-btn";
      copyBtn.dataset.action = "copy-turn";
      copyBtn.dataset.id = turn.id;
      copyBtn.title = "Copy markdown";
      copyBtn.textContent = "Copy";
      actions.appendChild(copyBtn);
      body.appendChild(actions);

      errorWrap = document.createElement("div");
      errorWrap.className = "turn-error";
      errorWrap.hidden = true;
      body.appendChild(errorWrap);
    }

    row.appendChild(gutter);
    row.appendChild(body);

    turnNodes.set(turn.id, { row, contentEl, errorWrap });
    renderTurnNow(turn.id);
    return row;
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
        entry.errorWrap.hidden = false;
        const signinBtn = turn.code === "auth"
          ? `<button type="button" class="turn-action-btn" data-action="signin">Sign in</button>`
          : "";
        entry.errorWrap.innerHTML =
          `<span class="turn-error-msg">${escapeHtml(turn.error || "Error")}</span>` +
          `<div class="turn-error-actions">${signinBtn}` +
          `<button type="button" class="turn-action-btn" data-action="retry-turn" data-id="${escapeHtml(turn.id)}">Retry</button></div>`;
      } else if (entry.errorWrap) {
        entry.errorWrap.hidden = true;
        entry.errorWrap.innerHTML = "";
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
  // 6. Core Commands & Status Management
  // ---------------------------------------------------------------------------
  function autoResizePrompt() {
    el.promptInput.style.height = "auto";
    el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 168)}px`;
  }

  async function sendPrompt(rawPrompt) {
    const prompt = String(rawPrompt ?? "").trim();
    if (!prompt || isStreaming()) return;

    hideGlobalError();
    const userTurn = { id: crypto.randomUUID(), role: "user", text: prompt, status: "done" };
    const assistantTurn = { id: crypto.randomUUID(), role: "assistant", text: "", status: "streaming", prompt };

    turns.push(userTurn, assistantTurn);
    updateWorkspaceVisibility();
    el.turnsList.appendChild(createTurnRow(userTurn));
    el.turnsList.appendChild(createTurnRow(assistantTurn));
    updateComposerMode();
    scrollToBottom(true);

    try {
      await invoke("chat_send", { id: assistantTurn.id, prompt });
    } catch (err) {
      assistantTurn.status = "error";
      assistantTurn.code = "send_failed";
      assistantTurn.error = formatErrorCopy("send_failed", err?.message || String(err));
      scheduleTurnRender(assistantTurn.id, true);
      updateComposerMode();
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
    for (const sched of renderSchedule.values()) {
      if (sched.rafId) cancelAnimationFrame(sched.rafId);
      if (sched.timerId) clearTimeout(sched.timerId);
    }
    renderSchedule.clear();
    turnNodes.clear();
    turns.length = 0;
    el.turnsList.innerHTML = "";
    hideGlobalError();
    updateWorkspaceVisibility();
    updateComposerMode();
    if (notifyBackend) {
      try { await invoke("chat_new"); } catch (_) {}
    }
    el.promptInput.focus();
  }

  function updateStatusHeader({ ready, loggedIn, errorState, signedOut }) {
    if (signedOut) {
      el.statusPill.dataset.state = "signed-out";
      el.statusLabel.textContent = "Signed out";
      el.guestNotice.hidden = false;
    } else if (errorState) {
      el.statusPill.dataset.state = "error";
      el.statusLabel.textContent = "Error";
    } else if (!ready) {
      el.statusPill.dataset.state = "connecting";
      el.statusLabel.textContent = "Connecting…";
      el.guestNotice.hidden = true;
    } else if (loggedIn) {
      el.statusPill.dataset.state = "ready";
      el.statusLabel.textContent = "Ready";
      el.guestNotice.hidden = true;
    } else {
      el.statusPill.dataset.state = "guest";
      el.statusLabel.textContent = "Guest";
      el.guestNotice.hidden = false;
    }
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

  function setSettingsOpen(open) {
    settingsOpen = Boolean(open);
    el.settingsSheet.hidden = !settingsOpen;
    el.settingsSheet.setAttribute("aria-hidden", String(!settingsOpen));
    el.btnSettings.setAttribute("aria-expanded", String(settingsOpen));
    if (settingsOpen) {
      el.cookieFeedback.textContent = "";
      el.btnSheetSignin.focus();
    } else {
      el.promptInput.focus();
    }
  }

  async function handleImportCookie() {
    const cookie = el.cookieInput.value.trim();
    if (!cookie) {
      el.cookieFeedback.dataset.type = "error";
      el.cookieFeedback.textContent = "Paste a session cookie first.";
      return;
    }
    el.btnImportCookie.disabled = true;
    el.cookieFeedback.dataset.type = "";
    el.cookieFeedback.textContent = "Importing…";
    try {
      await invoke("import_session_token", { cookie });
      el.cookieInput.value = "";
      el.cookieFeedback.dataset.type = "success";
      el.cookieFeedback.textContent = "Session cookie imported.";
      await invoke("chat_status");
    } catch (err) {
      el.cookieFeedback.dataset.type = "error";
      el.cookieFeedback.textContent = err?.message || String(err) || "Import failed.";
    } finally {
      el.btnImportCookie.disabled = false;
    }
  }

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
    if (buttonEl) {
      const prev = buttonEl.textContent;
      buttonEl.textContent = "Copied";
      setTimeout(() => { buttonEl.textContent = prev; }, 1100);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Event Wiring & Bridge Listener
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
      if (turn && turn.prompt && !isStreaming()) sendPrompt(turn.prompt);
    } else if (action === "signin") {
      invoke("show_signin").catch(() => {});
    }
  });

  el.promptInput.addEventListener("input", autoResizePrompt);
  el.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!isStreaming() && el.promptInput.value.trim()) {
        const text = el.promptInput.value;
        el.promptInput.value = "";
        autoResizePrompt();
        sendPrompt(text);
      }
    }
  });

  el.btnSend.addEventListener("click", () => {
    if (isStreaming()) {
      stopStreaming();
    } else if (el.promptInput.value.trim()) {
      const text = el.promptInput.value;
      el.promptInput.value = "";
      autoResizePrompt();
      sendPrompt(text);
    }
  });

  el.btnNewChat.addEventListener("click", () => startNewChat(true));
  el.btnSettings.addEventListener("click", () => setSettingsOpen(!settingsOpen));
  el.btnCloseSettings.addEventListener("click", () => setSettingsOpen(false));
  el.btnHide.addEventListener("click", () => invoke("hide_main").catch(() => {}));
  el.btnGuestSignin.addEventListener("click", () => invoke("show_signin").catch(() => {}));
  el.btnErrorSignin.addEventListener("click", () => invoke("show_signin").catch(() => {}));
  el.btnErrorDismiss.addEventListener("click", hideGlobalError);
  el.btnSheetSignin.addEventListener("click", () => invoke("show_signin").catch(() => {}));
  el.btnImportCookie.addEventListener("click", handleImportCookie);

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
    invoke("chat_status").catch(() => {});
  });

  listen("qchat://new-chat", () => startNewChat(true));

  el.promptInput.focus();
  invoke("chat_status").catch(() => {});
})();
