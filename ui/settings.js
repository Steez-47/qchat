// Settings window. Every change is saved, applied here, and relayed live to the chat window.
//
// The whole layout is declared once in PAGES below: pages sit in nav groups, each page has a short
// description, titled groups of rows, and an optional "Fine-tune" list for rarely changed controls.
// One page shows at a time; search looks across every page.
(function () {
  "use strict";

  const invoke = (cmd, args) => (window.__TAURI__?.core?.invoke ? window.__TAURI__.core.invoke(cmd, args) : Promise.reject(new Error("Available in the desktop app")));
  const listen = (event, cb) => window.__TAURI__?.event?.listen(event, cb);
  const emit = (event, payload) => window.__TAURI__?.event?.emit(event, payload);
  const { SCHEMA, DEFAULTS, LOOKS } = QSettings;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);
  const PAGE_KEY = "qchat.settings.page";

  let settings = QSettings.load();
  QSettings.apply(root, settings);

  const GLYPH = { reset: "" };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (glyph) => {
    const span = make("span", "icon", glyph);
    span.setAttribute("aria-hidden", "true");
    return span;
  };

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------
  const refreshers = new Map();
  let relayQueued = false;
  let afterChange = () => {};

  function relay() {
    relayQueued = false;
    emit("qchat://settings-changed", settings);
  }

  function setValue(key, value) {
    settings = { ...settings, [key]: QSettings.sanitizeValue(key, value) };
    settings = QSettings.save(settings);
    QSettings.apply(root, settings);
    refreshers.get(key)?.();
    afterChange();
    if (!relayQueued) {
      relayQueued = true;
      requestAnimationFrame(relay);
      setTimeout(() => { if (relayQueued) relay(); }, 120);
    }
  }

  function setAll(next) {
    settings = QSettings.save(next);
    QSettings.apply(root, settings);
    for (const refresh of refreshers.values()) refresh();
    afterChange();
    relay();
  }

  // ---------------------------------------------------------------------------
  // Value formats and option labels
  // ---------------------------------------------------------------------------
  const seconds = (value) => (value ? `${value} s` : "Off");
  const times = (value) => `${value.toFixed(1)}×`;
  const decimals = (value) => value.toFixed(2);
  const lines = (value) => (value ? String(value) : "All");

  // Readable names for every choice. Anything missing falls back to the capitalised value.
  const OPTION_LABELS = {
    codeFont: { cascadia: "Cascadia", consolas: "Consolas", system: "System", courier: "Courier" },
    userAlign: { right: "Right", left: "Left" },
    linkStyle: { underline: "Underline", color: "Colour", bold: "Bold" },
    quoteStyle: { fill: "Shaded", plain: "Plain", italic: "Italic" },
    enterStyle: { rise: "Rise", fade: "Fade", scale: "Grow", none: "None" },
    tabStyle: { attached: "Attached", floating: "Floating", text: "Text only" },
    orbStyle: { gradient: "Gradient", solid: "Solid", ring: "Ring", hidden: "Hidden" },
    sendStyle: { accent: "Accent", quiet: "Quiet" },
    scrollbarStyle: { thin: "Thin", wide: "Wide", hidden: "Hidden" },
    tintSource: { look: "From theme", custom: "Custom" },
    accentSource: { look: "From theme", system: "Windows", custom: "Custom" },
    animations: { auto: "Auto", on: "On", off: "Off" },
    feel: { calm: "Calm", smooth: "Smooth", springy: "Springy", snappy: "Snappy" },
    fontFamily: { segoe: "Segoe", system: "System", serif: "Serif", rounded: "Soft", mono: "Mono" },
    density: { compact: "Compact", cozy: "Cozy", roomy: "Roomy" },
    sendKey: { enter: "Enter", ctrl: "Ctrl+Enter" },
    defaultProvider: { chatgpt: "ChatGPT", gemini: "Gemini" },
    defaultReasoning: { low: "Low", medium: "Medium", high: "High" }
  };
  const optionsFor = (key) => SCHEMA[key].options.map((v) => [v, OPTION_LABELS[key]?.[v] ?? v.charAt(0).toUpperCase() + v.slice(1)]);

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function resetButton(key, label) {
    const button = make("button", "row-reset");
    button.type = "button";
    button.title = `Reset ${label} to default`;
    button.setAttribute("aria-label", button.title);
    button.append(icon(GLYPH.reset));
    button.addEventListener("click", () => setValue(key, DEFAULTS[key]));
    return button;
  }

  const textBlock = (label, hint) => {
    const text = make("div", "row-text");
    text.append(make("span", "row-label", label));
    if (hint) text.append(make("span", "row-hint", hint));
    return text;
  };

  function formatValue(spec, value, format) {
    if (format) return format(value);
    return `${Number(Number(value).toFixed(3))}${spec.unit}`;
  }

  const markChanged = (row, key) => row.toggleAttribute("data-changed", settings[key] !== DEFAULTS[key]);

  function rangeRow({ key, label, hint, format }) {
    const spec = SCHEMA[key];
    const row = make("div", "row row-range");
    row.dataset.key = key;
    const text = make("div", "row-text");
    const id = `control-${key}`;
    const name = make("label", "row-label", label);
    name.htmlFor = id;
    const value = make("output", "value");
    value.htmlFor = id;
    text.append(name, value);
    if (hint) text.append(make("span", "row-hint", hint));
    const input = make("input");
    input.type = "range";
    input.id = id;
    input.min = spec.min; input.max = spec.max; input.step = spec.step;
    input.addEventListener("input", () => setValue(key, Number(input.value)));
    row.append(text, resetButton(key, label), input);
    refreshers.set(key, () => {
      input.value = settings[key];
      input.style.setProperty("--pct", `${((settings[key] - spec.min) / (spec.max - spec.min)) * 100}%`);
      value.textContent = formatValue(spec, settings[key], format);
      input.setAttribute("aria-valuetext", value.textContent);
      markChanged(row, key);
    });
    return row;
  }

  function arrowNavigate(group, buttons, select) {
    group.addEventListener("keydown", (e) => {
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % buttons.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = buttons.length - 1;
      if (next < 0) return;
      e.preventDefault();
      for (const button of buttons) button.tabIndex = -1;
      buttons[next].tabIndex = 0;
      buttons[next].focus();
      select(buttons[next]);
    });
  }

  function choiceRow({ key, label, hint }) {
    const row = make("div", "row row-choice");
    row.dataset.key = key;
    const group = make("div", "segmented");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    const buttons = optionsFor(key).map(([value, text]) => {
      const button = make("button", "", text);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.value = value;
      button.addEventListener("click", () => setValue(key, value));
      return button;
    });
    group.append(...buttons);
    arrowNavigate(group, buttons, (button) => setValue(key, button.dataset.value));
    const control = make("div", "row-control");
    control.append(group);
    row.append(textBlock(label, hint), control, resetButton(key, label));
    refreshers.set(key, () => {
      for (const button of buttons) {
        const on = button.dataset.value === settings[key];
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
      }
      markChanged(row, key);
    });
    return row;
  }

  function switchRow({ key, label, hint }) {
    const row = make("div", "row");
    row.dataset.key = key;
    const button = make("button", "switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => setValue(key, !settings[key]));
    const control = make("div", "row-control");
    control.append(button);
    row.append(textBlock(label, hint), control, resetButton(key, label));
    refreshers.set(key, () => {
      button.setAttribute("aria-checked", String(settings[key]));
      markChanged(row, key);
    });
    return row;
  }

  function colorRow({ key, label, hint }) {
    const row = make("div", "row");
    row.dataset.key = key;
    const input = make("input");
    input.type = "color";
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => setValue(key, input.value));
    const control = make("div", "row-control");
    control.append(input);
    row.append(textBlock(label, hint), control, resetButton(key, label));
    refreshers.set(key, () => {
      input.value = settings[key].toLowerCase();
      markChanged(row, key);
    });
    return row;
  }

  function textRow({ key, label, hint }) {
    const row = make("div", "row");
    row.dataset.key = key;
    const input = make("input", "text-input");
    input.type = "text";
    input.maxLength = SCHEMA[key].max;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => setValue(key, input.value));
    const control = make("div", "row-control");
    control.append(input);
    row.append(textBlock(label, hint), control, resetButton(key, label));
    refreshers.set(key, () => {
      if (document.activeElement !== input) input.value = settings[key];
      markChanged(row, key);
    });
    return row;
  }

  // A row for a schema key, built from its type. `S("key", "Label", "Hint", format)`.
  const BUILDERS = { range: rangeRow, bool: switchRow, enum: choiceRow, color: colorRow, text: textRow };
  const S = (key, label, hint, format) => () => BUILDERS[SCHEMA[key].type]({ key, label, hint, format });

  function actionRow(title, note, button) {
    const row = make("div", "action-row");
    const text = make("div", "action-text");
    text.append(make("span", "", title));
    if (note) text.append(note instanceof Node ? note : make("small", "", note));
    row.append(text, button);
    return row;
  }
  function actionButton(id, label, onClick, className = "pill-btn") {
    const button = make("button", className, label);
    button.type = "button";
    if (id) button.id = id;
    button.addEventListener("click", onClick);
    return button;
  }

  // ---------------------------------------------------------------------------
  // Special rows
  // ---------------------------------------------------------------------------
  function lookPicker() {
    const grid = make("div", "look-grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "Colour theme");
    const buttons = Object.entries(LOOKS).map(([key, look]) => {
      const button = make("button", "look-swatch");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.look = key;
      const orb = make("span", "swatch-orb");
      const swatch = QSettings.swatch(key);
      orb.style.background = `linear-gradient(135deg, ${swatch.tint[0]} 0%, ${swatch.tint[1]} 40%, ${swatch.orb[1]} 78%, ${swatch.orb[2]} 100%)`;
      button.append(orb, make("span", "", look.label));
      button.addEventListener("click", () => setValue("look", key));
      return button;
    });
    grid.append(...buttons);
    arrowNavigate(grid, buttons, (button) => setValue("look", button.dataset.look));
    refreshers.set("look", () => {
      for (const button of buttons) {
        const on = button.dataset.look === settings.look;
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
      }
    });
    return grid;
  }

  let refreshPresets = () => {};
  let reapplySearch = () => {};
  function presetGallery() {
    const wrap = make("div", "preset-area");
    const current = make("p", "preset-current");
    const status = make("strong", "", "");
    status.id = "preset-status";
    current.append(document.createTextNode("In use: "), status);
    const gallery = make("div", "preset-gallery");
    wrap.append(current, gallery);
    refreshPresets = () => {
      gallery.replaceChildren();
      let active = "Custom";
      for (const p of [...QSettings.PRESETS, ...QSettings.listPresets()]) {
        const target = QSettings.applyPreset(settings, p.id);
        const on = QSettings.APPEARANCE_KEYS.every((k) => target[k] === settings[k]);
        if (on) active = p.label;
        const card = make("div", "preset-entry");
        const button = make("button", "preset-card");
        button.type = "button";
        button.dataset.preset = p.id;
        button.setAttribute("aria-pressed", String(on));
        const swatch = make("span", "preset-swatch");
        const colours = QSettings.swatch(target.look);
        swatch.style.background = `linear-gradient(135deg, ${colours.tint[0]} 0 45%, ${colours.orb[1]} 100%)`;
        swatch.style.borderRadius = `${Math.round(3 + target.cornerWeight / 10)}px`;
        button.append(swatch, make("strong", "", p.label), make("small", "", p.blurb || "Your preset"));
        button.addEventListener("click", () => setAll(QSettings.applyPreset(settings, p.id)));
        card.append(button);
        if (p.id.startsWith("user-")) {
          const remove = actionButton("delete-" + p.id, "", () => { QSettings.deletePreset(p.id); refreshPresets(); }, "preset-delete");
          remove.title = `Delete ${p.label}`;
          remove.setAttribute("aria-label", remove.title);
          remove.append(icon(""));
          card.append(remove);
        }
        gallery.append(card);
      }
      status.textContent = active;
      reapplySearch();
    };
    refreshPresets();
    return wrap;
  }

  function presetManager() {
    const box = make("div", "preset-manage");
    const notice = make("p", "row-hint preset-notice");
    notice.setAttribute("role", "status");

    const saveLine = make("div", "inline-form");
    const name = make("input", "text-input");
    name.placeholder = "Name this look";
    name.maxLength = 60;
    name.setAttribute("aria-label", "Preset name");
    const save = actionButton("preset-save", "Save as preset", () => {
      const saved = QSettings.savePreset(name.value, settings);
      notice.textContent = saved ? `Saved “${saved.label}”` : "Type a name first (up to 40 presets)";
      if (saved) name.value = "";
      refreshPresets();
    }, "pill-btn pill-accent");
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); });
    saveLine.append(name, save);

    const transfer = make("textarea", "preset-transfer");
    transfer.setAttribute("aria-label", "Preset JSON");
    transfer.placeholder = "Paste a preset here to import it, or press Copy to share yours";
    transfer.rows = 3;
    const transferLine = make("div", "inline-form");
    transferLine.append(
      actionButton("preset-export", "Copy current look", async () => {
        transfer.value = JSON.stringify({ label: name.value.trim() || "My preset", values: Object.fromEntries(QSettings.APPEARANCE_KEYS.map((k) => [k, settings[k]])) });
        try { await navigator.clipboard.writeText(transfer.value); notice.textContent = "Copied to the clipboard"; }
        catch (_) { notice.textContent = "Copy the text above"; }
      }),
      actionButton("preset-import", "Import", () => {
        notice.textContent = QSettings.importPreset(transfer.value) ? "Preset imported" : "That isn't a valid preset, or the list is full";
        refreshPresets();
      })
    );
    box.append(saveLine, transfer, transferLine, notice);
    return box;
  }

  const accountStatus = make("small", "", "Not connected yet");
  accountStatus.id = "account-status";
  accountStatus.dataset.state = "connecting";
  const accountButton = actionButton("btn-signin", "Sign in", () => invoke("show_signin", { provider: "chatgpt" }).catch(() => {}), "pill-btn pill-accent");
  const geminiStatus = make("small", "", "Not connected yet");
  geminiStatus.id = "gemini-account-status";
  const geminiButton = actionButton("btn-signin-gemini", "Sign in", () => invoke("show_signin", { provider: "gemini" }).catch(() => {}));

  const CLEAR_LABEL = "Clear recent chats";
  const clearButton = actionButton("btn-clear-chats", CLEAR_LABEL, () => {
    if (clearButton.dataset.armed) {
      delete clearButton.dataset.armed;
      clearButton.textContent = "Cleared";
      clearButton.disabled = true;
      localStorage.setItem("qchat.chats.clear", String(Date.now()));
      emit("qchat://clear-chats", null);
      setTimeout(() => { clearButton.textContent = CLEAR_LABEL; clearButton.disabled = false; }, 1600);
    } else {
      clearButton.dataset.armed = "true";
      clearButton.textContent = "Click again to clear";
      setTimeout(() => {
        if (clearButton.dataset.armed) { delete clearButton.dataset.armed; clearButton.textContent = CLEAR_LABEL; }
      }, 3000);
    }
  }, "pill-btn pill-danger");

  let autostartEnabled = false;
  function desktopControl(kind) {
    const isHotkey = kind === "hotkey" || kind === "selection";
    const command = kind === "selection" ? "selection_hotkey" : "hotkey";
    const button = make("button", "pill-btn", "Loading…");
    button.type = "button";
    const defaultHint = { hotkey: "Shows or hides QChat from any app", selection: "Asks about the text you've selected in any app. Backspace clears it", autostart: "Starts quietly in the tray" }[kind];
    const hint = make("small", "", defaultHint);
    if (!isHotkey) invoke("get_hotkey").then((key) => { if (key) hint.textContent = `Starts quietly in the tray. ${key} opens it`; }).catch(() => {});
    const row = actionRow({ hotkey: "Global shortcut", selection: "Ask about selection", autostart: "Open at startup" }[kind], hint, button);
    row.classList.add("desktop-row");
    let current = isHotkey ? "Record shortcut" : false;
    const sync = () => {
      if (!isHotkey) { autostartEnabled = current; syncDependents(); }
      button.textContent = isHotkey ? (current || "Not set") : current ? "On" : "Off";
      if (!isHotkey) button.setAttribute("aria-checked", String(current));
    };
    if (isHotkey) button.title = "Click, then press the new key combination";
    else { button.setAttribute("role", "switch"); button.setAttribute("aria-label", "Open at startup"); }
    invoke(isHotkey ? "get_" + command : "get_autostart")
      .then((v) => { if (isHotkey ? typeof v === "string" : typeof v === "boolean") current = v; sync(); })
      .catch(() => { sync(); hint.textContent = "Available in the desktop app"; });
    if (isHotkey) invoke("get_" + command + "_available").then((available) => { if (!available) hint.textContent = "Shortcut unavailable"; }).catch(() => {});
    const stopRecording = () => { delete button.dataset.recording; sync(); };
    button.addEventListener("click", async () => {
      if (isHotkey) { button.dataset.recording = "true"; button.textContent = "Press keys… (Esc cancels)"; return; }
      try { await invoke("set_autostart", { enabled: !current }); current = !current; sync(); } catch (e) { hint.textContent = String(e.message || e); }
    });
    button.addEventListener("blur", () => { if (button.dataset.recording) stopRecording(); });
    button.addEventListener("keydown", async (e) => {
      if (!button.dataset.recording) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { stopRecording(); return; }
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      if (kind === "selection" && e.key === "Backspace") {
        await invoke("set_selection_hotkey", { accelerator: "" });
        current = "";
        stopRecording();
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hint.textContent = "Include Ctrl, Alt or Windows"; return; }
      const accelerator = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
      try { await invoke("set_" + command, { accelerator }); current = accelerator; hint.textContent = defaultHint; stopRecording(); }
      catch (err) { hint.textContent = String(err.message || err); }
    });
    return row;
  }

  const shortcut = (name, ...keys) => {
    const row = make("div", "shortcut");
    const dd = make("dd");
    dd.append(...keys.map((k) => make("kbd", "", k)));
    row.append(make("dt", "", name), dd);
    return row;
  };
  function shortcutList() {
    const list = make("dl", "shortcut-list");
    list.append(
      shortcut("Commands menu", "Ctrl", "K"),
      shortcut("Commands", "/"),
      shortcut("All chats", "Ctrl", "P"),
      shortcut("New chat", "Ctrl", "N"),
      shortcut("Stop generating", "Ctrl", "."),
      shortcut("New line in a message", "Shift", "Enter"),
      shortcut("Dismiss a reply, then hide", "Esc")
    );
    return list;
  }

  function aboutText() {
    const line = make("p", "about-line");
    line.append(make("strong", "", "QChat"), document.createTextNode(" keeps your AI chats one shortcut away, using your own signed-in ChatGPT and Gemini sessions. Type /settings in the bar to come back here."));
    return line;
  }

  // ---------------------------------------------------------------------------
  // Layout. Every schema key except look (the theme grid) and the retired streaming
  // choices (streamStyle, streamSpeed) appears exactly once.
  // ---------------------------------------------------------------------------
  const NAV = [
    { title: "Basics", pages: ["general", "window", "shortcuts"] },
    { title: "Look & feel", pages: ["presets", "colours", "glass", "text", "bar", "chat", "motion"] },
    { title: "Account", pages: ["accounts", "privacy", "about"] }
  ];

  const PAGES = {
    general: {
      title: "General", glyph: "",
      about: "How new chats start and how QChat launches.",
      groups: [
        { title: "New chats", rows: [
          S("defaultProvider", "Assistant", "Which service a new session uses"),
          S("defaultReasoning", "Reasoning effort", "Where new chats start. Change it per chat in the composer"),
          S("sendKey", "Send with", "The other key combination adds a new line")
        ] },
        { title: "Startup", rows: [
          () => desktopControl("autostart"),
          S("showBarAtStartup", "Show the bar at startup", "Otherwise QChat waits in the tray until you call it"),
          S("checkUpdates", "Check GitHub for updates", "Show an update button when a newer release is available")
        ] }
      ]
    },
    window: {
      title: "Window", glyph: "",
      about: "Where the bar sits and when it tucks itself away.",
      groups: [
        { title: "Staying out of the way", rows: [
          S("alwaysOnTop", "Always on top", "Keep QChat above other windows"),
          S("idleCollapse", "Fold into the orb when idle", "Seconds after you click away. Click the orb to open it again", seconds),
          S("hideOnBlur", "Hide when you click away", "Hides QChat completely instead of folding it"),
          S("autoDismiss", "Clear replies automatically", "Seconds after a reply finishes, unless you're reading it", seconds)
        ] },
        { title: "Position", rows: [
          S("rememberPosition", "Remember where I put it", "Reopen the bar where you last dragged it"),
          () => actionRow("Reset position", "Puts the bar back at the bottom centre of your screen", actionButton("btn-reset-position", "Reset", () => invoke("reset_position").catch(() => {})))
        ] }
      ]
    },
    shortcuts: {
      title: "Shortcuts", glyph: "",
      about: "Keys that work anywhere in Windows, and the ones inside QChat.",
      groups: [
        { title: "Anywhere in Windows", note: "Click a shortcut, then press the new combination.", rows: [
          () => desktopControl("hotkey"),
          () => desktopControl("selection"),
          S("selectionClipboard", "Copy the selection if needed", "Some apps only share selected text by copying it. QChat restores your clipboard afterwards when it can")
        ] },
        { title: "Inside QChat", rows: [shortcutList] }
      ]
    },
    presets: {
      title: "Presets", glyph: "",
      about: "Ready-made looks. Picking one changes appearance only, never behaviour.",
      groups: [
        { rows: [presetGallery] }
      ],
      extra: { summary: "Save, import or export", rows: [presetManager] }
    },
    colours: {
      title: "Colours", glyph: "",
      about: "The theme sets the glass, text and accent colours together.",
      groups: [
        { title: "Theme", rows: [lookPicker] },
        { title: "Accent", rows: [
          S("accentSource", "Accent colour", "Used for the send button, links and focus"),
          S("accentColor", "Custom accent")
        ] }
      ],
      fineTune: [
        S("tintSource", "Glass colour", "Use the theme's tint or pick your own"),
        S("tintColor", "Custom glass colour", "Text switches between light and dark to match"),
        S("bubbleTint", "Your message tint", "How much accent colour your own messages carry"),
        S("saturation", "Colour saturation", "Mutes or boosts every theme colour"),
        S("inkBoost", "Quiet text contrast", "Makes hints and timestamps sharper")
      ]
    },
    glass: {
      title: "Glass & shape", nav: "Glass", glyph: "",
      about: "How see-through things are, and how round.",
      groups: [
        { title: "Bar", rows: [
          S("glassOpacity", "Bar opacity", "Lower lets more of the desktop show through"),
          S("nativeBlur", "Blur behind the bar", "Frosts the desktop behind the bar, tabs and menus"),
          S("blur", "Bar blur strength")
        ] },
        { title: "Replies", rows: [
          S("replyOpacity", "Reply opacity", "Fill behind messages"),
          S("readableGuard", "Keep text readable", "Raises opacity if the text would get hard to read"),
          S("replyNativeBlur", "Blur behind replies", "Frosts the desktop behind messages"),
          S("replyBlur", "Reply blur strength")
        ] },
        { title: "Corners", rows: [
          S("cornerWeight", "Bar roundness"),
          S("replyCorners", "Reply roundness")
        ] }
      ],
      fineTune: [
        S("rim", "Edge light", "Brightness of the thin outline"),
        S("sheen", "Top highlight", "The light line along each top edge"),
        S("shadow", "Shadow"),
        S("border", "Bar outline width"),
        S("replyBorder", "Reply outline width")
      ]
    },
    text: {
      title: "Text", glyph: "",
      about: "How replies read.",
      groups: [
        { title: "Body", rows: [
          S("textSize", "Text size"),
          S("fontFamily", "Font"),
          S("lineHeight", "Line spacing", null, decimals)
        ] },
        { title: "Formatting", rows: [
          S("linkStyle", "Links"),
          S("quoteStyle", "Quotes"),
          S("codeFont", "Code font"),
          S("codeWrap", "Wrap code", "Fit long lines inside the reply instead of scrolling sideways")
        ] }
      ],
      fineTune: [
        S("paragraphSpacing", "Paragraph spacing"),
        S("letterSpacing", "Letter spacing"),
        S("replyWeight", "Text weight", "400 is regular"),
        S("headingScale", "Heading size", "Relative to body text"),
        S("codeSize", "Code size", "Relative to body text"),
        S("justify", "Justify text", "Straight right edges on paragraphs")
      ]
    },
    bar: {
      title: "Bar & tabs", glyph: "",
      about: "The bar you type in and the recent-chat tabs on top of it.",
      groups: [
        { title: "Bar", rows: [
          S("barWidth", "Width"),
          S("density", "Size"),
          S("placeholderText", "Placeholder", "Shown in the empty bar"),
          S("showAttach", "Attach button", "The paperclip for files and images"),
          S("sendStyle", "Send button"),
          S("orbStyle", "Orb", "The round mark at the left of the bar"),
          S("showStatusDot", "Connection ring on the orb", "Amber while connecting, red on errors"),
          S("showSuggestions", "Suggestions in an empty chat", "Prompt ideas above an empty bar")
        ] },
        { title: "Recent-chat tabs", rows: [
          S("showTabs", "Show tabs", "Quick tabs for your latest chats"),
          S("tabCount", "How many tabs"),
          S("tabStyle", "Tab style"),
          S("showTabClock", "Clock icon on tabs")
        ] }
      ]
    },
    chat: {
      title: "Chat", glyph: "",
      about: "The reply column above the bar.",
      groups: [
        { title: "Size", rows: [
          S("replyWidth", "Reply width", "Separate from the bar width"),
          S("maxHeightPct", "Maximum height", "Share of your screen height. Longer replies scroll")
        ] },
        { title: "Your messages", rows: [
          S("userAlign", "Alignment"),
          S("userLines", "Lines to show", "Longer messages are trimmed. All shows everything", lines),
          S("showPrompt", "Keep my message above the reply", "Otherwise it gives way once the reply starts")
        ] }
      ],
      fineTune: [
        S("replyPadding", "Reply padding", "Space inside each reply"),
        S("bubbleGap", "Spacing", "Gap between bubbles, tabs and the bar"),
        S("scrollbarStyle", "Scrollbar"),
        S("softEdges", "Fade scrolled edges", "Softens text cut off at the top and bottom")
      ]
    },
    motion: {
      title: "Motion & streaming", nav: "Motion", glyph: "",
      about: "Animation, and how replies arrive while they're being written.",
      groups: [
        { title: "Animation", rows: [
          S("animations", "Animations", "Auto follows your Windows setting"),
          S("feel", "Feel"),
          S("speed", "Speed", null, times),
          S("enterStyle", "Reply entrance", "How a new reply appears")
        ] },
        { title: "Streaming", rows: [
          S("followStream", "Follow new text", "Scroll along as the reply grows. Scrolling up always stops it"),
          S("streamCaret", "Typing cursor", "A caret at the end while the reply is written"),
          S("shimmer", "Shimmer while writing", "A soft light across the reply while it streams")
        ] }
      ],
      fineTune: [
        S("riseDistance", "Rise distance", "How far a sent message travels"),
        S("tabPop", "Tabs pop out of the bar")
      ]
    },
    accounts: {
      title: "Accounts", glyph: "",
      about: "QChat uses your own signed-in sessions. Your password never passes through QChat.",
      groups: [
        { rows: [
          () => actionRow("ChatGPT", accountStatus, accountButton),
          () => actionRow("Gemini", geminiStatus, geminiButton)
        ] }
      ]
    },
    privacy: {
      title: "Chats & privacy", nav: "Privacy", glyph: "",
      about: "Recent chats are stored only on this PC. Nothing here is uploaded by QChat.",
      groups: [
        { rows: [
          S("keepHistory", "Keep recent chats", "Off stores nothing and hides the tabs"),
          () => actionRow("Recent chats", "Removes the tabs and their saved replies", clearButton)
        ] }
      ]
    },
    about: {
      title: "About", glyph: "",
      groups: [
        { rows: [aboutText] },
        { rows: [() => actionRow("Quit QChat", "Closes the app and its tray icon", actionButton("btn-quit", "Quit", () => invoke("quit_app").catch(() => {})))] }
      ]
    }
  };

  // ---------------------------------------------------------------------------
  // Build
  // ---------------------------------------------------------------------------
  const scrollEl = $("section-scroll");
  const nav = $("section-nav");
  const links = new Map();
  const pages = [];

  function buildRows(container, rows) {
    for (const build of rows) container.append(build());
  }

  for (const navGroup of NAV) {
    const heading = make("div", "nav-heading", navGroup.title);
    heading.setAttribute("aria-hidden", "true");
    nav.append(heading);
    for (const id of navGroup.pages) {
      const page = PAGES[id];
      const node = make("section", "section");
      node.id = `section-${id}`;
      node.setAttribute("aria-labelledby", `heading-${id}`);

      const head = make("div", "section-head");
      const heading = make("h2", "section-title", page.title);
      heading.id = `heading-${id}`;
      head.append(heading);
      node.append(head);
      if (page.about) node.append(make("p", "section-note", page.about));

      for (const group of page.groups) {
        const block = make("div", "group-block");
        if (group.title) block.append(make("h3", "group-title", group.title));
        if (group.note) block.append(make("p", "group-note", group.note));
        const box = make("div", "group");
        buildRows(box, group.rows);
        block.append(box);
        node.append(block);
      }

      const more = page.fineTune ? { summary: "Fine-tune", rows: page.fineTune } : page.extra;
      if (more) {
        const detail = make("details", "fine-tune");
        detail.append(make("summary", "", more.summary));
        const box = make("div", "group");
        buildRows(box, more.rows);
        detail.append(box);
        node.append(detail);
      }

      const keys = [...node.querySelectorAll(".row[data-key]")].map((row) => row.dataset.key);
      if (node.querySelector(".look-grid")) keys.push("look");
      let resetPage = null;
      if (keys.length) {
        resetPage = actionButton(null, "Reset page", () => setAll({ ...settings, ...Object.fromEntries(keys.map((k) => [k, DEFAULTS[k]])) }), "pill-btn page-reset");
        resetPage.dataset.resetPage = id;
        resetPage.title = `Put every ${page.title} setting back to its default`;
        head.append(resetPage);
      }

      scrollEl.append(node);
      pages.push({ id, page, node, keys, resetPage });

      const link = make("button", "section-link");
      link.type = "button";
      link.dataset.section = id;
      link.setAttribute("aria-controls", node.id);
      link.append(icon(page.glyph), make("span", "section-link-label", page.nav || page.title), make("span", "changed-dot"));
      link.title = page.title;
      link.addEventListener("click", () => {
        if (search.value) { search.value = ""; runSearch(); }
        showPage(id, { focus: false });
      });
      nav.append(link);
      links.set(id, link);
    }
  }

  // Up and down move through the sidebar like a list.
  nav.addEventListener("keydown", (e) => {
    const visible = [...links.values()].filter((l) => !l.hidden);
    const index = visible.indexOf(document.activeElement);
    if (index < 0) return;
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(index + 1, visible.length - 1);
    else if (e.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = visible.length - 1;
    if (next < 0) return;
    e.preventDefault();
    visible[next].focus();
    visible[next].click();
  });

  // ---------------------------------------------------------------------------
  // Pages and search
  // ---------------------------------------------------------------------------
  let activeId = null;
  function showPage(id, { focus = false } = {}) {
    if (!PAGES[id]) id = pages[0].id;
    activeId = id;
    for (const entry of pages) entry.node.toggleAttribute("data-off-page", entry.id !== id);
    for (const [pid, link] of links) {
      if (pid === id) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    scrollEl.scrollTop = 0;
    try { localStorage.setItem(PAGE_KEY, id); } catch (_) {}
    if (focus) links.get(id)?.focus();
  }

  const search = $("settings-search");
  function runSearch() {
    const query = search.value.trim().toLowerCase();
    scrollEl.toggleAttribute("data-searching", !!query);
    let count = 0;
    for (const { node, page, id } of pages) {
      const rows = [...node.querySelectorAll(".row,.action-row,.preset-entry,.look-swatch,.shortcut")];
      const titleMatch = !!query && (page.title.toLowerCase().includes(query) || (page.nav || "").toLowerCase().includes(query));
      for (const row of rows) row.hidden = !!query && !titleMatch && !row.textContent.toLowerCase().includes(query);
      for (const block of node.querySelectorAll(".group-block")) {
        block.hidden = !!query && ![...block.querySelectorAll(".row,.action-row,.preset-entry,.look-swatch,.shortcut")].some((r) => !r.hidden);
      }
      const visible = !query || titleMatch || rows.some((r) => !r.hidden);
      node.hidden = !visible;
      links.get(id).hidden = !visible;
      if (visible) count++;
      for (const detail of node.querySelectorAll("details")) {
        if (query) {
          const hit = [...detail.querySelectorAll(".row,.action-row,.preset-entry")].some((r) => !r.hidden);
          if (hit && !detail.open) { detail.open = true; detail.dataset.searchOpened = "true"; }
          detail.hidden = !hit && !titleMatch;
        } else {
          detail.hidden = false;
          if (detail.dataset.searchOpened) { detail.open = false; delete detail.dataset.searchOpened; }
        }
      }
    }
    for (const heading of nav.querySelectorAll(".nav-heading")) {
      let next = heading.nextElementSibling, any = false;
      while (next && !next.classList.contains("nav-heading")) { if (!next.hidden) any = true; next = next.nextElementSibling; }
      heading.hidden = !any;
    }
    $("search-empty").hidden = count > 0;
    if (!query) showPage(activeId);
  }
  search.addEventListener("input", runSearch);
  // Rebuilt preset cards must not come back unfiltered under an active search.
  reapplySearch = () => { if (search.value.trim()) runSearch(); };
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; runSearch(); }
  });
  // Ctrl+F or "/" jumps to search, like most settings pages.
  window.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) { e.preventDefault(); search.focus(); search.select(); }
  });

  // ---------------------------------------------------------------------------
  // Dependent rows, changed markers
  // ---------------------------------------------------------------------------
  function syncDependents() {
    const row = (key) => scrollEl.querySelector(`.row[data-key="${key}"]`);
    // Dimmed: still meaningful, waiting on another switch.
    const dim = (key, off) => {
      const r = row(key);
      if (!r) return;
      r.toggleAttribute("data-inactive", off);
      for (const c of r.querySelectorAll("input, .switch, .segmented button")) c.disabled = off;
    };
    // Tucked away: only a choice of "Custom" makes these mean anything.
    const reveal = (key, on) => row(key)?.toggleAttribute("data-collapsed", !on);
    dim("showBarAtStartup", !autostartEnabled);
    dim("blur", !settings.nativeBlur);
    dim("replyBlur", !settings.replyNativeBlur);
    reveal("accentColor", settings.accentSource === "custom");
    reveal("tintColor", settings.tintSource === "custom");
    const noMotion = !QSettings.motionOn;
    for (const key of ["speed", "feel", "enterStyle", "riseDistance", "tabPop", "shimmer"]) dim(key, noMotion);
    for (const key of ["tabCount", "tabStyle", "showTabClock"]) dim(key, !settings.showTabs);
  }

  function markPages() {
    for (const { id, keys, resetPage } of pages) {
      const changed = keys.some((k) => settings[k] !== DEFAULTS[k]);
      links.get(id).toggleAttribute("data-changed", changed);
      if (resetPage) resetPage.hidden = !changed;
    }
  }

  afterChange = () => { syncDependents(); markPages(); refreshPresets(); };

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------
  const closeWindow = () => invoke("close_settings").catch(() => {});
  $("btn-close").addEventListener("click", closeWindow);

  const showResetConfirm = (on) => {
    $("btn-reset-all").hidden = on;
    $("btn-reset-confirm").hidden = !on;
    $("btn-reset-cancel").hidden = !on;
  };
  $("btn-reset-all").addEventListener("click", () => { showResetConfirm(true); $("btn-reset-cancel").focus(); });
  $("btn-reset-cancel").addEventListener("click", () => { showResetConfirm(false); $("btn-reset-all").focus(); });
  $("btn-reset-confirm").addEventListener("click", () => {
    setAll({ ...DEFAULTS });
    showResetConfirm(false);
    $("btn-reset-all").focus();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (!$("btn-reset-confirm").hidden) { showResetConfirm(false); $("btn-reset-all").focus(); return; }
    closeWindow();
  });

  // ---------------------------------------------------------------------------
  // Account status and relays
  // ---------------------------------------------------------------------------
  function updateAccount({ ready, loggedIn, signedOut }) {
    let state, text;
    if (signedOut) { state = "signed-out"; text = "Signed out. Sign in again to continue."; }
    else if (!ready) { state = "connecting"; text = loggedIn ? "Signed in. Loading chat…" : "Connecting…"; }
    else if (loggedIn) { state = "signed-in"; text = "Signed in"; }
    else { state = "guest"; text = "Using ChatGPT as a guest"; }
    accountStatus.dataset.state = state;
    accountStatus.textContent = text;
    accountButton.textContent = loggedIn ? "Manage account" : "Sign in";
  }

  listen("bridge", ({ payload: evt }) => {
    if (!evt || typeof evt !== "object") return;
    if ((evt.provider || "chatgpt") === "gemini") {
      if (evt.type === "error" && evt.code === "auth") { geminiStatus.textContent = "Signed out"; geminiStatus.dataset.state = "signed-out"; geminiButton.textContent = "Sign in"; }
      if (evt.type === "status") {
        geminiStatus.textContent = evt.loggedIn ? "Signed in" : evt.ready ? "Using Gemini as a guest" : "Not connected yet";
        geminiStatus.dataset.state = evt.loggedIn ? "signed-in" : evt.ready ? "guest" : "connecting";
        geminiButton.textContent = evt.loggedIn ? "Manage account" : "Sign in";
      }
      return;
    }
    if (evt.type === "status") { updateAccount({ ready: Boolean(evt.ready), loggedIn: Boolean(evt.loggedIn) }); if (!evt.ready && !evt.loggedIn) accountStatus.textContent = "Not connected yet"; }
    else if (evt.type === "error" && evt.code === "auth") updateAccount({ ready: true, loggedIn: false, signedOut: true });
  });

  const announceFocus = () => emit("qchat://settings-focus", null);
  window.addEventListener("focus", announceFocus);
  announceFocus();

  window.addEventListener("storage", (e) => {
    if (e.key !== QSettings.STORAGE_KEY) return;
    settings = QSettings.load();
    QSettings.apply(root, settings);
    for (const refresh of refreshers.values()) refresh();
    afterChange();
  });

  QSettings.watchEnvironment(syncDependents);
  invoke("get_theme").then((theme) => QSettings.setTheme(theme)).catch(() => {});

  for (const refresh of refreshers.values()) refresh();
  afterChange();
  let startPage = null;
  try { startPage = localStorage.getItem(PAGE_KEY); } catch (_) {}
  showPage(startPage && PAGES[startPage] ? startPage : pages[0].id);
  invoke("chat_status").catch(() => {});
  $("sheet").focus({ preventScroll: true });
})();
