// The scroll story. Every frame is a pure function of scroll progress, so it scrubs both ways.
// Motion follows QChat's own rules: a sent message rises out of the bar, the reply grows in
// its place, and the whole thing folds back into its orb.
(() => {
  "use strict";

  const { seg, lerp, clamp, ease } = window.QS;
  const $ = (id) => document.getElementById(id);
  const story = $("story");
  if (!story) return;

  const screen = $("screen");
  const wallpaper = $("wallpaper");
  const demo = story.querySelector(".demo");
  const desk = $("desk-win");
  const app = $("app");
  const bar = $("bar");
  const typed = $("typed");
  const caret = $("caret");
  const placeholder = $("placeholder");
  const field = caret.parentElement;
  const tools = $("bar-tools");
  const send = $("send");
  const iSend = send.querySelector(".i-send");
  const iStop = send.querySelector(".i-stop");
  const user = $("msg-user");
  const reply = $("msg-reply");
  const thinking = $("thinking");
  const tabsInner = $("tabs-inner");
  const keys = $("keys");
  const ripple = $("ripple");
  const hint = $("scroll-hint");
  const todo = $("ed-todo"), fix = $("ed-fix"), fix2 = $("ed-fix2"), hl = $("ed-hl");
  const captions = [...story.querySelectorAll(".caption")];
  const rails = [...story.querySelectorAll("[data-rail]")];
  const rail = story.querySelector(".rail");
  const reduce = window.QS.reduce;

  const PROMPT = "What’s a clean way to debounce a search box?";
  const TODO = todo.textContent;
  const DONE = "// waits for a pause in typing";
  const BAR_H = 44, BAR_W = 460, GAP = 8, TAB_H = 24;

  // Timeline, as fractions of the story's scroll length.
  const T = {
    press: [0.035, 0.07],
    glide: [0.055, 0.15],
    desk: [0.08, 0.19],
    unfurl: [0.12, 0.21],
    tools: [0.17, 0.23],
    type: [0.27, 0.37],
    send: 0.4,
    rise: [0.4, 0.45],
    think: [0.445, 0.48],
    stream: [0.49, 0.665],
    tabs: [0.7, 0.755],
    sink: [0.8, 0.85],
    close: [0.84, 0.9],
    erase: [0.905, 0.925],
    rewrite: [0.925, 0.95],
    wrap: [0.95, 0.965],
    exit: [0.97, 1]
  };
  // Caption i shows from STEPS[i] until STEPS[i + 1].
  const STEPS = [0, 0.045, 0.255, 0.47, 0.685, 0.785, 1];

  const stream = window.QS.stream(reply.querySelector(".reply-body"), { pad: 32 });
  let narrow = false, base = 1, deskScale = 1, deskX = 0;

  function measure() {
    narrow = demo.clientWidth < 720;
    app.classList.toggle("is-narrow", narrow);
    reply.style.left = narrow ? "90px" : "0px";
    reply.style.width = narrow ? `${BAR_W}px` : "640px";
    stream.measure();
    const contentW = narrow ? BAR_W + 24 : 664;
    base = Math.min(1, (demo.clientWidth - 24) / contentW, (demo.clientHeight - 32) / 540);
    // On narrow screens the editor is centred and shrunk to fit rather than offset.
    deskScale = narrow ? Math.min(base, (demo.clientWidth - 16) / 700) : base;
    deskX = narrow ? 0 : -60 * base;
  }

  function paint(p) {
    const still = reduce.matches;

    // Captions and progress rail.
    let step = 0;
    for (let i = 0; i < STEPS.length - 1; i++) if (p >= STEPS[i]) step = i;
    captions.forEach((c, i) => {
      c.classList.toggle("is-active", i === step);
      c.classList.toggle("is-past", i < step);
    });
    rails.forEach((r, i) => r.style.setProperty("--fill", seg(p, STEPS[i + 1], STEPS[i + 2] - 0.01).toFixed(3)));
    rail.style.opacity = seg(p, 0.03, 0.06) * (1 - seg(p, T.exit[0], T.exit[0] + 0.015));
    hint.style.opacity = 1 - seg(p, 0, 0.02);

    // The screen drifts and, at the very end, eases back as the page moves on.
    const exit = ease.inOut(seg(p, ...T.exit));
    if (!still) {
      wallpaper.style.transform = `translate3d(${(-p * 30).toFixed(1)}px, ${(-p * 60).toFixed(1)}px, 0) scale(${(1.04 + p * 0.04).toFixed(3)})`;
      screen.style.transform = exit ? `scale(${(1 - 0.06 * exit).toFixed(4)})` : "";
      screen.style.borderRadius = `${(26 + 14 * exit).toFixed(1)}px`;
    }

    // Open: the keys press, the orb glides into place, then unfurls into the bar.
    const g = ease.inOut(seg(p, ...T.glide));
    const zoom = still ? 1 : lerp(1.45, 1, g);
    const s = base * zoom;
    const fit = -238 * (1 - base) - 34 * base;
    const heroLift = still ? 0 : -238 * base * (1 - g);
    app.style.transform = `translate3d(0, ${(fit + heroLift).toFixed(2)}px, 0) scale(${s.toFixed(4)})`;

    keys.classList.toggle("is-pressed", p >= T.press[1] - 0.012);
    keys.style.opacity = 1 - seg(p, T.glide[0] + 0.01, T.glide[0] + 0.045);
    const r = seg(p, T.press[1] - 0.012, T.press[1] + 0.05);
    ripple.style.opacity = r > 0 && r < 1 ? ((1 - r) * 0.9).toFixed(3) : 0;
    ripple.style.transform = `scale(${(1 + r * 2.6).toFixed(3)})`;

    // The app behind QChat fades up as the bar opens over it.
    const d = ease.out(seg(p, ...T.desk));
    desk.style.opacity = d * (1 - 0.15 * exit);
    desk.style.transform = `translate3d(${deskX.toFixed(1)}px, ${((-78 + 24 * (1 - d)) * base).toFixed(1)}px, 0) scale(${(deskScale * (0.95 + 0.05 * d)).toFixed(4)})`;

    const close = ease.inOut(seg(p, ...T.close));
    const open = ease.inOut(seg(p, ...T.unfurl)) * (1 - close);
    const width = lerp(BAR_H, BAR_W, open);
    bar.style.width = `${width.toFixed(2)}px`;
    bar.style.left = `${(320 - width / 2).toFixed(2)}px`;
    const contents = ease.out(seg(p, ...T.tools)) * (1 - seg(p, T.close[0] - 0.012, T.close[0] + 0.012));
    tools.style.opacity = contents;
    field.style.opacity = contents;
    // The folded orb dims once QChat is out of the way.
    bar.style.opacity = 1 - 0.35 * seg(p, T.close[1], T.close[1] + 0.03);

    // Typing, then sending.
    const sent = p >= T.send;
    const chars = sent ? 0 : window.QS.type(typed, PROMPT, seg(p, ...T.type));
    if (sent && typed.textContent) typed.textContent = "";
    placeholder.style.opacity = chars ? 0 : 1;
    caret.style.visibility = p > T.tools[0] && p < T.sink[0] ? "visible" : "hidden";

    const streamEnd = T.stream[1];
    let sendV = 0;
    if (!sent) {
      const firstChar = T.type[0] + (T.type[1] - T.type[0]) / PROMPT.length;
      sendV = ease.back(seg(p, firstChar, firstChar + 0.012));
    } else if (p < streamEnd) sendV = 1;
    else sendV = 1 - seg(p, streamEnd, streamEnd + 0.01);
    send.style.opacity = clamp(sendV);
    send.style.transform = `scale(${(0.8 + 0.2 * sendV).toFixed(3)})`;
    iSend.style.opacity = sent ? 0 : 1;
    iStop.style.opacity = sent && p < streamEnd ? 1 : 0;

    // Fold: everything above the bar sinks into it.
    const sink = ease.inOut(seg(p, ...T.sink));
    const sinkT = `translateY(${(14 * sink).toFixed(2)}px) scale(${(1 - 0.03 * sink).toFixed(4)})`;

    // Tabs rise from behind the bar's top edge, one after another.
    const tabsT = ease.out(seg(p, ...T.tabs));
    tabsInner.style.transform = `translateY(${(TAB_H * sink).toFixed(2)}px)`;
    tabsInner.style.opacity = 1 - sink;
    [...tabsInner.children].forEach((tab, i) => {
      const t = ease.out(seg(p, T.tabs[0] + i * 0.012, T.tabs[1] + i * 0.012));
      tab.style.transform = `translateY(${(TAB_H * (1 - t)).toFixed(2)}px)`;
    });
    const replyBottom = BAR_H + TAB_H * tabsT + GAP;

    // Reply: a thinking bubble, then blocks make room and words surface.
    const rp = ease.out(seg(p, ...T.think));
    const { height, started } = stream.paint(seg(p, ...T.stream));
    thinking.style.opacity = started ? 0 : rp;
    reply.style.height = `${height.toFixed(2)}px`;
    reply.style.bottom = `${replyBottom.toFixed(2)}px`;
    reply.style.opacity = rp * (1 - sink);
    reply.style.transform = rp < 1 ? `translateY(${((1 - rp) * 10).toFixed(2)}px) scale(${(0.97 + 0.03 * rp).toFixed(4)})` : sinkT;

    // The user's bubble rises out of the bar, and is pushed up as the reply grows.
    const u = ease.out(seg(p, ...T.rise));
    user.style.bottom = `${(replyBottom + rp * (height + GAP)).toFixed(2)}px`;
    user.style.opacity = clamp(u * 2.2) * (1 - sink);
    user.style.transform = u < 1 ? `translateY(${((1 - u) * 46).toFixed(2)}px) scale(${(0.97 + 0.03 * u).toFixed(4)})` : sinkT;

    // Back to work: the TODO gets fixed in the editor.
    const erase = seg(p, ...T.erase), rewrite = seg(p, ...T.rewrite), wrap = seg(p, ...T.wrap);
    const line = rewrite > 0 ? DONE.slice(0, Math.round(rewrite * DONE.length)) : TODO.slice(0, Math.round((1 - erase) * TODO.length));
    if (todo.textContent !== line) todo.textContent = line;
    window.QS.type(fix, "debounce(", wrap);
    const close2 = wrap >= 1 ? ")" : "";
    if (fix2.textContent !== close2) fix2.textContent = close2;
    hl.style.opacity = (ease.out(seg(p, T.erase[0], T.erase[0] + 0.01)) * (1 - 0.6 * seg(p, T.wrap[1], T.wrap[1] + 0.02))).toFixed(3);
  }

  window.QS.scrub(story, { paint, measure });
})();
