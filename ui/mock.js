// Plain-browser stand-in for the native backend. Inert inside the real app, where
// window.__TAURI__ already exists. Tests and screenshots drive it through window.__mock.
(function () {
  "use strict";
  if (typeof window.__TAURI__ !== "undefined") return;

  window.__QCHAT_MOCK__ = true;
  document.documentElement.classList.add("solid");

  const params = new URLSearchParams(window.location.search);
  const listeners = new Map();
  const mockFiles = new Map();
  const MOCK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=";
  let mockTimer = null;

  const emitMock = (event, payload) => {
    for (const cb of (listeners.get(event) || []).slice()) {
      try { cb({ event, payload }); } catch (e) { console.error(e); }
    }
  };

  const mock = (window.__mock = {
    calls: [],
    fit: null,
    fits: [],
    settingsOpen: false,
    loggedIn: params.get("mock") === "signedin",
    interval: 30,
    hold: false,
    reply: null,
    failOpen: null,
    silentOpen: false,
    pageConv: null,
    conversations: 0,
    emit: emitMock,
    count: (cmd) => mock.calls.filter((c) => c.cmd === cmd).length,
    last: (cmd) => mock.calls.filter((c) => c.cmd === cmd).at(-1),
    release: null
  });

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

  const LONG_REPLY = Array.from({ length: 26 }, (_, i) =>
    i % 7 === 3
      ? `### Part ${(i + 4) / 7}\n\nA short heading keeps long answers easy to skim.`
      : `Paragraph ${i + 1}. A long answer keeps growing until the bubble reaches its height limit, and then it scrolls on its own with a thin scrollbar while the bar stays exactly where it was.`
  ).join("\n\n");

  const clearMockStream = () => {
    if (mockTimer !== null) {
      clearInterval(mockTimer);
      clearTimeout(mockTimer);
      mockTimer = null;
    }
  };

  const emitStatus = (delay, url = "https://chatgpt.com/") => setTimeout(() => {
    emitMock("bridge", { type: "status", ready: true, loggedIn: mock.loggedIn, url });
  }, delay);

  const runStream = (id, targetText) => {
    const tokens = targetText.match(/\S+\s*/g) || [targetText];
    let idx = 0;
    let acc = "";
    const begin = () => {
      mockTimer = setInterval(() => {
        if (idx < tokens.length) {
          acc += tokens[idx++];
          emitMock("bridge", { type: "delta", id, text: acc });
        } else {
          clearMockStream();
          if (!mock.pageConv) mock.pageConv = `conv-${++mock.conversations}`;
          emitMock("bridge", { type: "done", id, text: targetText, conversationId: mock.pageConv });
        }
      }, mock.interval);
    };
    if (mock.hold) mock.release = () => { mock.release = null; begin(); };
    else begin();
  };

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        mock.calls.push({ cmd, args });
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
          case "image_copy": return null;
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
            const cleanPrompt = String(prompt || "").trim().toLowerCase();
            const mode = params.get("mock");
            const forceError = mode === "error" || cleanPrompt === "error";

            setTimeout(() => emitMock("bridge", { type: "start", id }), 10);
            if (mode === "media") setTimeout(() => emitMock("bridge", { type: "media", id, items: [{ id: "demo-raster", kind: "image", name: "Demo image.png", mime: "image/png" }, { id: "demo-file", kind: "file", name: "Demo file.txt" }] }), 40);
            for (const token of args.attachmentIds || []) mockFiles.delete(token);

            if (forceError) {
              mockTimer = setTimeout(() => {
                mockTimer = null;
                emitMock("bridge", { type: "error", id, code: cleanPrompt === "auth" ? "auth" : "rate_limited", message: "Rate limit reached" });
              }, 80);
              return null;
            }
            if (cleanPrompt === "auth") {
              mockTimer = setTimeout(() => {
                mockTimer = null;
                emitMock("bridge", { type: "error", id, code: "auth", message: "Session expired" });
              }, 80);
              return null;
            }

            const longMode = mode === "long" || cleanPrompt === "long";
            runStream(id, mock.reply || (cleanPrompt === "xss" ? XSS_REPLY : longMode ? LONG_REPLY : CANNED_REPLY));
            return null;
          }
          case "chat_stop":
            clearMockStream();
            return null;
          case "chat_new":
            clearMockStream();
            mock.pageConv = null;
            emitStatus(20);
            return null;
          case "chat_open":
            if (mock.failOpen) throw new Error(mock.failOpen);
            clearMockStream();
            mock.pageConv = args.conversationId;
            if (!mock.silentOpen) emitStatus(25, `https://chatgpt.com/c/${args.conversationId}`);
            return null;
          case "show_signin":
            mock.loggedIn = true;
            emitStatus(20);
            return null;
          case "fit_window":
            mock.fit = { width: args.width, height: args.height };
            mock.fits.push(mock.fit);
            return null;
          case "open_settings": mock.settingsOpen = true; return null;
          case "close_settings": mock.settingsOpen = false; return null;
          case "hide_main":
          case "reset_position":
          case "set_window_prefs":
          case "open_external":
          case "quit_app":
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
      },
      emit: async (eventName, payload) => { mock.calls.push({ cmd: `emit:${eventName}`, args: payload }); emitMock(eventName, payload); }
    }
  };
})();
