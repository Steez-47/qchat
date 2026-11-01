// The scroll story. Every frame of the demo is a pure function of scroll progress, so it
// scrubs forwards and backwards. Timings and motion follow QChat's own design rules:
// a sent message rises out of the bar, the reply grows in its place, and the whole thing
// folds back into its orb.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const story = $("story");
  if (!story) return;

  const demo = story.querySelector(".demo");
  const app = $("app");
  const bar = $("bar");
  const typed = $("typed");
  const caret = $("caret");
  const placeholder = $("placeholder");
  const tools = $("bar-tools");
  const send = $("send");
  const iSend = send.querySelector(".i-send");
  const iStop = send.querySelector(".i-stop");
  const user = $("msg-user");
  const reply = $("msg-reply");
  const thinking = $("thinking");
  const body = $("reply-body");
  const tabsInner = $("tabs-inner");
  const keys = $("keys");
  const hint = $("scroll-hint");
  const captions = [...story.querySelectorAll(".caption")];
  const rails = [...story.querySelectorAll("[data-rail]")];
  const rail = story.querySelector(".rail");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  const PROMPT = "What’s a clean way to debounce a search box?";
  const BAR_H = 44, BAR_W = 460, GAP = 8, TAB_H = 24;

  // Timeline, as fractions of the story's scroll length.
  const T = {
    hero: [0.02, 0.06],
    glide: [0.055, 0.15],
    unfurl: [0.12, 0.21],
    tools: [0.17, 0.23],
    type: [0.27, 0.37],
    send: 0.4,
    rise: [0.4, 0.45],
    think: [0.445, 0.48],
    stream: [0.49, 0.665],
    tabs: [0.7, 0.755],
    sink: [0.81, 0.86],
    close: [0.85, 0.92]
  };
  // Caption i is showing from STEPS[i] until STEPS[i + 1].
  const STEPS = [0, 0.045, 0.255, 0.47, 0.685, 0.795, 1];

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const seg = (p, [a, b]) => clamp((p - a) / (b - a));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeBack = (t) => { const c = 1.25; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  // -------------------------------------------------------------------------
  // Reply: split blocks into units (words, or whole code lines) and give each
  // one a slot in the stream schedule. Blocks make room first, then flow in.
  // -------------------------------------------------------------------------
  const LEAD = 2.4, WINDOW = 4;
  const blocks = [];
  const units = [];
  let total = 0;

  for (const el of body.querySelectorAll(".blk")) {
    const block = { el, start: total, height: 0, units: [] };
    total += LEAD;
    if (el.dataset.kind === "lines") {
      for (const ln of el.querySelectorAll(".ln")) {
        block.units.push({ el: ln, at: total, last: -1 });
        total += 1.7;
      }
    } else {
      const parts = [];
      for (const node of [...el.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE) {
          for (const piece of node.textContent.split(/(\s+)/)) {
            if (!piece) continue;
            if (/^\s+$/.test(piece)) parts.push(document.createTextNode(piece));
            else { const w = document.createElement("span"); w.className = "w"; w.textContent = piece; parts.push(w); }
          }
        } else {
          node.classList.add("w");
          parts.push(node);
        }
      }
      el.replaceChildren(...parts);
      for (const w of el.querySelectorAll(".w")) {
        block.units.push({ el: w, at: total, last: -1 });
        total += 1;
      }
    }
    units.push(...block.units);
    blocks.push(block);
  }

  const PAD_Y = 32, BLOCK_GAP = 12, THINK_H = 46;
  let narrow = false, base = 1;

  function measure() {
    narrow = demo.clientWidth < 720;
    app.classList.toggle("is-narrow", narrow);
    reply.style.left = narrow ? "90px" : "0px";
    reply.style.width = narrow ? `${BAR_W}px` : "640px";
    for (const b of blocks) b.height = b.el.offsetHeight;
    const contentW = narrow ? BAR_W + 24 : 664;
    base = Math.min(1, (demo.clientWidth - 24) / contentW, (demo.clientHeight - 32) / 540);
    last = -1;
    paint(current);
  }

  // -------------------------------------------------------------------------
  // Paint one frame.
  // -------------------------------------------------------------------------
  let last = -1;
  const setOpacity = (u, value) => {
    const v = Math.round(value * 100) / 100;
    if (v !== u.last) { u.el.style.opacity = v; u.last = v; }
  };

  function paint(p) {
    if (p === last) return;
    last = p;
    const still = reduce.matches;

    // Captions and progress rail.
    let step = 0;
    for (let i = 0; i < STEPS.length - 1; i++) if (p >= STEPS[i]) step = i;
    captions.forEach((c, i) => {
      c.classList.toggle("is-active", i === step);
      c.classList.toggle("is-past", i < step);
    });
    rails.forEach((r, i) => r.style.setProperty("--fill", seg(p, [STEPS[i + 1], STEPS[i + 2] - 0.01]).toFixed(3)));
    rail.style.opacity = seg(p, [0.03, 0.06]);
    hint.style.opacity = 1 - seg(p, [0, 0.02]);

    // Open: the orb glides into place, then unfurls into the bar.
    const g = easeInOut(seg(p, T.glide));
    const zoom = still ? 1 : lerp(1.45, 1, g);
    const s = base * zoom;
    // Centre the scaled box, then sit it a little above centre so the bar isn't crowded low.
    const fit = -238 * (1 - base) - 34 * base;
    const heroLift = still ? 0 : -238 * base * (1 - g);
    app.style.transform = `translate3d(0, ${(fit + heroLift).toFixed(2)}px, 0) scale(${s.toFixed(4)})`;

    keys.classList.toggle("is-pressed", p >= T.hero[1] - 0.012);
    keys.style.opacity = 1 - seg(p, [T.glide[0] + 0.01, T.glide[0] + 0.045]);

    const close = easeInOut(seg(p, T.close));
    const open = easeInOut(seg(p, T.unfurl)) * (1 - close);
    const width = lerp(BAR_H, BAR_W, open);
    bar.style.width = `${width.toFixed(2)}px`;
    bar.style.left = `${(320 - width / 2).toFixed(2)}px`;
    const contents = easeOut(seg(p, T.tools)) * (1 - seg(p, [T.close[0] - 0.012, T.close[0] + 0.012]));
    tools.style.opacity = contents;
    caret.parentElement.style.opacity = contents;

    // Typing, then sending.
    const sent = p >= T.send;
    const chars = sent ? 0 : Math.round(seg(p, T.type) * PROMPT.length);
    if (typed.textContent.length !== chars) typed.textContent = PROMPT.slice(0, chars);
    placeholder.style.opacity = chars ? 0 : 1;
    caret.style.visibility = p > T.tools[0] && p < T.sink[0] ? "visible" : "hidden";

    const streamEnd = T.stream[1];
    let sendV = 0;
    if (!sent) {
      const firstChar = T.type[0] + (T.type[1] - T.type[0]) / PROMPT.length;
      sendV = easeBack(seg(p, [firstChar, firstChar + 0.012]));
    } else if (p < streamEnd) sendV = 1;
    else sendV = 1 - seg(p, [streamEnd, streamEnd + 0.01]);
    send.style.opacity = clamp(sendV);
    send.style.transform = `scale(${(0.8 + 0.2 * sendV).toFixed(3)})`;
    iSend.style.opacity = sent ? 0 : 1;
    iStop.style.opacity = sent && p < streamEnd ? 1 : 0;

    // Fold: everything above the bar sinks into it.
    const sink = easeInOut(seg(p, T.sink));
    const sinkT = `translateY(${(14 * sink).toFixed(2)}px) scale(${(1 - 0.03 * sink).toFixed(4)})`;

    // Tabs rise from behind the bar's top edge.
    const tabsT = easeOut(seg(p, T.tabs));
    tabsInner.style.transform = `translateY(${(TAB_H * (1 - tabsT) + TAB_H * sink).toFixed(2)}px)`;
    tabsInner.style.opacity = 1 - sink;
    const replyBottom = BAR_H + TAB_H * tabsT + GAP;

    // Reply: a thinking bubble, then blocks make room and words surface.
    const rp = easeOut(seg(p, T.think));
    const u = seg(p, T.stream) * (total + WINDOW);
    let height = THINK_H;
    blocks.forEach((b, i) => {
      const presence = easeOut(clamp((u - b.start) / LEAD));
      height += i === 0 ? lerp(0, PAD_Y + b.height - THINK_H, presence) : presence * (b.height + BLOCK_GAP);
      for (const unit of b.units) {
        const t = clamp((u - unit.at) / WINDOW);
        setOpacity(unit, t > 0 ? 0.16 + 0.84 * t : 0);
      }
    });
    thinking.style.opacity = rp * (1 - clamp(u / LEAD));
    reply.style.height = `${height.toFixed(2)}px`;
    reply.style.bottom = `${replyBottom.toFixed(2)}px`;
    reply.style.opacity = rp * (1 - sink);
    reply.style.transform = rp < 1 ? `translateY(${((1 - rp) * 10).toFixed(2)}px) scale(${(0.97 + 0.03 * rp).toFixed(4)})` : sinkT;

    // The user's bubble rises out of the bar, and is pushed up as the reply grows.
    const r = easeOut(seg(p, T.rise));
    user.style.bottom = `${(replyBottom + rp * (height + GAP)).toFixed(2)}px`;
    user.style.opacity = clamp(r * 2.2) * (1 - sink);
    user.style.transform = r < 1
      ? `translateY(${((1 - r) * 46).toFixed(2)}px) scale(${(0.97 + 0.03 * r).toFixed(4)})`
      : sinkT;
  }

  // -------------------------------------------------------------------------
  // Scroll → progress, smoothed so a wheel's steps glide.
  // -------------------------------------------------------------------------
  let target = 0, current = 0, frame = 0;

  function readScroll() {
    const range = story.offsetHeight - window.innerHeight;
    target = range > 0 ? clamp(-story.getBoundingClientRect().top / range) : 0;
  }
  function tick() {
    frame = 0;
    const diff = target - current;
    current = reduce.matches || Math.abs(diff) < 0.0002 ? target : current + diff * 0.14;
    paint(current);
    if (current !== target) frame = requestAnimationFrame(tick);
  }
  function onScroll() {
    readScroll();
    if (!frame) frame = requestAnimationFrame(tick);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", () => { readScroll(); measure(); });
  if (document.fonts?.ready) document.fonts.ready.then(measure);
  readScroll();
  current = target;
  measure();
})();
