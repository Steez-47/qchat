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
  const MOCK_SNAPSHOT_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  let mockTimer = null;

  const emitMock = (event, payload) => {
    if (event === "bridge") payload = {provider: mock.provider, ...payload};
    for (const cb of (listeners.get(event) || []).slice()) {
      try { cb({ event, payload }); } catch (e) { console.error(e); }
    }
  };

  const mock = (window.__mock = {
    provider: "chatgpt",
    autostart: params.has("autostart"),
    failProvider: params.has("failProvider"),
    providerHold: params.has("holdProvider"),
    // `nomodel` stands for a Gemini page whose mode switcher has not drawn yet.
    model: params.has("nomodel") ? undefined : "Flash-Lite",
    failModel: false,
    models: {gemini:[{id:"flash",label:"Flash-Lite",selected:true,meta:"Fast answers"},{id:"pro",label:"Pro",meta:"Advanced reasoning",disabled:true},{id:"thinking",label:"Thinking",meta:"Deeper answers"}]},
    levels: [],
    modes: {
      chatgpt: {available:true, modes:[{id:"chat",label:"Chat",selected:true},{id:"work",label:"Work",selected:false}]},
      gemini: {available:true, modes:[{id:"chat",label:"Chat",selected:true},{id:"work",label:"Task",selected:false}]}
    },
    modeUnavailable: false,
    sendError: null,
    calls: [],
    attachmentFaults: {},
    attachmentFiles: mockFiles,
    fit: null,
    fits: [],
    settingsOpen: false,
    loggedIn: params.get("mock") === "signedin",
    interval: window.__QCHAT_MOCK_INTERVAL__ || 30,
    hold: false,
    statusHold: params.get("status") === "hold",
    connectTimeout: Number(params.get("connect")) || 0,
    accountListTimeout: Number(params.get("listTimeout")) || 0,
    reply: null,
    failOpen: null,
    silentOpen: false,
    snapshotError: null,
    pageConv: null,
    conversations: 0,
    emit: emitMock,
    count: (cmd) => mock.calls.filter((c) => c.cmd === cmd).length,
    last: (cmd) => mock.calls.filter((c) => c.cmd === cmd).at(-1),
    // `?update=1.9.0` stands for a newer GitHub release; `updateFail` makes installing fail.
    update: params.get("update"),
    updateFail: params.get("updateFail"),
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
    emitMock("bridge", { type: "status", setupId: mock.setupId || null, temporary: Boolean(mock.temporary), ready: true, loggedIn: mock.loggedIn, model:mock.provider === "gemini" ? mock.model : undefined, url });
  }, delay);

  const emitModes = () => {
    const state = mock.modes[mock.provider] || mock.modes.chatgpt;
    emitMock("bridge", {
      type: "modes",
      provider: mock.provider,
      available: mock.modeUnavailable ? false : state.available !== false,
      modes: state.modes.map(mode => ({...mode}))
    });
  };

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
        if (cmd.startsWith("attachment_")) {
          const fault = mock.attachmentFaults[cmd];
          if (fault) {
            const n = fault.calls = (fault.calls || 0) + 1;
            if (fault.holdOn?.includes(n)) await new Promise(resolve => { fault.release = resolve; });
            if (fault.failOn?.includes(n)) {
              const message = fault.message || "Mock attachment failure";
              throw fault.raw ? message : new Error(message);
            }
          }
        }
        switch (cmd) {
          case "provider_get": return mock.provider;
          case "provider_set":
            if (mock.providerHold) await new Promise(resolve => { mock.releaseProvider = resolve; });
            if (mock.failProvider) throw new Error("unavailable");
            mock.provider = args.provider; if (!mock.statusHold) emitStatus(0); return;
          case "launch_info": return {autostart:mock.autostart, updated:params.get("updated")};
          case "update_check":
            if (params.has("noNightly")) return {available:false, current:"1.5.2-nightly.1", status:"no_nightly"};
            return mock.update ? {available:true, version:mock.update, current:"1.4.1", url:`https://github.com/Steez-47/qchat/releases/tag/v${mock.update}`} : {available:false, current:"1.4.1"};
          case "update_install":
            if (!mock.update) throw new Error("no_update");
            emitMock("qchat://update-progress", {received:5, total:10});
            if (mock.updateFail) throw new Error(mock.updateFail);
            return null;
          case "show_main": return;
          case "snapshot_capture": {
            if (mock.snapshotError) throw new Error(mock.snapshotError);
            return { name: "Snapshot.png", mime: "image/png", data: MOCK_SNAPSHOT_PNG };
          }
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
          case "conversation_export":
            if (mock.exportHold) await new Promise(resolve => { mock.releaseExport = resolve; });
            if (mock.exportError) throw new Error("save failed");
            return "QChat - Conversation.md";
          case "image_copy": return null;
          case "chat_models":
            if (mock.silentModels || params.get("mock") === "silent-models") return null;
            mock.effortStops ||= { labels: ["Minimal", "Light", "Medium", "High", "Extra High"], index: 1 };
            emitMock("bridge", { type: "models", effort: mock.provider === "chatgpt" && args.mode === "work" ? { label: mock.effortStops.labels[mock.effortStops.index], index: mock.effortStops.index, count: mock.effortStops.labels.length } : undefined, levels:mock.provider === "gemini" ? mock.levels : undefined, models: mock.models[mock.provider] || (params.get("mock") === "no-models" ? [] : [{ id: "0", label: "Mock model", selected: true }, { id: "1", label: "Mock alternate", selected: false }]) }); return null;
          case "chat_modes":
            emitModes(); return null;
          case "chat_mode_set": {
            const state = mock.modes[mock.provider] || mock.modes.chatgpt;
            if (mock.modeUnavailable || state.available === false) {
              emitMock("bridge", { type: "error", provider: mock.provider, code: "mode_unavailable", mode: args.mode, message: `Couldn't confirm ${mock.provider === "gemini" ? "Task mode in Gemini" : "Work mode in ChatGPT"}. Try again or open ${mock.provider === "gemini" ? "Gemini" : "ChatGPT"} to check the switch.` });
              return null;
            }
            state.modes = state.modes.map(mode => ({...mode, selected: mode.id === args.mode}));
            emitModes();
            return null;
          }
          case "chat_model_choose":
            if (mock.failModel) throw new Error("unavailable");
            if (String(args.id).startsWith("__effort:")) {
              const stops = mock.effortStops;
              stops.index = Math.max(0, Math.min(stops.labels.length - 1, stops.index + (args.id.endsWith("up") ? 1 : -1)));
              emitMock("bridge", { type: "models", models: mock.models.chatgpt || [{ id: "0", label: "Mock model", selected: true }], effort: { label: stops.labels[stops.index], index: stops.index, count: stops.labels.length } });
              return null;
            }
            if (mock.modelHold) await new Promise(resolve => { mock.releaseModel = resolve; });
            if (mock.provider === "gemini") { mock.model = mock.models.gemini.find(m=>m.id===args.id)?.label || args.id; emitMock("bridge",{type:"model-chosen",short:mock.model,model:{id:args.id,label:mock.model}}); return null; }
            emitMock("bridge", { type: "model-chosen", model: { id: args.id, label: args.id === "0" ? "Mock model" : "Mock alternate" } }); return null;
          case "chat_status":
            if (!mock.statusHold) emitStatus(15);
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

            if (mock.sendError) {
              const failure = typeof mock.sendError === "string" ? { code: mock.sendError } : mock.sendError;
              mockTimer = setTimeout(() => {
                mockTimer = null;
                emitMock("bridge", { type: "error", id, code: failure.code || "send_failed", message: failure.message || "Send failed" });
              }, 80);
              return null;
            }
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
            mock.temporary = Boolean(args.temporary);
            mock.setupId = args.setupId || null;
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
            mock.fit = { width: args.width, height: args.height, content: args.content ?? args.height };
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
