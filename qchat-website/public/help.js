// QChat help page: canvas fitting, the scroll progress line, the table of contents,
// the shortcut and command filter, the shortcut tester, the bar diagram and live release info.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ Canvas fitting */
  const fit = (screen) => {
    const canvas = screen.querySelector(":scope > .canvas");
    const cw = parseFloat(getComputedStyle(screen).getPropertyValue("--cw")) || 1200;
    if (canvas) canvas.style.setProperty("--s", screen.clientWidth / cw);
  };
  const fitter = new ResizeObserver((entries) => entries.forEach((e) => fit(e.target)));
  $$("[data-screen]").forEach((s) => { fit(s); fitter.observe(s); });

  /* ------------------------------------------------------------ Smooth anchors */
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const el = a.getAttribute("href").length > 1 && document.querySelector(a.getAttribute("href"));
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    history.replaceState(null, "", a.getAttribute("href"));
  });

  /* ------------------------------------------------------------ Progress and table of contents */
  const bar = $("#nav-progress");
  const links = new Map($$("#toc a").map((a) => [a.getAttribute("href").slice(1), a]));
  const sections = $$(".hs");
  let current = null;
  const frame = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
    let id = sections[0]?.id;
    for (const s of sections) if (s.getBoundingClientRect().top < innerHeight * 0.3) id = s.id;
    if (id !== current) {
      current = id;
      links.forEach((a, k) => a.classList.toggle("is-on", k === id));
    }
  };
  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  frame();

  /* ------------------------------------------------------------ Filter */
  const input = $("#help-filter");
  const count = $("#help-count");
  const rows = $$(".kb-row, .cmd-row");
  const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  rows.forEach((r) => { r.dataset.text = norm(`${r.textContent} ${r.dataset.keys || ""}`); });

  function applyFilter() {
    const q = norm(input.value);
    let shown = 0;
    rows.forEach((r) => {
      const hit = !q || q.split(" ").every((w) => r.dataset.text.includes(w));
      r.hidden = !hit;
      if (hit) shown++;
    });
    $$("[data-filter-group]").forEach((g) => { g.hidden = !$$(".kb-row:not([hidden]), .cmd-row:not([hidden])", g).length; });
    $$("#shortcuts, #commands").forEach((s) => {
      const empty = $(".filter-empty", s);
      if (empty) empty.hidden = !!$$("[data-filter-group]:not([hidden])", s).length;
    });
    count.textContent = q ? `${shown} of ${rows.length} shortcuts and commands` : "";
  }
  if (input) {
    input.addEventListener("input", applyFilter);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { input.value = ""; applyFilter(); input.blur(); }
      if (e.key === "Enter") { e.preventDefault(); $(".kb-row:not([hidden]), .cmd-row:not([hidden])")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" }); }
    });
    // "/" focuses the filter, just like it opens commands in the app.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.("input, textarea, [contenteditable], #tester")) return;
      e.preventDefault();
      input.focus();
      input.select();
    });
  }

  /* ------------------------------------------------------------ Shortcut tester */
  const tester = $("#tester");
  const out = $("#tester-keys");
  const KEYNAME = { " ": "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", PageUp: "PgUp", PageDown: "PgDn" };
  let clearTimer = 0;
  const lit = new Set();

  function comboOf(e) {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    return [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", key].filter(Boolean).join("+");
  }
  function show(e) {
    const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", KEYNAME[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key)].filter(Boolean);
    out.replaceChildren(...parts.map((p, i) => {
      const k = document.createElement("kbd");
      k.textContent = p;
      k.style.setProperty("--i", i);
      return k;
    }));
  }
  function light(combo) {
    lit.forEach((r) => r.classList.remove("is-hit"));
    lit.clear();
    const match = $$(".kb-row").filter((r) => (r.dataset.keys || "").split(" ").includes(combo));
    match.forEach((r) => { r.classList.add("is-hit"); lit.add(r); });
    const label = document.createElement("span");
    label.className = "tester-what";
    label.textContent = match.length ? match[0].querySelector("dd").firstChild.textContent.trim() : "Not a QChat shortcut";
    if (!match.length) label.classList.add("is-miss");
    out.append(label);
    if (match[0]) {
      const r = match[0].getBoundingClientRect();
      if (r.top < 80 || r.bottom > innerHeight) match[0].scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    }
  }
  if (tester) {
    tester.addEventListener("keydown", (e) => {
      if (["Control", "Alt", "Shift", "Meta", "Tab"].includes(e.key)) return;
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && out.dataset.last === "escape") { tester.blur(); return; }
      e.preventDefault();
      const combo = comboOf(e);
      out.dataset.last = combo;
      show(e);
      light(combo);
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { lit.forEach((r) => r.classList.remove("is-hit")); lit.clear(); }, 2600);
    });
    tester.addEventListener("click", () => tester.focus());
  }

  /* ------------------------------------------------------------ Bar diagram */
  const anatomy = $("#bar-map");
  // Each numbered pin sits just above (tabs) or below (bar) the part it names, in canvas pixels.
  const placePins = () => {
    if (!anatomy) return;
    const c = anatomy.getBoundingClientRect();
    const s = c.width / anatomy.offsetWidth || 1;
    $$("[data-pin]", anatomy).forEach((pin) => {
      const parts = $$(`[data-part="${pin.dataset.pin}"]`, anatomy);
      const r = parts[0].getBoundingClientRect();
      const inTabs = parts[0].closest(".tabs");
      const right = parts[parts.length - 1].getBoundingClientRect().right;
      pin.style.setProperty("--px", `${((r.left + right) / 2 - c.left) / s}px`);
      const edge = inTabs ? r.top - 20 * s : parts[0].closest(".bar").getBoundingClientRect().bottom + 24 * s;
      pin.style.setProperty("--py", `${(edge - c.top) / s}px`);
    });
  };
  if (anatomy) new ResizeObserver(() => requestAnimationFrame(placePins)).observe(anatomy.parentElement);
  document.fonts?.ready.then(placePins);
  const setPart = (n) => {
    if (!anatomy) return;
    anatomy.dataset.part = n || "";
    $$("[data-part]", anatomy).forEach((el) => el.classList.toggle("is-part", el.dataset.part === n));
    $$("[data-pin]", anatomy).forEach((el) => el.classList.toggle("is-part", el.dataset.pin === n));
    $$("#legend li").forEach((el) => el.classList.toggle("is-part", el.dataset.part === n));
  };
  $$("#legend li").forEach((li) => {
    li.tabIndex = 0;
    li.addEventListener("mouseenter", () => setPart(li.dataset.part));
    li.addEventListener("focus", () => setPart(li.dataset.part));
    li.addEventListener("mouseleave", () => setPart(""));
    li.addEventListener("blur", () => setPart(""));
  });
  $$("[data-pin]").forEach((pin) => {
    pin.addEventListener("mouseenter", () => setPart(pin.dataset.pin));
    pin.addEventListener("mouseleave", () => setPart(""));
  });

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
