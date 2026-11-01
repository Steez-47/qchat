// Motion core shared by the story and the tour scenes.
//  - Lenis smooths wheel scrolling (touch stays native).
//  - scrub() maps a pinned section's scroll position to progress 0..1 and repaints it,
//    with a short time-based damping so even keyboard and scrollbar jumps glide.
//  - Reveals and word-split headings animate in once as they enter the viewport.
(() => {
  "use strict";

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const QS = (window.QS = {
    reduce,
    clamp,
    seg: (p, a, b) => clamp((p - a) / (b - a)),
    lerp: (a, b, t) => a + (b - a) * t,
    ease: {
      out: (t) => 1 - Math.pow(1 - t, 3),
      outQuint: (t) => 1 - Math.pow(1 - t, 5),
      inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
      back: (t) => { const c = 1.3; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
    },
    lenis: null
  });

  // ---------------------------------------------------------------------------
  // Smooth scrolling
  // ---------------------------------------------------------------------------
  if (window.Lenis && !reduce.matches) {
    QS.lenis = new window.Lenis({
      autoRaf: true,
      lerp: 0.085,
      wheelMultiplier: 0.9,
      anchors: { offset: 0 },
      stopInertiaOnNavigate: true
    });
  }

  // ---------------------------------------------------------------------------
  // Scrub engine
  // ---------------------------------------------------------------------------
  const scrubs = [];
  let frame = 0, lastTime = 0;

  QS.scrub = (section, { paint, measure, near }) => {
    const s = { section, paint, measure, near, target: 0, current: -1, top: 0, height: 0, isNear: false };
    scrubs.push(s);
    layout(s);
    s.current = s.target = progressOf(s);
    measure?.();
    s.painted = s.current;
    paint(s.current);
    return s;
  };

  function layout(s) {
    const rect = s.section.getBoundingClientRect();
    s.top = rect.top + window.scrollY;
    s.height = s.section.offsetHeight;
  }
  function progressOf(s) {
    const range = s.height - window.innerHeight;
    return range > 0 ? clamp((window.scrollY - s.top) / range) : 0;
  }

  function tick(now) {
    frame = 0;
    const dt = Math.min(64, lastTime ? now - lastTime : 16);
    lastTime = now;
    // With Lenis already easing the scroll, a light damping is enough.
    const k = reduce.matches ? 1 : 1 - Math.exp(-dt / (QS.lenis ? 45 : 90));
    let moving = false;
    for (const s of scrubs) {
      if (s.current === s.target && s.painted === s.current) continue;
      const diff = s.target - s.current;
      s.current = Math.abs(diff) < 0.0003 ? s.target : s.current + diff * k;
      if (s.current !== s.target) moving = true;
      if (s.painted !== s.current) { s.painted = s.current; s.paint(s.current); }
    }
    if (moving) frame = requestAnimationFrame(tick);
    else lastTime = 0;
  }

  function onScroll() {
    const y = window.scrollY, vh = window.innerHeight;
    for (const s of scrubs) {
      s.target = progressOf(s);
      const near = y + vh * 1.2 > s.top && y < s.top + s.height + vh * 0.2;
      if (near !== s.isNear) { s.isNear = near; s.near?.(near); }
    }
    const doc = document.documentElement;
    nav?.style.setProperty("--page", (y / Math.max(1, doc.scrollHeight - vh)).toFixed(4));
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function onResize() {
    for (const s of scrubs) { layout(s); s.measure?.(); s.current = -1; }
    onScroll();
    for (const s of scrubs) { s.current = s.painted = s.target; s.paint(s.current); }
  }

  const nav = document.querySelector(".nav");
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  if (document.fonts?.ready) document.fonts.ready.then(onResize);
  window.addEventListener("load", onResize);
  QS.refresh = onResize;

  // ---------------------------------------------------------------------------
  // Helpers for the demos
  // ---------------------------------------------------------------------------

  // Wrap each word of an element's text in <span class="w">, keeping inline elements whole.
  QS.words = (el) => {
    const parts = [];
    for (const node of [...el.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const piece of node.textContent.split(/(\s+)/)) {
          if (!piece) continue;
          if (/^\s+$/.test(piece)) parts.push(document.createTextNode(piece));
          else { const w = document.createElement("span"); w.className = "w"; w.textContent = piece; parts.push(w); }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        node.classList.add("w");
        parts.push(node);
      }
    }
    el.replaceChildren(...parts);
    return [...el.querySelectorAll(":scope > .w")];
  };

  // A reply that makes room block by block, then lets its words surface from low contrast.
  QS.stream = (container, { lead = 2.4, window: win = 4, pad = 29, gap = 12, think = 46 } = {}) => {
    const blocks = [];
    let total = 0;
    for (const el of container.querySelectorAll(".blk")) {
      const block = { el, start: total, height: 0, units: [] };
      total += lead;
      const items = el.dataset.kind === "lines" ? [...el.querySelectorAll(".ln")] : QS.words(el);
      const step = el.dataset.kind === "lines" ? 1.7 : 1;
      for (const item of items) { block.units.push({ el: item, at: total, last: -1 }); total += step; }
      blocks.push(block);
    }
    return {
      measure() { for (const b of blocks) b.height = b.el.offsetHeight; },
      // t: 0..1 through the stream. Returns the bubble height to use.
      paint(t) {
        const u = t * (total + win);
        let height = think;
        blocks.forEach((b, i) => {
          const presence = QS.ease.out(clamp((u - b.start) / lead));
          height += i === 0 ? QS.lerp(0, pad + b.height - think, presence) : presence * (b.height + gap);
          for (const unit of b.units) {
            const k = clamp((u - unit.at) / win);
            const v = Math.round((k > 0 ? 0.16 + 0.84 * k : 0) * 100) / 100;
            if (v !== unit.last) { unit.el.style.opacity = v; unit.last = v; }
          }
        });
        return { height, started: u > 0 };
      }
    };
  };

  // Typewriter: reveal `text` in `el` for t in 0..1. Returns characters shown.
  QS.type = (el, text, t) => {
    const n = Math.round(clamp(t) * text.length);
    if (el.textContent.length !== n || el.textContent !== text.slice(0, n)) el.textContent = text.slice(0, n);
    return n;
  };

  // Scale a fixed-size box to fit its parent.
  QS.fit = (el, w, h, padX = 16, padY = 16, max = 1) => {
    const parent = el.parentElement;
    const s = Math.min(max, (parent.clientWidth - padX * 2) / w, (parent.clientHeight - padY * 2) / h);
    el.dataset.scale = s;
    return s;
  };

  // Layout position of `el` inside `root`, ignoring transforms.
  QS.offset = (el, root) => {
    let x = 0, y = 0, n = el;
    while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  };

  // ---------------------------------------------------------------------------
  // Reveals
  // ---------------------------------------------------------------------------
  for (const el of document.querySelectorAll("[data-split]")) {
    const words = el.textContent.trim().split(/\s+/);
    el.setAttribute("aria-label", el.textContent.trim());
    el.innerHTML = words.map((w, i) => `<span class="wd" aria-hidden="true"><span style="--w:${i}">${w}</span></span>`).join(" ");
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
  // Scene copy and cards reveal like everything else.
  for (const copy of document.querySelectorAll(".scene-copy")) {
    [...copy.children].forEach((c, i) => { c.setAttribute("data-reveal", ""); c.style.setProperty("--i", i); });
    copy.nextElementSibling?.setAttribute("data-reveal", "");
  }
  for (const el of document.querySelectorAll("[data-reveal], [data-split], .finale")) io.observe(el);
})();
