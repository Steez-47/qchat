// QChat site. One file: smooth scroll, demo canvas fitting, the pinned story, the tour,
// reveals, the stats, the picker and slash-menu demos, the look picker and the live release
// info. No dependencies besides Lenis.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ Smooth scroll */
  let lenis = null;
  if (!reduce && typeof window.Lenis === "function") {
    lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 1 });
    const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute("href");
    const el = id.length > 1 && document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(el, { duration: 1.5 });
    else el.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    history.replaceState(null, "", id);
  });

  /* ------------------------------------------------------------ Text splitting */
  // Headings: each word in a mask so it can slide up into place.
  for (const el of $$("[data-split]")) {
    const words = el.textContent.trim().split(/ +/);
    el.setAttribute("aria-label", el.textContent.trim());
    const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    el.innerHTML = words.map((w, i) => `<span class="wm" aria-hidden="true"><span style="--i:${i}">${esc(w)}</span></span>`).join(" ");
  }

  // Replies in the demos: words surface from low contrast, like the app's streaming.
  for (const el of $$("[data-words]")) {
    let i = 0;
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(part); continue; }
            const s = document.createElement("span");
            s.className = "w";
            s.style.setProperty("--i", i++);
            s.textContent = part;
            frag.append(s);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      }
    };
    walk(el);
  }

  /* ------------------------------------------------------------ Reveals */
  $$(".hero [data-reveal]").forEach((el, i) => el.style.setProperty("--rd", `${0.25 + i * 0.08}s`));
  $$("[data-stagger]").forEach((g) => $$("[data-reveal]", g).forEach((el, i) => el.style.setProperty("--rd", `${(i % 4) * 0.07}s`)));
  const revealer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      revealer.unobserve(e.target);
      const n = e.target.querySelector("[data-count]");
      if (n) countUp(n);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });

  // Hero stats count up from zero once they're on screen.
  function countUp(el) {
    const to = Number(el.dataset.count) || 0;
    if (reduce || to === 0) return;
    const t0 = performance.now(), dur = 900 + to * 20;
    const tick = (t) => {
      const k = clamp((t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    el.textContent = "0";
    requestAnimationFrame(tick);
  }
  $$("[data-reveal], [data-split]").forEach((el) => revealer.observe(el));

  /* ------------------------------------------------------------ Canvas fitting */
  // Every demo is laid out on a fixed-size canvas and scaled as a whole, so nothing reflows.
  const fit = (screen) => {
    const canvas = screen.querySelector(":scope > .canvas");
    const cw = parseFloat(getComputedStyle(screen).getPropertyValue("--cw")) || 1200;
    if (canvas) canvas.style.setProperty("--s", screen.clientWidth / cw);
  };
  const fitter = new ResizeObserver((entries) => entries.forEach((e) => fit(e.target)));
  const watchScreen = (s) => { fit(s); fitter.observe(s); };
  $$("[data-screen]").forEach(watchScreen);

  /* ------------------------------------------------------------ Nav */
  const nav = $("#nav");
  const progress = $("#nav-progress");

  /* ------------------------------------------------------------ Prompt marquee */
  // The track holds the prompts twice so the loop has no seam.
  const track = $(".marquee-track");
  if (track) {
    [...track.children].forEach((c) => { const d = c.cloneNode(true); d.setAttribute("data-clone", ""); track.append(d); });
    track.classList.add("is-looping");
  }

  /* ------------------------------------------------------------ Story */
  const story = $("#story");
  const sc = $("#story-canvas");
  const screen = $(".story-screen");
  const caps = $$(".cap");
  const ticks = $$(".story-ticks li");
  const typed = $("#story-typed");
  const QUESTION = "What’s a clean way to debounce a search box?";
  const flags = { open: false, typing: false, sent: false, reply: false, tabs: false, fold: false };
  let typeTimer = 0;
  let capIndex = -1;

  function setFlag(name, on) {
    if (flags[name] === on) return false;
    flags[name] = on;
    sc.classList.toggle(`is-${name}`, on);
    return true;
  }

  function startTyping() {
    clearInterval(typeTimer);
    if (reduce) { typed.textContent = QUESTION; return; }
    let n = 0;
    typed.textContent = "";
    typeTimer = setInterval(() => {
      typed.textContent = QUESTION.slice(0, ++n);
      if (n >= QUESTION.length) {
        clearInterval(typeTimer);
        typeTimer = setTimeout(() => { if (flags.typing) setFlag("sent", true); }, 380);
      }
    }, 26);
  }

  function updateStory() {
    const rect = story.getBoundingClientRect();
    const vh = window.innerHeight;
    const total = story.offsetHeight - vh;
    const p = clamp(-rect.top / total);

    // Screen settles in as the story arrives.
    if (!reduce) {
      const e = clamp(1 - rect.top / vh);
      const k = 1 - Math.pow(1 - e, 3);
      screen.style.transform = `translateY(${(1 - k) * 40}px) scale(${0.92 + 0.08 * k})`;
    }

    setFlag("open", p > 0.05);
    if (setFlag("typing", p > 0.2)) {
      if (flags.typing) startTyping();
      else { clearInterval(typeTimer); clearTimeout(typeTimer); typed.textContent = ""; setFlag("sent", false); }
    }
    if (p > 0.33) { clearInterval(typeTimer); typed.textContent = QUESTION; setFlag("sent", true); }
    else if (p <= 0.2) setFlag("sent", false);
    setFlag("reply", p > 0.4);
    setFlag("tabs", p > 0.6);
    setFlag("fold", p > 0.84);

    const ci = Math.min(4, Math.floor(p * 5));
    if (ci !== capIndex) {
      capIndex = ci;
      caps.forEach((c, i) => c.classList.toggle("is-on", i === ci));
    }
    ticks.forEach((t, i) => t.style.setProperty("--f", clamp(p * 5 - i).toFixed(3)));
  }

  /* ------------------------------------------------------------ Tour */
  const steps = $$(".step");
  const layers = $$("[data-layer]");
  const tourCanvas = $("#tour-screen .canvas");
  const wide = matchMedia("(min-width: 900px)");
  let active = -1;
  let inlineScreens = [];
  const layerWatcher = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const layer = e.target.querySelector(".layer");
      if (!layer) continue;
      if (e.isIntersecting) layer.classList.add("on", "play");
      else layer.classList.remove("play");
    }
  }, { threshold: 0.55 });

  function activate(i) {
    if (i === active) return;
    active = i;
    steps.forEach((s, k) => s.classList.toggle("is-on", k === i));
    layers.forEach((l, k) => {
      l.classList.toggle("on", k === i);
      l.classList.toggle("play", k === i);
    });
  }

  function setTourMode() {
    if (wide.matches) {
      inlineScreens.forEach((s) => { layerWatcher.unobserve(s); fitter.unobserve(s); });
      layers.forEach((l) => { l.classList.remove("on", "play"); tourCanvas.append(l); });
      inlineScreens.forEach((s) => s.remove());
      inlineScreens = [];
      active = -1;
      updateTour();
    } else {
      layers.forEach((l, k) => {
        l.classList.remove("on", "play");
        const s = document.createElement("div");
        s.className = "screen tour-scr";
        s.setAttribute("data-screen", "");
        const c = document.createElement("div");
        c.className = "canvas";
        c.append(l);
        s.append(c);
        steps[k].querySelector(".step-slot").append(s);
        inlineScreens.push(s);
        watchScreen(s);
        layerWatcher.observe(s);
      });
      steps.forEach((s) => s.classList.remove("is-on"));
      active = -1;
    }
  }

  function updateTour() {
    if (!wide.matches) return;
    const mid = window.innerHeight * 0.5;
    let best = 0, bestD = Infinity;
    steps.forEach((s, i) => {
      const r = s.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    activate(best);
  }

  setTourMode();
  wide.addEventListener("change", setTourMode);

  /* ------------------------------------------------------------ Scroll loop */
  let queued = false;
  const frame = () => {
    queued = false;
    nav.classList.toggle("is-scrolled", window.scrollY > 8);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.transform = `scaleX(${max > 0 ? clamp(window.scrollY / max) : 0})`;
    updateStory();
    updateTour();
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  frame();

  /* ------------------------------------------------------------ Looks */
  // Copied from ui/settings-core.js: [label, scheme, tint, ink, accent, orb].
  const LOOKS = [
    ["Aurora", "dark", ["#12141C", "#191B27"], "#F5F8FF", "#38BDF8", ["#22D3EE", "#6366F1", "#D946EF"]],
    ["Frost", "light", ["#F5F7FA", "#E8EDF3"], "#0B1528", "#0284C7", ["#38BDF8", "#0284C7", "#2563EB"]],
    ["Sunset", "dark", ["#211B1D", "#292120"], "#FFF5F2", "#FB7185", ["#FBBF24", "#FB7185", "#BE185D"]],
    ["Sakura", "light", ["#FAF6F7", "#F0E9EC"], "#260C1A", "#E11D48", ["#F472B6", "#E11D48", "#9D174D"]],
    ["Forest", "dark", ["#161E1B", "#1E2826"], "#F0FDF8", "#10B981", ["#34D399", "#10B981", "#0284C7"]],
    ["Graphite", "dark", ["#14161A", "#202227"], "#F8FAFC", "#E2E8F0", ["#F8FAFC", "#CBD5E1", "#64748B"]],
    ["Mono ink", "light", ["#F7F6F3", "#ECEBE7"], "#111111", "#161616", ["#6B6B6B", "#2B2B2B", "#000000"]],
    ["Candy", "light", ["#FAF7FA", "#ECEEF4"], "#23123A", "#B14CFF", ["#FFB14C", "#FF5FA2", "#7A5CFF"]],
    ["Nord", "dark", ["#242933", "#2E3440"], "#ECEFF4", "#81A1C1", ["#8FBCBB", "#81A1C1", "#5E81AC"]],
    ["Ember", "dark", ["#201715", "#2A1C18"], "#FFF4EE", "#F97316", ["#FDE68A", "#F97316", "#9A3412"]],
    ["Ocean", "dark", ["#0F1D26", "#152833"], "#EFFBFF", "#22B8CF", ["#99F6E4", "#22B8CF", "#155E75"]],
    ["Dusk", "dark", ["#1E1B2C", "#282338"], "#F6F2FF", "#A78BFA", ["#F0ABFC", "#A78BFA", "#5B21B6"]],
    ["Mocha", "dark", ["#241D19", "#2E2520"], "#FBF3EC", "#C8956C", ["#F2D8B8", "#C8956C", "#6F4A30"]],
    ["Slate", "dark", ["#1C2127", "#262C33"], "#F1F5F9", "#7E92AB", ["#CBD5E1", "#7E92AB", "#475569"]],
    ["Midnight", "dark", ["#0A0E1A", "#111728"], "#EEF2FF", "#818CF8", ["#93C5FD", "#6366F1", "#312E81"]],
    ["OLED black", "dark", ["#000000", "#050505"], "#FFFFFF", "#E5E5E5", ["#FFFFFF", "#A3A3A3", "#404040"]],
    ["Mint", "light", ["#EFF7F2", "#E2EFE8"], "#0C2A1E", "#059669", ["#6EE7B7", "#059669", "#065F46"]],
    ["Paper", "light", ["#F8F5EE", "#EFEADF"], "#2A2118", "#9A4522", ["#E0A070", "#9A4522", "#5F2A12"]],
    ["Sand", "light", ["#F2EBDD", "#E7DDCA"], "#2B2416", "#854D0E", ["#EAB308", "#A16207", "#713F12"]],
    ["Lavender", "light", ["#F3F0F9", "#E8E3F3"], "#221A38", "#6D28D9", ["#C4B5FD", "#7C3AED", "#4C1D95"]]
  ];
  const swatches = $("#swatches");
  const preview = $("#looks-preview");
  const nameEl = $("#swatch-name");
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (hex) => {
    const [r, g, b] = rgb(hex).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const onAccent = (hex) => { const l = lum(hex); return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#0b0c0e" : "#ffffff"; };
  const withAlpha = (hex, a) => `rgb(${rgb(hex).join(" ")} / ${a})`;

  function applyLook(i) {
    const [name, scheme, tint, ink, accent, orb] = LOOKS[i];
    const light = scheme === "light";
    const s = preview.style;
    const alpha = light ? 0.76 : 0.72;
    s.setProperty("--glass-a", withAlpha(tint[0], alpha));
    s.setProperty("--glass-b", withAlpha(tint[1], alpha));
    s.setProperty("--g-ink", ink);
    s.setProperty("--g-rim", light ? "rgb(15 23 42 / .13)" : "rgb(255 255 255 / .13)");
    s.setProperty("--g-spec", light ? "rgb(255 255 255 / .8)" : "rgb(255 255 255 / .16)");
    s.setProperty("--g-shadow", light ? "rgb(15 23 42 / .22)" : "rgb(0 0 0 / .42)");
    s.setProperty("--acc", accent);
    s.setProperty("--on", onAccent(accent));
    orb.forEach((c, k) => s.setProperty(`--o${k + 1}`, c));
    [...swatches.children].forEach((b, k) => {
      b.setAttribute("aria-checked", String(k === i));
      b.tabIndex = k === i ? 0 : -1;
    });
    nameEl.innerHTML = `Look &middot; <strong>${name}</strong>`;
  }

  if (swatches && preview) {
    LOOKS.forEach(([name, , , , , orb], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-label", name);
      b.title = name;
      b.style.setProperty("--sw", `linear-gradient(145deg, ${orb[0]}, ${orb[1]} 60%, ${orb[2]})`);
      b.addEventListener("click", () => applyLook(i));
      swatches.append(b);
    });
    swatches.addEventListener("keydown", (e) => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const items = [...swatches.children];
      const next = (items.indexOf(document.activeElement) + dir + items.length) % items.length;
      applyLook(next);
      items[next].focus();
    });
    applyLook(5);
  }

  /* ------------------------------------------------------------ Picker demo */
  // Segmented controls like the app's picker: provider, mode, effort. The bar's pill follows.
  const pk = $("#picker-demo");
  if (pk) {
    const state = { provider: "chatgpt", mode: "chat", effort: "Medium" };
    const NAMES = { chatgpt: "ChatGPT", gemini: "Gemini" };
    const note = $("#pk-note");
    const say = (text) => { note.textContent = text; note.classList.remove("pk-pop"); void note.offsetWidth; note.classList.add("pk-pop"); };
    const paintSeg = (seg) => {
      const buttons = $$("button", seg);
      const k = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
      const hl = $(".seg-hl", seg);
      hl.style.setProperty("--n", buttons.length);
      hl.style.setProperty("--k", Math.max(0, k));
      buttons.forEach((b, i) => { b.tabIndex = i === k ? 0 : -1; });
    };
    const render = () => {
      const work = state.provider === "gemini" ? "Task" : "Work";
      $(".pk-work", pk).textContent = work;
      const mark = $("#pk-mark");
      mark.className = `pmark ${state.provider === "gemini" ? "pm-gem" : "pm-gpt"}`;
      $("#pk-pill").textContent = state.mode === "work" ? work : state.effort;
      $("#pk-ph").textContent = state.mode === "work" ? `Give ${NAMES[state.provider]} a task` : `Ask ${NAMES[state.provider]}`;
      pk.dataset.provider = state.provider;
      pk.dataset.mode = state.mode;
      $$(".seg", pk).forEach(paintSeg);
    };
    const choose = (seg, button) => {
      const key = seg.dataset.seg;
      if (state[key] === button.dataset.v) return;
      $$("button", seg).forEach((b) => b.setAttribute("aria-checked", String(b === button)));
      state[key] = button.dataset.v;
      render();
      const work = state.provider === "gemini" ? "Task" : "Work";
      if (key === "provider") say(`Now chatting with ${NAMES[state.provider]}`);
      else if (key === "mode") say(state.mode === "work" ? `${work} mode · new chat, draft kept` : "Back to a normal chat");
      else say(`${state.effort} reasoning effort for this chat`);
    };
    $$(".seg", pk).forEach((seg) => {
      seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) choose(seg, b); });
      seg.addEventListener("keydown", (e) => {
        const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const buttons = $$("button", seg);
        const next = buttons[(buttons.findIndex((b) => b.getAttribute("aria-checked") === "true") + dir + buttons.length) % buttons.length];
        choose(seg, next);
        next.focus();
      });
    });
    render();
  }

  /* ------------------------------------------------------------ Slash menu demo */
  // The real command list from ui/app.js (COMMANDS), filtered by prefix the way the app does.
  const SLASH = [
    ["new", "Start a new chat"], ["temp", "Temporary chat"], ["chats", "Search all chats"],
    ["chatgpt", "Switch to ChatGPT"], ["gemini", "Switch to Gemini"], ["model", "Mode, effort and model"],
    ["find", "Find in conversation"], ["copy", "Copy conversation"], ["export", "Save as Markdown"],
    ["rename", "Rename this chat"], ["discard", "Discard unsent draft"], ["clear", "Clear recent chats"],
    ["signin", "Sign in or manage account"], ["settings", "Open settings"], ["startup", "Open at startup"],
    ["update", "Check for updates"], ["keys", "Keyboard shortcuts"], ["hide", "Hide QChat"]
  ];
  const DONE = {
    new: "Fresh chat. Your old one is a tab now.", temp: "Temporary chat, kept out of history.", chats: "All chats opens, ready to search.",
    chatgpt: "Now chatting with ChatGPT.", gemini: "Now chatting with Gemini.", model: "The picker pops open.",
    find: "The find bar slides in.", copy: "Conversation copied as Markdown.", export: "Saved to Downloads as Markdown.",
    rename: "Type a new name and press Enter.", discard: "Draft discarded. Undo for six seconds.", clear: "Tabs cleared. Undo for six seconds.",
    signin: "The sign-in window opens.", settings: "Settings opens beside the bar.", startup: "Open at startup: On.",
    update: "You're on the latest version.", keys: "Every shortcut, in a list.", hide: "Gone until you press Alt+Q."
  };
  const slashInput = $("#slash-input");
  const slashMenu = $("#slash-menu");
  const slashToast = $("#slash-toast");
  if (slashInput && slashMenu) {
    let matches = [], sel = 0, toastTimer = 0;
    const ROWS = 5;
    const paint = () => {
      const v = slashInput.value.trim().toLowerCase();
      const q = v.startsWith("/") ? v.slice(1) : null;
      matches = q === null ? [] : SLASH.filter(([n]) => n.startsWith(q));
      sel = Math.min(sel, Math.max(0, matches.length - 1));
      const start = Math.max(0, Math.min(sel - ROWS + 1, matches.length - ROWS));
      slashMenu.replaceChildren(...(matches.length ? matches.slice(start, start + ROWS).map(([n, d], i) => {
        const row = document.createElement("div");
        row.className = "mi";
        row.id = `slash-${n}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(start + i === sel));
        row.innerHTML = `<b>/${n}</b><span>${d}</span>`;
        row.addEventListener("mousedown", (e) => { e.preventDefault(); run(n); });
        row.addEventListener("mousemove", () => { if (sel !== start + i) { sel = start + i; paint(); } });
        return row;
      }) : [Object.assign(document.createElement("div"), { className: "mi-empty", textContent: q === null ? "Start with / to see commands" : "No command starts with that" })]));
      slashInput.setAttribute("aria-activedescendant", matches[sel] ? `slash-${matches[sel][0]}` : "");
    };
    const run = (n) => {
      slashToast.innerHTML = `<b>/${n}</b>&nbsp; ${DONE[n]}`;
      slashToast.classList.add("is-on");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => slashToast.classList.remove("is-on"), 2600);
      slashInput.value = "/";
      sel = 0;
      paint();
    };
    slashInput.addEventListener("input", () => { sel = 0; paint(); });
    slashInput.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
        e.preventDefault();
        sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        paint();
      } else if ((e.key === "Enter" || e.key === "Tab") && matches[sel]) {
        if (e.key === "Tab" && !slashInput.value.trim().startsWith("/")) return;
        e.preventDefault();
        run(matches[sel][0]);
      } else if (e.key === "Escape") {
        slashInput.value = "/"; sel = 0; paint();
      }
    });
    paint();
  }

  /* ------------------------------------------------------------ Download panel light */
  const panel = $(".dl-panel");
  if (panel && !reduce && matchMedia("(hover: hover)").matches) {
    panel.addEventListener("pointermove", (e) => {
      const r = panel.getBoundingClientRect();
      panel.style.setProperty("--mx", `${e.clientX - r.left}px`);
      panel.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }

  /* ------------------------------------------------------------ Release info */
  fetch("/api/release")
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel || !rel.version) return;
      const size = rel.size ? ` · ${(rel.size / 1048576).toFixed(1)} MB` : "";
      $$("[data-release-line]").forEach((el) => { el.textContent = `v${rel.version}${size}`; });
      if (rel.url) $$("[data-dl]").forEach((a) => { a.href = rel.url; });
    })
    .catch(() => {});
})();
