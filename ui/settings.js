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
    refreshPresets();
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
    refreshPresets();
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

  function rangeRow({ key, label, hint, format }) {
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

  const shortcutRefreshers = [];
  function dynamicShortcut(label, command) {
    const nodes = shortcut(label, "Loading…");
    const refresh = () => invoke(command).then(key => {
      const replacement = shortcut(label, ...(key ? key.split("+") : ["Disabled"]));
      nodes.replaceChildren(...replacement.childNodes);
    }).catch(() => {});
    shortcutRefreshers.push(refresh); refresh(); return nodes;
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
  accountStatus.textContent = "Not connected yet";
  const accountButton = make("button", "pill-btn pill-accent", "Sign in");
  accountButton.type = "button";
  accountButton.id = "btn-signin";
  accountButton.addEventListener("click", () => invoke("show_signin", {provider:"chatgpt"}).catch(() => {}));

  const geminiStatus = make("small", "", "Not connected yet");
  geminiStatus.id = "gemini-account-status";
  const geminiButton = make("button", "pill-btn", "Sign in");
  geminiButton.id = "btn-signin-gemini";
  geminiButton.onclick = () => invoke("show_signin", {provider:"gemini"}).catch(() => {});
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
        () => rangeRow({ key: "glassOpacity", label: "Bar opacity" }),
        () => rangeRow({ key: "blur", label: "Bar blur" }),
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
        () => choiceRow({ key: "feel", label: "Feel", options: [["calm", "Calm"], ["smooth", "Smooth"], ["springy", "Springy"], ["snappy", "Snappy"]] }),
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
          () => choiceRow({key:"defaultProvider", label:"Default provider", hint:"Provider for new sessions", options:[["chatgpt","ChatGPT"],["gemini","Gemini"]]}),
          () => choiceRow({ key: "defaultReasoning", label: "Default reasoning", hint: "New chats start here; the composer can set each chat", options: [["low", "Low"], ["medium", "Medium"], ["high", "High"]] }),
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
          () => actionRow("Gemini account", geminiStatus, geminiButton),
          () => actionRow("Quit QChat", "Closes the app and its tray icon", actionButton("btn-quit", "Quit", () => invoke("quit_app").catch(() => {})))
        ],
        [() => {
          const list = make("dl", "shortcut-list");
          list.append(
            dynamicShortcut("Show or hide QChat", "get_hotkey"),
            dynamicShortcut("Ask about selection", "get_selection_hotkey"),
            shortcut("Commands menu", "Ctrl", "K"),
            shortcut("All chats", "Ctrl", "P"),
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
        line.append(make("strong", "", "QChat"), document.createTextNode(" keeps your AI chats one shortcut away, using your own signed-in sessions. Type /settings in the bar to come back here."));
        return line;
      }]]
    }
  ];

  SECTIONS.find(s => s.id === "shape").title = "Bar glass";
  SECTIONS.find(s => s.id === "text").title = "Reading";
  SECTIONS.find(s => s.id === "layout").title = "Bar & tabs";
  SECTIONS.find(s => s.id === "chats").title = "Chats";
  SECTIONS.find(s => s.id === "account").title = "Account";
  function textRow({key,label,hint}) {
    const row = make("div","row"); row.dataset.key = key;
    const input = make("input","text-input"); input.type = "text"; input.maxLength = SCHEMA[key].max; input.setAttribute("aria-label",label);
    input.addEventListener("input",() => setValue(key,input.value)); row.append(textBlock(label,hint),input,resetButton(key,label));
    refreshers.set(key,() => { input.value = settings[key]; row.toggleAttribute("data-changed",settings[key] !== DEFAULTS[key]); }); return row;
  }
  SECTIONS.push({id:"chatpanel",title:"Chat panel",glyph:"",preview:true,groups:[]});
  const extra = {
    appearance: "tintSource tintColor inkBoost",
    chatpanel: "replyOpacity readableGuard replyNativeBlur replyBlur replyCorners replyBorder replyWidth replyPadding bubbleGap maxHeightPct",
    text: "paragraphSpacing letterSpacing replyWeight headingScale codeSize codeFont codeWrap userLines userAlign showPrompt linkStyle quoteStyle softEdges scrollbarStyle",
    motion: "enterStyle",
    layout: "tabCount tabStyle showAttach orbStyle sendStyle placeholderText",
    streaming: "streamStyle streamSpeed followStream streamCaret"
  };
  const descriptions = {
    tintSource:["Glass colour source","Use the look or a custom tint"],tintColor:["Custom glass colour","Automatically chooses light or dark ink"],inkBoost:["Secondary text strength","Sharpen quieter text"],
    replyOpacity:["Chat opacity","Background fill behind messages"],replyNativeBlur:["Chat desktop blur","Blur the desktop behind messages"],replyBlur:["Chat blur strength","Blend between clear and frosted glass"],replyCorners:["Chat corners","Roundness of message bubbles"],replyBorder:["Chat border","Outline thickness around messages"],maxHeightPct:["Chat height limit","Percentage of screen height"],readableGuard:["Keep text readable","Raise reply opacity for contrast"],
    replyWidth:["Reply width","Independent of bar width"],paragraphSpacing:["Paragraph spacing","Space between paragraphs"],letterSpacing:["Letter spacing","Space between letters"],replyWeight:["Text weight","Thickness of body text"],headingScale:["Heading scale","Relative size of headings"],replyPadding:["Reply padding","Space around reply text"],bubbleGap:["Bubble spacing","Space between objects"],codeSize:["Code size","Relative to reply text"],codeFont:["Code font","Typeface for code blocks"],codeWrap:["Wrap code","Fit long lines inside the bubble"],userLines:["My message line limit","Zero shows every line"],userAlign:["My message alignment","Side of the reply stack"],showPrompt:["Keep my message above the reply","Keep the prompt visible after sending"],linkStyle:["Link style","How links stand out"],quoteStyle:["Quote style","How quoted text appears"],softEdges:["Fade scroller edges","Soften clipped text at the edges"],scrollbarStyle:["Scrollbar style","Width of reply scrollbars"],
    enterStyle:["Reply entrance","How new replies arrive"],tabCount:["Recent tab count","Maximum tabs above the bar"],tabStyle:["Tab style","How tabs join the bar"],showAttach:["Attachment button","Show the paperclip"],orbStyle:["Orb style","Appearance of the brand mark"],sendStyle:["Send button style","Accent or quiet fill"],placeholderText:["Prompt placeholder","Shown when your message is empty"],streamStyle:["Streaming style","How incoming text appears"],streamSpeed:["Streaming speed","Pace of incoming text"],followStream:["Follow incoming text","Scroll as the reply grows"],streamCaret:["Streaming caret","Show a cursor while replying"]
  };
  SECTIONS.splice(SECTIONS.findIndex(s => s.id === "motion"),0,{id:"streaming",title:"Streaming",glyph:"",groups:[]});
  for (const [id,keys] of Object.entries(extra)) SECTIONS.find(s => s.id === id).groups.push(keys.split(" ").map(key => () => {
    const spec = SCHEMA[key], [label,hint] = descriptions[key];
    return ({range:rangeRow,bool:switchRow,enum:choiceRow,color:colorRow,text:textRow})[spec.type]({key,label,hint,options:spec.options?.map(v => [v,v.charAt(0).toUpperCase()+v.slice(1)])});
  }));
  let refreshPresets = () => {};
  function presetGallery() {
    const wrap = make("div","preset-area"), gallery = make("div","preset-gallery"), status = make("p","section-note"); status.id = "preset-status";
    const name = make("input","text-input"); name.placeholder = "Preset name"; name.maxLength = 60; name.setAttribute("aria-label","Preset name");
    const transfer = make("textarea","preset-transfer"); transfer.setAttribute("aria-label","Preset JSON"); transfer.placeholder = "Paste or copy preset JSON";
    const notice = make("p","section-note"); notice.setAttribute("role","status");
    wrap.append(status,gallery,name,actionButton("preset-save","Save current as preset...",() => { notice.textContent = QSettings.savePreset(name.value,settings) ? "Preset saved" : "Enter a name (maximum 40 presets)"; refreshPresets(); }),transfer,
      actionButton("preset-export","Export current",async () => { transfer.value = JSON.stringify({label:name.value.trim() || "My preset",values:Object.fromEntries(QSettings.APPEARANCE_KEYS.map(k => [k,settings[k]]))}); try { await navigator.clipboard.writeText(transfer.value); notice.textContent = "Copied preset"; } catch (_) { notice.textContent = "Copy the JSON below"; } }),
      actionButton("preset-import","Import",() => { notice.textContent = QSettings.importPreset(transfer.value) ? "Preset imported" : "Invalid preset or preset list full"; refreshPresets(); }),notice);
    refreshPresets = () => {
      gallery.replaceChildren(); let active = "Modified";
      for (const p of [...QSettings.PRESETS,...QSettings.listPresets()]) {
        const target = QSettings.applyPreset(settings,p.id), on = QSettings.APPEARANCE_KEYS.every(k => target[k] === settings[k]); if (on) active = p.label;
        const card = make("div","preset-entry"), button = make("button","preset-card"); button.dataset.preset = p.id; button.setAttribute("aria-pressed",String(on));
        const swatch = make("span","preset-swatch"); const swatchColours = QSettings.swatch(target.look); swatch.style.background = `linear-gradient(135deg, ${swatchColours.tint[0]} 0 45%, ${swatchColours.orb[1]} 100%)`; swatch.style.borderRadius = `${Math.round(3 + target.cornerWeight / 10)}px`;
        button.append(swatch,make("strong","",p.label),make("small","",p.blurb || "Saved look")); button.addEventListener("click",() => setAll(QSettings.applyPreset(settings,p.id))); card.append(button);
        if (p.id.startsWith("user-")) card.append(actionButton("delete-"+p.id,"Delete",() => { QSettings.deletePreset(p.id); refreshPresets(); }));
        gallery.append(card);
      }
      status.textContent = active;
    }; refreshPresets(); return wrap;
  }
  SECTIONS.unshift({id:"presets",title:"Presets",glyph:"",groups:[[presetGallery]]});
  let autostartEnabled = false;
  function desktopControl(kind) {
    const isHotkey = kind === "hotkey" || kind === "selection";
    const command = kind === "selection" ? "selection_hotkey" : "hotkey";
    const button = make("button", "pill-btn", "Loading...");
    const hint = make("small", "", isHotkey ? "" : "Starts quietly in the tray. Alt+Q (or your shortcut) opens it.");
    if (!isHotkey) invoke("get_hotkey").then(key => { if (key) hint.textContent = `Starts quietly in the tray. ${key} opens it.`; }).catch(() => {});
    const row = actionRow(isHotkey ? (kind === "selection" ? "Ask about selection" : "Global shortcut") : "Open at startup", hint, button);
    let current = isHotkey ? "Record shortcut" : false;
    const sync = () => { if (!isHotkey) { autostartEnabled = current; syncDependents(); } button.textContent = isHotkey ? (current || "Disabled") : current ? "On" : "Off"; if (!isHotkey) button.setAttribute("aria-checked", String(current)); };
    if (!isHotkey) { button.setAttribute("role", "switch"); button.setAttribute("aria-label", "Open at startup"); }
    invoke(isHotkey ? "get_" + command : "get_autostart").then(v => { if (isHotkey ? typeof v === "string" : typeof v === "boolean") current = v; sync(); }).catch(() => { sync(); hint.textContent = "Available in the desktop app"; });
    if (isHotkey) invoke("get_" + command + "_available").then(available => { if (!available) hint.textContent = "Shortcut unavailable"; }).catch(() => {});
    button.addEventListener("click", async () => {
      if (isHotkey) { button.dataset.recording = "true"; button.textContent = "Press a key combination"; return; }
      try { await invoke("set_autostart", {enabled: !current}); current = !current; sync(); } catch (e) { hint.textContent = String(e.message || e); }
    });
    button.addEventListener("keydown", async e => {
      if (!button.dataset.recording) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { delete button.dataset.recording; sync(); return; }
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      if (kind === "selection" && e.key === "Backspace") { await invoke("set_selection_hotkey", {accelerator: ""}); current = ""; shortcutRefreshers.forEach(refresh => refresh()); delete button.dataset.recording; sync(); return; }
      if (!e.ctrlKey && !e.altKey && !e.metaKey) { hint.textContent = "Include Ctrl, Alt or Windows"; return; }
      const accelerator = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join("+");
      try { await invoke("set_" + command, {accelerator}); current = accelerator; shortcutRefreshers.forEach(refresh => refresh()); sync(); hint.textContent = ""; delete button.dataset.recording; } catch (err) { hint.textContent = String(err.message || err); }
    });
    return row;
  }
  SECTIONS.find(s => s.id === "behavior").groups.unshift([() => desktopControl("hotkey"), () => desktopControl("selection"), () => switchRow({key: "selectionClipboard", label: "Copy selection if needed", hint: "Copies selected text when needed; restores the clipboard when possible"}), () => desktopControl("autostart"), () => switchRow({key:"showBarAtStartup", label:"Show the bar at startup", hint:"Show the bar when QChat opens at startup"})]);
  SECTIONS.find(s => s.id === "shape").groups.unshift([() => switchRow({key:"nativeBlur",label:"Bar desktop blur",hint:"Blur the desktop behind the bar and menus"})]);
  const sectionOrder = ["presets","appearance","shape","chatpanel","text","streaming","motion","layout","behavior","chats","account","about"];
  SECTIONS.sort((a,b) => sectionOrder.indexOf(a.id)-sectionOrder.indexOf(b.id));
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
    const advanced = new Set(["rim", "sheen", "shadow", "border", "saturation", "bubbleTint", "riseDistance", "lineHeight", "letterSpacing", "replyWeight", "headingScale", "codeSize", "userLines"]);
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
  const search = $("settings-search");
  search.addEventListener("input",() => {
    const query = search.value.trim().toLowerCase(); let count = 0;
    for (const {node,section} of sectionNodes) {
      const rows = [...node.querySelectorAll(".row,.action-row,.preset-entry,.look-swatch")];
      for (const row of rows) row.hidden = !!query && !row.textContent.toLowerCase().includes(query);
      const visible = !query || rows.some(r => !r.hidden) || section.title.toLowerCase().includes(query);
      node.hidden = !visible; links.get(section.id).hidden = !visible; if (visible) count++;
      for (const detail of node.querySelectorAll("details")) if (query) detail.open = true;
    }
    $("search-empty").hidden = count > 0;
  });
  search.addEventListener("keydown",e => { if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; search.dispatchEvent(new Event("input")); } });
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
    dim("showBarAtStartup", !autostartEnabled);
    const noMotion = !QSettings.motionOn;
    dim("tintColor", settings.tintSource !== "custom");
    dim("streamSpeed", settings.streamStyle === "instant");
    dim("blur", !settings.nativeBlur);
    dim("replyBlur", !settings.replyNativeBlur);
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
    if ((evt.provider || "chatgpt") === "gemini") { if (evt.type === "error" && evt.code === "auth") { geminiStatus.textContent = "Signed out"; geminiButton.textContent = "Sign in"; } if (evt.type === "status") { geminiStatus.textContent = evt.loggedIn ? "Signed in" : evt.ready ? "Guest" : "Not connected yet"; geminiButton.textContent = evt.loggedIn ? "Manage account" : "Sign in"; } return; }
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
    syncDependents();
    refreshPresets();
  });

  QSettings.watchEnvironment(syncDependents);
  invoke("get_theme").then((theme) => QSettings.setTheme(theme)).catch(() => {});

  for (const refresh of refreshers.values()) refresh();
  syncDependents();
  setActive(SECTIONS[0]);
  invoke("chat_status").catch(() => {});
  $("sheet").focus({ preventScroll: true });
})();
