// Shared by the chat and settings windows: settings schema, load/save, and the mapping from
// settings to CSS. Loaded in <head>, so it applies the saved look before first paint.
(function () {
  "use strict";

  const STORAGE_KEY = "qchat.settings";
  const THEME_KEY = "qchat.theme";
  const LEGACY_LOOK_KEY = "qchat.look";
  const VERSION = 1;

  // ---------------------------------------------------------------------------
  // Looks. Everything else (fills, text tiers, rims) is derived in apply().
  // ---------------------------------------------------------------------------
  const LOOKS = {
    system: { label: "System", scheme: "auto" },
    aurora: {
      label: "Aurora", scheme: "dark", tint: ["#12141C", "#191B27"], ink: "#F5F8FF",
      accent: ["#22D3EE", "#38BDF8", "#818CF8"], edge: "#D946EF", accentText: "#67E8F9",
      orb: ["#22D3EE", "#6366F1", "#D946EF"], critical: "#F43F5E", criticalText: "#FDA4AF"
    },
    frost: {
      label: "Frost", scheme: "light", tint: ["#F5F7FA", "#E8EDF3"], ink: "#0B1528",
      accent: ["#0EA5E9", "#0284C7", "#2563EB"], edge: "#38BDF8", accentText: "#0369A1",
      orb: ["#38BDF8", "#0284C7", "#2563EB"], critical: "#DC2626", criticalText: "#B91C1C"
    },
    sunset: {
      label: "Sunset", scheme: "dark", tint: ["#211B1D", "#292120"], ink: "#FFF5F2",
      accent: ["#FB923C", "#FB7185", "#E11D48"], edge: "#FB923C", accentText: "#FDA4AF",
      orb: ["#FBBF24", "#FB7185", "#BE185D"], critical: "#EF4444", criticalText: "#FCA5A5"
    },
    sakura: {
      label: "Sakura", scheme: "light", tint: ["#FAF6F7", "#F0E9EC"], ink: "#260C1A",
      accent: ["#F43F5E", "#E11D48", "#BE185D"], edge: "#F472B6", accentText: "#BE123C",
      orb: ["#F472B6", "#E11D48", "#9D174D"], critical: "#DC2626", criticalText: "#B91C1C"
    },
    forest: {
      label: "Forest", scheme: "dark", tint: ["#161E1B", "#1E2826"], ink: "#F0FDF8",
      accent: ["#34D399", "#10B981", "#0D9488"], edge: "#2DD4BF", accentText: "#6EE7B7",
      orb: ["#34D399", "#10B981", "#0284C7"], critical: "#F43F5E", criticalText: "#FDA4AF"
    },
    graphite: {
      label: "Graphite", scheme: "dark", tint: ["#14161A", "#202227"], ink: "#F8FAFC",
      accent: ["#F8FAFC", "#E2E8F0", "#CBD5E1"], edge: "#94A3B8", accentText: "#F1F5F9",
      orb: ["#F8FAFC", "#CBD5E1", "#64748B"], critical: "#F43F5E", criticalText: "#FDA4AF"
    },
    ink: {
      label: "Mono ink", scheme: "light", tint: ["#F7F6F3", "#ECEBE7"], ink: "#111111",
      accent: ["#2B2B2B", "#161616", "#000000"], edge: "#6B6B6B", accentText: "#111111",
      orb: ["#6B6B6B", "#2B2B2B", "#000000"], critical: "#C81E1E", criticalText: "#A61B1B"
    },
    candy: {
      label: "Candy", scheme: "light", tint: ["#FAF7FA", "#ECEEF4"], ink: "#23123A",
      accent: ["#FF5FA2", "#B14CFF", "#4C7DFF"], edge: "#46D5FF", accentText: "#8A1FD6",
      orb: ["#FFB14C", "#FF5FA2", "#7A5CFF"], critical: "#E11D48", criticalText: "#BE123C"
    }
  };

  const SYSTEM_DARK = {
    scheme: "dark", tint: ["#181B22", "#23262D"], ink: "#F8FAFC", edge: "#429CE3",
    critical: "#F43F5E", criticalText: "#FDA4AF"
  };
  const SYSTEM_LIGHT = {
    scheme: "light", tint: ["#F8FAFC", "#ECEFF3"], ink: "#0F172A", edge: "#429CE3",
    critical: "#DC2626", criticalText: "#B91C1C"
  };
  const DEFAULT_THEME = { accent: "#0078D4", accentLight1: "#429CE3", accentLight2: "#8AC8F0", accentDark1: "#005A9E" };

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  const range = (def, min, max, step = 1, unit = "") => ({ type: "range", def, min, max, step, unit });
  const choice = (def, options) => ({ type: "enum", def, options });
  const bool = (def) => ({ type: "bool", def });

  const SCHEMA = {
    look: choice("aurora", Object.keys(LOOKS)),
    accentSource: choice("look", ["look", "system", "custom"]),
    accentColor: { type: "color", def: "#7C5CFF" },
    bubbleTint: range(60, 0, 100, 1, "%"),
    saturation: range(100, 0, 200, 5, "%"),

    cornerWeight: range(85, 0, 100, 1, "%"),
    glassOpacity: range(72, 20, 100, 1, "%"),
    nativeBlur: bool(true),
    blur: range(18, 0, 40, 1, "px"),
    rim: range(60, 0, 100, 1, "%"),
    sheen: range(50, 0, 100, 1, "%"),
    shadow: range(55, 0, 100, 1, "%"),
    border: range(1, 0, 2, 0.25, "px"),

    animations: choice("auto", ["auto", "on", "off"]),
    speed: range(1, 0.4, 2, 0.1, "×"),
    feel: choice("springy", ["smooth", "springy", "snappy"]),
    riseDistance: range(30, 0, 60, 1, "px"),
    tabPop: bool(true),
    shimmer: bool(false),

    textSize: range(14, 12, 20, 0.5, "px"),
    fontFamily: choice("segoe", ["segoe", "system", "serif", "rounded", "mono"]),
    lineHeight: range(1.6, 1.2, 2, 0.05),
    justify: bool(false),

    barWidth: range(460, 340, 720, 10, "px"),
    maxHeightPct: range(60, 30, 90, 1, "%"),
    density: choice("cozy", ["compact", "cozy", "roomy"]),
    showTabs: bool(true),
    showTabClock: bool(true),
    showSuggestions: bool(false),
    showStatusDot: bool(true),

    rememberPosition: bool(true),
    alwaysOnTop: bool(true),
    hideOnBlur: bool(false),
    sendKey: choice("enter", ["enter", "ctrl"]),
    autoDismiss: range(0, 0, 120, 5, "s"),

    keepHistory: bool(true)
  };

  const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.def])));
  const isHex = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

  function sanitizeValue(key, value) {
    const spec = SCHEMA[key];
    if (!spec) return undefined;
    switch (spec.type) {
      case "range": {
        const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
        if (!Number.isFinite(num)) return spec.def;
        const clamped = Math.min(spec.max, Math.max(spec.min, num));
        return Number((Math.round((clamped - spec.min) / spec.step) * spec.step + spec.min).toFixed(4));
      }
      case "enum": return spec.options.includes(value) ? value : spec.def;
      case "bool": return typeof value === "boolean" ? value : spec.def;
      case "color": return isHex(value) ? value.toUpperCase() : spec.def;
      default: return spec.def;
    }
  }

  function sanitize(raw) {
    const out = {};
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    for (const key of Object.keys(SCHEMA)) out[key] = sanitizeValue(key, source[key]);
    return out;
  }

  function legacyLook() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LEGACY_LOOK_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return {};
      const glass = Number(parsed.glass);
      return { look: parsed.look, glassOpacity: Number.isFinite(glass) ? Math.round(glass * 100) : undefined };
    } catch (_) { return {}; }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return sanitize(legacyLook());
      const parsed = JSON.parse(raw);
      return sanitize(parsed.v === undefined || parsed.v === VERSION ? parsed : {});
    } catch (_) {
      return sanitize({});
    }
  }

  function save(settings) {
    const clean = sanitize(settings);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, ...clean })); } catch (_) {}
    return clean;
  }

  // ---------------------------------------------------------------------------
  // Colour helpers (sRGB triples)
  // ---------------------------------------------------------------------------
  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const rgbToHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  const triple = (rgb) => rgb.map((c) => Math.round(c)).join(" ");
  const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
  const over = (fg, alpha, bg) => mix(bg, fg, alpha);

  function luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToRgb([h, s, l]) {
    h = ((h % 360) + 360) % 360;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255;
    };
    return [f(0), f(8), f(4)];
  }
  function saturate(rgb, factor) {
    if (factor === 1) return rgb;
    const [h, s, l] = rgbToHsl(rgb);
    return hslToRgb([h, Math.min(1, s * factor), l]);
  }
  function shift(rgb, hue, light) {
    const [h, s, l] = rgbToHsl(rgb);
    return hslToRgb([h + hue, s, Math.min(0.92, Math.max(0.08, l + light))]);
  }
  // Moves `color` towards `target` until it reads at 4.5:1 on every backdrop.
  function readable(color, target, backdrops, ratio = 4.6) {
    for (let t = 0; t <= 1; t += 0.05) {
      const c = mix(color, target, t);
      if (backdrops.every((b) => contrast(c, b) >= ratio)) return c;
    }
    return target;
  }

  // Lowest fill alpha at which primary and secondary text stay legible over any wallpaper.
  function legibleFloor(tints, ink) {
    const backs = [[255, 255, 255], [0, 0, 0]];
    for (let a = 0.3; a < 1; a += 0.01) {
      const ok = tints.every((tint) => backs.every((back) => {
        const fill = over(tint, a, back);
        return contrast(ink, fill) >= 4.6 && contrast(over(ink, TEXT_2, fill), fill) >= 4.6;
      }));
      if (ok) return Math.min(1, a + 0.02);
    }
    return 0.98;
  }
  const TEXT_2 = 0.86;

  // ---------------------------------------------------------------------------
  // Motion
  // ---------------------------------------------------------------------------
  function springCurve() {
    const stops = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      stops.push(i === n ? "1" : (1 - Math.exp(-5.4 * t) * Math.cos(2 * Math.PI * 1.3 * t)).toFixed(4));
    }
    return `linear(${stops.join(", ")})`;
  }
  const EASES = {
    smooth: "cubic-bezier(0.22, 0.8, 0.2, 1)",
    springy: springCurve(),
    snappy: "cubic-bezier(0.16, 1, 0.3, 1)"
  };
  const FEEL_SCALE = { smooth: 1.1, springy: 1, snappy: 0.68 };
  const BASE_MS = { t1: 120, t2: 200, t3: 300, t4: 560 };
  const FONTS = {
    segoe: '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
    system: "system-ui, -apple-system, sans-serif",
    serif: '"Iowan Old Style", Constantia, Cambria, Georgia, serif',
    rounded: 'ui-rounded, "Nunito", "Varela Round", Bahnschrift, "Segoe UI Variable Text", sans-serif',
    mono: '"Cascadia Mono", "Cascadia Code", Consolas, monospace'
  };
  const BAR_HEIGHT = { compact: 38, cozy: 44, roomy: 50 };

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------
  const env = { theme: null };
  try {
    const cached = JSON.parse(localStorage.getItem(THEME_KEY) || "null");
    if (cached && typeof cached === "object") env.theme = cached;
  } catch (_) {}
  const media = (q) => window.matchMedia(q);
  const reducedMotion = media("(prefers-reduced-motion: reduce)");
  const reducedTransparency = media("(prefers-reduced-transparency: reduce)");
  const darkScheme = media("(prefers-color-scheme: dark)");

  const state = { settings: load(), timings: { t1: 120, t2: 200, t3: 300, t4: 560 }, motionOn: true, barHeight: 52 };

  // ---------------------------------------------------------------------------
  // settings -> CSS custom properties and data attributes
  // ---------------------------------------------------------------------------
  function resolvePalette(s) {
    const theme = { ...DEFAULT_THEME, ...(env.theme || {}) };
    for (const key of Object.keys(DEFAULT_THEME)) if (!isHex(theme[key])) theme[key] = DEFAULT_THEME[key];
    const sysDark = typeof theme.dark === "boolean" ? theme.dark : darkScheme.matches;
    const isSystem = s.look === "system";
    const base = isSystem ? (sysDark ? SYSTEM_DARK : SYSTEM_LIGHT) : LOOKS[s.look];
    const dark = base.scheme === "dark";

    const fromSystem = dark
      ? [theme.accentLight2, theme.accentLight1, theme.accent]
      : [theme.accentLight1, theme.accent, theme.accentDark1];
    let accent;
    if (s.accentSource === "custom") {
      const c = hexToRgb(s.accentColor);
      accent = [shift(c, -12, 0.07), c, shift(c, 16, -0.05)];
    } else if (s.accentSource === "system" || isSystem) {
      accent = fromSystem.map(hexToRgb);
    } else {
      accent = base.accent.map(hexToRgb);
    }
    const customAccent = s.accentSource !== "look" || isSystem;
    const orb = customAccent
      ? [shift(accent[1], -18, 0.1), accent[1], shift(accent[2], 28, -0.08)]
      : base.orb.map(hexToRgb);

    const sat = s.saturation / 100;
    return {
      dark,
      ink: hexToRgb(base.ink),
      tint: base.tint.map((c) => saturate(hexToRgb(c), Math.min(sat, 1.5))),
      accent: accent.map((c) => saturate(c, sat)),
      orb: orb.map((c) => saturate(c, sat)),
      edge: saturate(customAccent ? shift(accent[2], 24, 0.06) : hexToRgb(base.edge), sat),
      accentText: saturate(customAccent ? accent[dark ? 0 : 2] : hexToRgb(base.accentText), sat),
      critical: hexToRgb(base.critical),
      criticalText: hexToRgb(base.criticalText)
    };
  }

  function apply(root = document.documentElement, raw = state.settings) {
    const s = sanitize(raw);
    const css = {};
    const p = resolvePalette(s);
    const lessGlass = reducedTransparency.matches;

    // --- Material -----------------------------------------------------------
    const floor = legibleFloor(p.tint, p.ink);
    const alpha = Math.max(s.glassOpacity / 100, lessGlass ? 0.96 : floor);
    const textAlpha = alpha;
    const backdrops = p.tint.flatMap((t) => [over(t, alpha, [255,255,255]), over(t, alpha, [0,0,0])]);
    root.dataset.nativeblur = s.nativeBlur ? "on" : "off";
    const tintArgb = (((p.dark ? 0x55 : 0x66) << 24) | (Math.round(p.tint[0][0]) << 16) | (Math.round(p.tint[0][1]) << 8) | Math.round(p.tint[0][2])) >>> 0;
    window.QSurfaces?.setBlur(s.nativeBlur, tintArgb)?.catch(() => {});

    css["--tint-a"] = triple(p.tint[0]);
    css["--tint-b"] = triple(p.tint[1]);
    css["--glass-a"] = alpha.toFixed(3);
    css["--glass-scrim"] = "0";
    css["--glass-solid"] = textAlpha.toFixed(3);
    css["--blur"] = `${lessGlass ? 0 : s.blur}px`;
    css["--bw"] = `${s.border}px`;

    const rim = s.rim / 100, sheen = s.sheen / 100, shadow = s.shadow / 100;
    css["--rim-ink"] = p.dark ? "255 255 255" : "15 23 42";
    css["--rim-alpha"] = (0.13 * rim / 0.6).toFixed(3);
    css["--specular"] = ((p.dark ? 0.16 : 0.8) * sheen / 0.5).toFixed(3);
    css["--shadow-ink"] = p.dark ? "0 0 0" : "15 23 42";
    css["--material-shadow"] = `0 10px 26px -8px rgb(var(--shadow-ink) / ${Math.min(.65, (p.dark ? .42 : .21) * shadow / .55)}), 0 1px 2px rgb(var(--shadow-ink) / ${Math.min(.35, (p.dark ? .22 : .11) * shadow / .55)})`;
    css["--rim-top"] = ((p.dark ? 0.5 : 0.95) * rim).toFixed(3);
    css["--rim-bottom"] = ((p.dark ? 0.14 : 0.36) * rim).toFixed(3);
    css["--edge-hi"] = ((p.dark ? 0.62 : 0.95) * rim).toFixed(3);
    css["--edge-accent"] = ((p.dark ? 0.38 : 0.42) * rim).toFixed(3);
    css["--edge-lo"] = ((p.dark ? 0.12 : 0.3) * rim).toFixed(3);
    css["--sheen-a"] = ((p.dark ? 0.2 : 0.55) * sheen).toFixed(3);
    css["--sheen-b"] = ((p.dark ? 0.1 : 0.3) * sheen).toFixed(3);
    // Offset + blur - spread stays within the 28px gutter at full strength.
    css["--shadow-y"] = `${(2 + 8 * shadow).toFixed(1)}px`;
    css["--shadow-r"] = `${(6 + 16 * shadow).toFixed(1)}px`;
    css["--shadow-a"] = ((p.dark ? 0.62 : 0.34) * shadow).toFixed(3);
    css["--shadow-b"] = ((p.dark ? 0.32 : 0.18) * shadow).toFixed(3);

    // --- Colour -------------------------------------------------------------
    css["--ink"] = triple(p.ink);
    css["--accent-1"] = rgbToHex(p.accent[0]);
    css["--accent-2"] = rgbToHex(p.accent[1]);
    css["--accent-3"] = rgbToHex(p.accent[2]);
    css["--accent-rgb"] = triple(p.accent[1]);
    css["--edge-rgb"] = triple(p.edge);
    css["--orb-1"] = rgbToHex(p.orb[0]);
    css["--orb-2"] = rgbToHex(p.orb[1]);
    css["--orb-3"] = rgbToHex(p.orb[2]);
    const white = [255, 255, 255], black = [10, 12, 18];
    const lowest = (ink) => Math.min(...p.accent.map((c) => contrast(ink, c)));
    css["--on-accent"] = triple(lowest(white) >= lowest(black) ? white : black);
    css["--accent-text"] = rgbToHex(readable(p.accentText, p.ink, backdrops));
    css["--critical-text"] = rgbToHex(readable(p.criticalText, p.ink, backdrops));
    css["--critical-rgb"] = triple(p.critical);

    // User and error bubbles: as much tint as the text can bear.
    const tintAlpha = Math.max(textAlpha, 0.86);
    css["--tinted-alpha"] = tintAlpha.toFixed(3);
    const strength = (s.bubbleTint / 100) * 0.28;
    const tinted = (color, wanted) => {
      for (let x = wanted; x > 0; x -= 0.02) {
        const pair = [mix(p.tint[0], color[0], x), mix(p.tint[1], color[1], x)];
        const fine = pair.every((fill) => [[255, 255, 255], [0, 0, 0]].every((b) => {
          const composed = over(fill, tintAlpha, b);
          return contrast(p.ink, composed) >= 4.6 && contrast(over(p.ink, TEXT_2, composed), composed) >= 4.6;
        }));
        if (fine) return pair;
      }
      return p.tint;
    };
    const user = tinted([p.accent[0], p.accent[2]], strength);
    css["--user-a"] = triple(user[0]);
    css["--user-b"] = triple(user[1]);
    const error = p.tint;
    css["--error-a"] = triple(error[0]);
    css["--error-b"] = triple(error[1]);
    css["--glow"] = ((0.04 + 0.12 * (s.bubbleTint / 100))).toFixed(3);

    // --- Shape: one weight drives every radius -------------------------------
    const t = s.cornerWeight / 100;
    const round = Math.min(1, t / 0.75);
    const barHeight = BAR_HEIGHT[s.density];
    const control = barHeight - 14;
    css["--r-bar"] = `${(6 + round * (barHeight / 2 - 6)).toFixed(1)}px`;
    css["--r-bubble"] = `${(t <= .85 ? 6 + t * (14 / .85) : 20 + (t - .85) * 80).toFixed(1)}px`;
    css["--r-chip"] = `${(6 + round * 6).toFixed(1)}px`;
    css["--r-tab"] = `${(5 + t * (4 / .85)).toFixed(1)}px`;
    css["--r-inner"] = `${(4 + t * 10).toFixed(1)}px`;
    css["--r-control"] = `${(4 + round * (control / 2 - 4)).toFixed(1)}px`;
    css["--bar-h"] = `${barHeight}px`;
    css["--control"] = `${control}px`;
    css["--bar-w"] = `${s.barWidth}px`;

    // --- Motion --------------------------------------------------------------
    const motionOn = s.animations === "on" || (s.animations === "auto" && !reducedMotion.matches);
    const scale = FEEL_SCALE[s.feel] / s.speed;
    const timings = {};
    for (const [key, ms] of Object.entries(BASE_MS)) timings[key] = motionOn ? Math.round(ms * scale) : 1;
    for (const [key, ms] of Object.entries(timings)) css[`--${key}`] = `${ms}ms`;
    css["--speed"] = String(s.speed);
    css["--ease-move"] = EASES[s.feel];
    css["--rise"] = `${s.riseDistance}px`;

    // --- Type ----------------------------------------------------------------
    css["--text-size"] = `${s.textSize}px`;
    css["--line-h"] = String(s.lineHeight);
    css["--font-body"] = FONTS[s.fontFamily];

    for (const [name, value] of Object.entries(css)) root.style.setProperty(name, value);
    root.style.colorScheme = p.dark ? "dark" : "light";

    const data = root.dataset;
    data.motion = motionOn ? "on" : "off";
    data.tabpop = String(s.tabPop);
    data.shimmer = String(s.shimmer);
    data.tabclock = String(s.showTabClock);
    data.statusdot = String(s.showStatusDot);
    data.justify = String(s.justify);

    state.settings = s;
    state.timings = timings;
    state.motionOn = motionOn;
    state.barHeight = barHeight;
    return s;
  }

  function setTheme(theme) {
    env.theme = theme && typeof theme === "object" ? theme : null;
    try { localStorage.setItem(THEME_KEY, JSON.stringify(env.theme)); } catch (_) {}
    return apply();
  }

  // Follows OS preferences live; `then` lets a page react to the re-apply.
  function watchEnvironment(then) {
    for (const query of [reducedMotion, reducedTransparency, darkScheme]) {
      query.addEventListener("change", () => { apply(); if (then) then(state.settings); });
    }
  }

  apply();

  window.QSettings = {
    STORAGE_KEY, VERSION, SCHEMA, DEFAULTS, LOOKS,
    get settings() { return state.settings; },
    get timings() { return state.timings; },
    get motionOn() { return state.motionOn; },
    get barHeight() { return state.barHeight; },
    load, save, sanitize, sanitizeValue, apply, setTheme, watchEnvironment,
    swatch(key) {
      const look = LOOKS[key];
      if (look.tint) return { tint: look.tint, orb: look.orb };
      return { tint: [SYSTEM_LIGHT.tint[0], SYSTEM_DARK.tint[1]], orb: [DEFAULT_THEME.accentLight1, DEFAULT_THEME.accent, DEFAULT_THEME.accentDark1] };
    }
  };
})();
