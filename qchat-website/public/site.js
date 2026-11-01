// Release details and the look picker. Both are progressive: the page reads fine without them.
(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Latest release: version and size next to the download buttons.
  // -------------------------------------------------------------------------
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  const date = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  fetch("/api/release", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      if (!rel?.version) return;
      for (const el of document.querySelectorAll("[data-release-meta]")) {
        el.textContent = `Free · v${rel.version}${rel.size ? ` · ${mb(rel.size)}` : ""} · Windows 10 & 11 x64`;
      }
      for (const el of document.querySelectorAll("[data-release-detail]")) {
        const bits = [`Version ${rel.version}`];
        if (rel.publishedAt) bits.push(`released ${date(rel.publishedAt)}`);
        if (rel.size) bits.push(`${mb(rel.size)} installer`);
        el.textContent = `${bits.join(" · ")}. Windows 11 or Windows 10 22H2, x64.`;
      }
      if (rel.page) for (const el of document.querySelectorAll("[data-release-link]")) el.href = rel.page;
      if (rel.url) for (const el of document.querySelectorAll("[data-download]")) el.href = rel.url;
    })
    .catch(() => {});

  // -------------------------------------------------------------------------
  // Look picker. Values are QChat's own looks (ui/settings-core.js).
  // -------------------------------------------------------------------------
  const LOOKS = [
    ["Aurora", "dark", ["#12141C", "#191B27"], "#F5F8FF", ["#22D3EE", "#38BDF8", "#818CF8"], ["#22D3EE", "#6366F1", "#D946EF"]],
    ["Frost", "light", ["#F5F7FA", "#E8EDF3"], "#0B1528", ["#0EA5E9", "#0284C7", "#2563EB"], ["#38BDF8", "#0284C7", "#2563EB"]],
    ["Sunset", "dark", ["#211B1D", "#292120"], "#FFF5F2", ["#FB923C", "#FB7185", "#E11D48"], ["#FBBF24", "#FB7185", "#BE185D"]],
    ["Forest", "dark", ["#161E1B", "#1E2826"], "#F0FDF8", ["#34D399", "#10B981", "#0D9488"], ["#34D399", "#10B981", "#0284C7"]],
    ["Midnight", "dark", ["#0A0E1A", "#111728"], "#EEF2FF", ["#93C5FD", "#818CF8", "#4F46E5"], ["#93C5FD", "#6366F1", "#312E81"]],
    ["Sakura", "light", ["#FAF6F7", "#F0E9EC"], "#260C1A", ["#F43F5E", "#E11D48", "#BE185D"], ["#F472B6", "#E11D48", "#9D174D"]],
    ["Paper", "light", ["#F8F5EE", "#EFEADF"], "#2A2118", ["#B4532A", "#9A4522", "#7C3618"], ["#E0A070", "#9A4522", "#5F2A12"]],
    ["OLED black", "dark", ["#000000", "#050505"], "#FFFFFF", ["#FFFFFF", "#E5E5E5", "#A3A3A3"], ["#FFFFFF", "#A3A3A3", "#404040"]]
  ];

  const swatches = document.getElementById("swatches");
  const preview = document.getElementById("looks-preview");
  if (!swatches || !preview) return;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const triple = (hex) => rgb(hex).join(" ");
  const luminance = (hex) => {
    const [r, g, b] = rgb(hex).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // Black or white on the accent, whichever reads better.
  const onAccent = (hex) => { const l = luminance(hex); return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#06121a" : "#ffffff"; };

  const label = document.createElement("p");
  label.className = "swatch-name";
  label.setAttribute("aria-live", "polite");
  swatches.after(label);

  function apply(index) {
    const [name, scheme, tint, ink, accent, orb] = LOOKS[index];
    const s = preview.style;
    s.setProperty("--lp-tint-a", triple(tint[0]));
    s.setProperty("--lp-tint-b", triple(tint[1]));
    s.setProperty("--lp-ink", triple(ink));
    s.setProperty("--lp-alpha", scheme === "light" ? "0.74" : "0.68");
    s.setProperty("--lp-rim", scheme === "light" ? "15 23 42" : "255 255 255");
    accent.forEach((c, i) => s.setProperty(`--lp-a${i + 1}`, c));
    orb.forEach((c, i) => s.setProperty(`--lp-o${i + 1}`, c));
    s.setProperty("--lp-on", onAccent(accent[1]));
    for (const [i, b] of [...swatches.children].entries()) {
      b.setAttribute("aria-checked", String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    }
    label.innerHTML = `Look &middot; <strong>${name}</strong>`;
  }

  LOOKS.forEach(([name, , , , , orb], i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", name);
    b.style.setProperty("--sw", `radial-gradient(60% 50% at 34% 24%, rgb(255 255 255 / .7), transparent), linear-gradient(145deg, ${orb[0]}, ${orb[1]} 62%, ${orb[2]})`);
    b.addEventListener("click", () => apply(i));
    swatches.append(b);
  });

  // Arrow keys move through the radio group.
  swatches.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const items = [...swatches.children];
    const next = (items.indexOf(document.activeElement) + dir + items.length) % items.length;
    apply(next);
    items[next].focus();
  });

  apply(0);
})();
