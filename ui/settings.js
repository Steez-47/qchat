// Settings window. Every change is saved, applied here, and relayed live to the chat window.
(function () {
  "use strict";

  const invoke = (cmd, args) => (window.__TAURI__?.core?.invoke ? window.__TAURI__.core.invoke(cmd, args) : Promise.reject(new Error("Available in the desktop app")));
  const listen = (event, cb) => window.__TAURI__?.event?.listen(event, cb);
  const emit = (event, payload) => window.__TAURI__?.event?.emit(event, payload);
  const { SCHEMA, DEFAULTS, LOOKS } = QSettings;
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);

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

  function relay() {
    relayQueued = false;
    emit("qchat://settings-changed", settings);
  }

  function setValue(key, value) {
    settings = { ...settings, [key]: QSettings.sanitizeValue(key, value) };
    settings = QSettings.save(settings);
    QSettings.apply(root, settings);
    refreshers.get(key)?.();
    syncDependents();
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
    syncDependents();
    relay();
  }

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
    return `${Number(Number(value).toFixed(2))}${spec.unit}`;
  }

  function rangeRow({ key, label, format }) {
    const spec = SCHEMA[key];
    const row = make("div", "row row-range");
    row.dataset.key = key;
    const text = make("div", "row-text");
    const name = make("label", "row-label", label);
    const id = `control-${key}`;
    name.htmlFor = id;
    const value = make("output", "value");
    value.htmlFor = id;
    text.append(name, value);
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
      row.toggleAttribute("data-changed", settings[key] !== DEFAULTS[key]);
    });
    return row;
  }

  function choiceRow({ key, label, hint, options }) {
    const row = make("div", "row");
    row.dataset.key = key;
    const group = make("div", "segmented");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    const buttons = options.map(([value, text]) => {
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
      row.toggleAttribute("data-changed", settings[key] !== DEFAULTS[key]);
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
      row.toggleAttribute("data-changed", settings[key] !== DEFAULTS[key]);
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
      row.toggleAttribute("data-changed", settings[key] !== DEFAULTS[key]);
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
    });
  }

  function lookPicker() {
    const wrap = make("div", "group");
    const grid = make("div", "look-grid");
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", "Look");
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
    wrap.append(grid);
    refreshers.set("look", () => {
      for (const button of buttons) {
        const on = button.dataset.look === settings.look;
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
      }
    });
    return wrap;
  }

  const onOff = (value) => (value ? "On" : "Off");
  const seconds = (value) => (value ? `${value} s` : "Off");
  const times = (value) => `${value.toFixed(1)}×`;
  const shortcut = (name, ...keys) => {
    const row = make("div", "shortcut");
    const dd = make("dd");
    dd.append(...keys.map((k) => make("kbd", "", k)));
    row.append(make("dt", "", name), dd);
    return row;
  };

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------
  const accountStatus = make("small");
  accountStatus.id = "account-status";
  accountStatus.dataset.state = "connecting";
  accountStatus.textContent = "Connecting…";
  const accountButton = make("button", "pill-btn pill-accent", "Sign in");
  accountButton.type = "button";
  accountButton.id = "btn-signin";
  accountButton.addEventListener("click", () => invoke("show_signin").catch(() => {}));

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
    button.id = id;
    button.addEventListener("click", onClick);
    return button;
  }

  const clearButton = actionButton("btn-clear-chats", "Clear recent chats", () => {
    if (clearButton.dataset.armed) {
      delete clearButton.dataset.armed;
      clearButton.textContent = "Cleared";
      clearButton.disabled = true;
      localStorage.setItem("qchat.chats.clear", String(Date.now()));
      emit("qchat://clear-chats", null);
      setTimeout(() => { clearButton.textContent = "Clear recent chats"; clearButton.disabled = false; }, 1600);
    } else {
      clearButton.dataset.armed = "true";
      clearButton.textContent = "Click again to clear";
      setTimeout(() => {
        if (clearButton.dataset.armed) { delete clearButton.dataset.armed; clearButton.textContent = "Clear recent chats"; }
      }, 3000);
    }
  }, "pill-btn pill-danger");

  const SECTIONS = [
    {
      id: "appearance", title: "Appearance", glyph: "", preview: true,
      groups: [
        [lookPicker],
        [
          () => choiceRow({ key: "accentSource", label: "Accent colour", options: [["look", "Look"], ["system", "Windows"], ["custom", "Custom"]] }),
          () => colorRow({ key: "accentColor", label: "Custom colour", hint: "Used when the accent is set to Custom" }),
          () => rangeRow({ key: "bubbleTint", label: "Bubble tint strength" }),
          () => rangeRow({ key: "saturation", label: "Colour saturation" })
        ]
      ]
    },
    {
      id: "shape", title: "Shape & glass", glyph: "", preview: true,
      groups: [[
        () => rangeRow({ key: "cornerWeight", label: "Corner weight" }),
        () => rangeRow({ key: "glassOpacity", label: "Glass opacity" }),
        () => rangeRow({ key: "blur", label: "Blur" }),
        () => rangeRow({ key: "rim", label: "Edge light" }),
        () => rangeRow({ key: "sheen", label: "Specular sheen" }),
        () => rangeRow({ key: "shadow", label: "Shadow strength" }),
        () => rangeRow({ key: "border", label: "Border thickness" })
      ]]
    },
    {
      id: "motion", title: "Motion", glyph: "", preview: true,
      groups: [[
        () => choiceRow({ key: "animations", label: "Animations", hint: "Auto follows your Windows setting", options: [["auto", "Auto"], ["on", "On"], ["off", "Off"]] }),
        () => choiceRow({ key: "feel", label: "Feel", options: [["smooth", "Smooth"], ["springy", "Springy"], ["snappy", "Snappy"]] }),
        () => rangeRow({ key: "speed", label: "Speed", format: times }),
        () => rangeRow({ key: "riseDistance", label: "Bubble rise distance" }),
        () => switchRow({ key: "tabPop", label: "Tabs pop out of the bar" }),
        () => switchRow({ key: "shimmer", label: "Shimmer while streaming" })
      ]]
    },
    {
      id: "text", title: "Text", glyph: "", preview: true,
      groups: [[
        () => rangeRow({ key: "textSize", label: "Text size" }),
        () => choiceRow({ key: "fontFamily", label: "Font", options: [["segoe", "Segoe"], ["system", "System"], ["serif", "Serif"], ["rounded", "Soft"], ["mono", "Mono"]] }),
        () => rangeRow({ key: "lineHeight", label: "Line height", format: (v) => v.toFixed(2) }),
        () => switchRow({ key: "justify", label: "Justify replies" })
      ]]
    },
    {
      id: "layout", title: "Layout", glyph: "", preview: true,
      groups: [[
        () => rangeRow({ key: "barWidth", label: "Bar width" }),
        () => rangeRow({ key: "maxHeightPct", label: "Reply height limit", format: (v) => `${v}% of screen` }),
        () => choiceRow({ key: "density", label: "Bar size", options: [["compact", "Compact"], ["cozy", "Cozy"], ["roomy", "Roomy"]] }),
        () => switchRow({ key: "showTabs", label: "Recent-chat tabs" }),
        () => switchRow({ key: "showTabClock", label: "Clock icon on tabs" }),
        () => switchRow({ key: "showSuggestions", label: "Suggestion chips on an empty chat" }),
        () => switchRow({ key: "showStatusDot", label: "Connection dot on the orb" })
      ]]
    },
    {
      id: "behavior", title: "Behavior", glyph: "",
      groups: [
        [
          () => choiceRow({ key: "sendKey", label: "Send with", options: [["enter", "Enter"], ["ctrl", "Ctrl+Enter"]] }),
          () => rangeRow({ key: "autoDismiss", label: "Dismiss replies automatically", format: seconds }),
          () => switchRow({ key: "alwaysOnTop", label: "Always on top" }),
          () => switchRow({ key: "hideOnBlur", label: "Hide when focus is lost" }),
          () => switchRow({ key: "rememberPosition", label: "Remember window position" })
        ],
        [() => actionRow("Window position", "Puts the bar back at the bottom centre of your screen", actionButton("btn-reset-position", "Reset position", () => invoke("reset_position").catch(() => {})))]
      ]
    },
    {
      id: "chats", title: "Chats & privacy", glyph: "",
      note: "Recent chats are stored only on this PC. Nothing here is uploaded by QChat.",
      groups: [
        [() => switchRow({ key: "keepHistory", label: "Keep recent chats", hint: "Off stores nothing and hides the tabs" })],
        [() => actionRow("Recent chats", "Removes the tabs and their saved replies", clearButton)]
      ]
    },
    {
      id: "account", title: "Account & shortcuts", glyph: "",
      groups: [
        [
          () => actionRow("ChatGPT account", accountStatus, accountButton),
          () => actionRow("Quit QChat", "Closes the app and its tray icon", actionButton("btn-quit", "Quit", () => invoke("quit_app").catch(() => {})))
        ],
        [() => {
          const list = make("dl", "shortcut-list");
          list.append(
            shortcut("Show or hide QChat", "Alt", "Q"),
            shortcut("New chat", "Ctrl", "N"),
            shortcut("Stop generating", "Ctrl", "."),
            shortcut("Commands", "/"),
            shortcut("Dismiss a reply, then hide", "Esc"),
            shortcut("New line in a message", "Shift", "Enter")
          );
          return list;
        }]
      ]
    },
    {
      id: "about", title: "About", glyph: "",
      groups: [[() => {
        const line = make("p", "about-line");
        line.append(make("strong", "", "QChat"), document.createTextNode(" keeps ChatGPT one shortcut away, using your own signed-in session. Type /settings in the bar to come back here."));
        return line;
      }]]
    }
  ];

  const appearance = SECTIONS.find(s => s.id === "appearance");
  appearance.groups.push(...SECTIONS.splice(SECTIONS.findIndex(s => s.id === "shape"), 1)[0].groups);
  const layout = SECTIONS.splice(SECTIONS.findIndex(s => s.id === "layout"), 1)[0];
  const textSection = SECTIONS.find(s => s.id === "text");
  textSection.title = "Text & size"; textSection.groups.push(...layout.groups);
  SECTIONS.find(s => s.id === "chats").title = "Chats";
  SECTIONS.find(s => s.id === "account").title = "Account";
  function desktopControl(kind) {
    const isHotkey = kind === "hotkey" || kind === "selection";
    const command = kind === "selection" ? "selection_hotkey" : "hotkey";
    const button = make("button", "pill-btn", "Loading...");
    const hint = make("small", "", "");
    const row = actionRow(isHotkey ? (kind === "selection" ? "Ask about selection" : "Global shortcut") : "Launch at login", hint, button);
    let current = isHotkey ? "Record shortcut" : false;
    const sync = () => { button.textContent = isHotkey ? (current || "Disabled") : current ? "On" : "Off"; if (!isHotkey) button.setAttribute("aria-checked", String(current)); };
    if (!isHotkey) { button.setAttribute("role", "switch"); button.setAttribute("aria-label", "Launch at login"); }
    invoke(isHotkey ? "get_" + command : "get_autostart").then(v => { if (isHotkey ? typeof v === "string" : typeof v === "boolean") current = v; sync(); }).catch(() => { sync(); hint.textContent = "Available in the desktop app"; });
    button.addEventListener("click", async () => {
      if (isHotkey) { button.dataset.recording = "true"; button.textContent = "Press a key combination"; return; }
      try { await invoke("set_autostart", {enabled: !current}); current = !current; sync(); hint.textContent = ""; } catch (e) { hint.textContent = String(e.message || e); }
    });
    button.addEventListener("keydown", async e => {
      if (!button.dataset.recording) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { delete button.dataset.recording; sync(); return; }
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      if (kind === "selection" && e.key === "Backspace") { await invoke("set_selection_hotkey", {accelerator: ""}); current = ""; delete button.dataset.recording; sync(); return; }
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hint.textContent = "Include Ctrl, Alt or Windows"; return; }
      const accelerator = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
      try { await invoke("set_" + command, {accelerator}); current = accelerator; sync(); hint.textContent = ""; delete button.dataset.recording; } catch (err) { hint.textContent = String(err.message || err); }
    });
    return row;
  }
  SECTIONS.find(s => s.id === "behavior").groups.unshift([() => desktopControl("hotkey"), () => desktopControl("selection"), () => switchRow({key: "selectionClipboard", label: "Copy selection if needed", hint: "Briefly uses the clipboard when an app doesn't share its selection, then restores it"}), () => desktopControl("autostart"), () => switchRow({key: "nativeBlur", label: "Desktop blur"})]);
  const scrollEl = $("section-scroll");
  const nav = $("section-nav");
  const preview = $("preview");
  const links = new Map();
  const sectionNodes = [];

  for (const section of SECTIONS) {
    const node = make("section", "section");
    node.id = `section-${section.id}`;
    node.setAttribute("aria-labelledby", `heading-${section.id}`);
    const heading = make("h2", "section-title", section.title);
    heading.id = `heading-${section.id}`;
    node.append(heading);
    if (section.note) node.append(make("p", "section-note", section.note));
    section.groups.forEach((rows, i) => {
      const group = make("div", "group");
      if (i) group.style.marginTop = "8px";
      for (const build of rows) {
        const child = build();
        if (rows.length === 1 && child.classList.contains("group")) { group.replaceWith(child); node.append(child); return; }
        group.append(child);
      }
      if (group.childElementCount) node.append(group);
    });
    const advanced = new Set(["rim", "sheen", "shadow", "border", "saturation", "bubbleTint", "riseDistance", "lineHeight"]);
    const rows = [...node.querySelectorAll(".row[data-key]")].filter(r => advanced.has(r.dataset.key));
    if (rows.length) { const detail = make("details", "fine-tune"); detail.append(make("summary", "", "Fine-tune"), ...rows); node.append(detail); }
    scrollEl.append(node);
    sectionNodes.push({ node, section });

    const link = make("button", "section-link");
    link.type = "button";
    link.dataset.section = section.id;
    link.append(icon(section.glyph), make("span", "", section.title.replace(" & shortcuts", "").replace(" & privacy", "").replace(" & glass", "")));
    link.title = section.title;
    link.addEventListener("click", () => {
      spyPausedUntil = performance.now() + 400;
      setActive(section);
      node.scrollIntoView({ block: "start" });
    });
    nav.append(link);
    links.set(section.id, link);
  }

  // ---------------------------------------------------------------------------
  // Section tracking and preview
  // ---------------------------------------------------------------------------
  let activeId = null;
  let spyPausedUntil = 0;
  function setActive(section) {
    if (activeId === section.id) return;
    activeId = section.id;
    for (const [id, link] of links) {
      if (id === section.id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }

  }

  let spyQueued = false;
  function spy() {
    spyQueued = false;
    if (performance.now() < spyPausedUntil) return;
    const top = scrollEl.getBoundingClientRect().top + 40;
    let current = sectionNodes[0];
    for (const entry of sectionNodes) {
      if (entry.node.getBoundingClientRect().top <= top) current = entry;
    }
    if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) current = sectionNodes.at(-1);
    setActive(current.section);
  }
  scrollEl.addEventListener("scroll", () => {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(spy);
  });

  // Controls that only matter with another setting on read as such.
  function syncDependents() {
    const dim = (key, off) => {
      const row = scrollEl.querySelector(`.row[data-key="${key}"]`);
      if (!row) return;
      row.style.opacity = off ? "0.5" : "";
      for (const c of row.querySelectorAll("input, .switch, .segmented button")) c.disabled = off;
    };
    const noMotion = !QSettings.motionOn;
    dim("accentColor", settings.accentSource !== "custom");
    for (const key of ["speed", "feel", "riseDistance", "tabPop", "shimmer"]) dim(key, noMotion);
    dim("showTabClock", !settings.showTabs);
  }

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
    if (evt.type === "status") updateAccount({ ready: Boolean(evt.ready), loggedIn: Boolean(evt.loggedIn) });
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
    syncDependents();
  });

  QSettings.watchEnvironment(syncDependents);
  invoke("get_theme").then((theme) => QSettings.setTheme(theme)).catch(() => {});

  for (const refresh of refreshers.values()) refresh();
  syncDependents();
  setActive(SECTIONS[0]);
  invoke("chat_status").catch(() => {});
  $("sheet").focus({ preventScroll: true });
})();
