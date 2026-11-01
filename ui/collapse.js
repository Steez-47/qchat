// Idle collapse. Once the chat window has been out of focus for a few seconds, everything above
// the bar sinks into it and the bar closes into its orb. A click on the orb, or anything that
// focuses the window, opens it again in reverse. Dragging the folded orb moves it without opening.
//
// The window never resizes. Folded parts only stop painting, so they also stop hit-testing and
// their native blur panels follow them out. app.css holds the resting "closed" state; this file
// animates between that and the normal layout with the Web Animations API, so no existing CSS
// transition is overridden.
(() => {
  "use strict";

  const SINK = "translateY(14px) scale(0.97)";
  const TAB_SINK = "translateY(24px)";
  // Exponential ease-out, as everywhere else. The fold itself eases in and out: an overshoot
  // there would crush the bar smaller than the orb it closes into.
  const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
  const EASE_FOLD = "cubic-bezier(0.5, 0, 0.2, 1)";
  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

  function create({ stack, bar, orb, seconds, blocked = () => false, motion = () => true, timings, drag, move, onCollapse, onExpand, onOpened }) {
    const root = document.documentElement;
    let state = "open"; // open | closing | closed | opening
    let timer = null, waitTimer = null, press = null, running = [], token = 0;
    let idleSince = 0, lastPointer = -Infinity, held = false;
    // Where the window was when it folded, and a window move still settling before it opens.
    let foldedAt = null, moving = false;

    const now = () => performance.now();
    const style = (node) => getComputedStyle(node);
    const px = (n) => `${Math.round(n * 100) / 100}px`;
    const folded = () => state === "closing" || state === "closed";
    const easeMove = () => style(root).getPropertyValue("--ease-move").trim() || EASE_OUT;
    const sink = (part) => (part.matches(".tabs") ? TAB_SINK : SINK);

    function setState(next) {
      state = next;
      if (next === "open") {
        delete root.dataset.collapse;
        delete root.dataset.collapseAnchor;
      }
      else root.dataset.collapse = next;
    }

    // Objects above the bar, top first. checkVisibility() without options still counts
    // visibility:hidden, so this also finds the parts while they rest folded.
    const parts = () => [...stack.children].filter((n) => !n.contains(bar) && !n.hidden && n.checkVisibility());
    // What the bar holds besides the orb it closes into.
    const contents = () => [...bar.children].filter((n) => n !== orb && !n.hidden && !n.matches(".sr-only, .prompt-measure"));

    function play(node, frames, timing) {
      const animation = node.animate(frames, { fill: "both", ...timing });
      running.push(animation);
      return animation;
    }
    function stopAll() {
      for (const animation of running) animation.cancel();
      running = [];
    }
    function settle(animations, done) {
      const mine = ++token;
      Promise.all(animations.map((a) => a.finished)).then(() => { if (mine === token) done(); }, () => {});
    }
    // Where a part is right now, so a reversal mid-fold starts from what is on screen.
    const snapshot = (node) => { const s = style(node); return { opacity: s.opacity, transform: s.transform }; };

    // The screen half a horizontal span's centre sits on. Screen coordinates share CSS pixels,
    // including monitors left of the primary one.
    function sideOf(rect) {
      const screenLeft = window.screen.availLeft || 0;
      return window.screenX + rect.left + rect.width / 2 >= screenLeft + window.screen.availWidth / 2 ? "right" : "left";
    }

    function collapse() {
      if (state !== "open") return;
      clearTimeout(timer); timer = null;
      onCollapse?.();
      const from = bar.getBoundingClientRect();
      // The edge stays fixed through the fold and any reversal. Only a drag can change it,
      // and that is settled when the orb opens (see reanchor).
      root.dataset.collapseAnchor = sideOf(from);
      foldedAt = { x: window.screenX, y: window.screenY };
      const radius = style(bar).borderTopLeftRadius;
      const size = parseFloat(style(bar).minHeight) || from.height;
      const folding = parts(), inside = contents();
      setState("closing");
      if (!motion()) { closed(); return; }
      const t = timings();
      const lead = Math.round(t.t1 * 0.5);
      const shrink = Math.round(t.t4 * 0.75);
      const animations = [];
      // Farthest first, so the stack drains down into the bar.
      folding.forEach((part, i) => animations.push(play(part, [{ opacity: 0, transform: sink(part) }], { duration: t.t3, delay: i * 35, easing: EASE_OUT })));
      for (const node of inside) animations.push(play(node, [{ opacity: 0 }], { duration: t.t1, easing: "linear" }));
      animations.push(play(bar, [
        { width: px(from.width), height: px(from.height), borderRadius: radius },
        { width: px(size), height: px(size), borderRadius: px(size / 2) }
      ], { duration: shrink, delay: lead, easing: EASE_FOLD }));
      // The orb takes the bar in with one small breath as the circle closes.
      animations.push(play(orb, [{ transform: "none" }, { transform: "scale(1.14)", offset: 0.45 }, { transform: "none" }], { duration: t.t3, delay: lead + shrink - Math.round(t.t3 * 0.35), easing: "ease-in-out" }));
      settle(animations, closed);
    }

    function closed() {
      token++;
      stopAll();
      setState("closed");
    }

    // The folded orb was dragged to the other half of its screen: open toward the middle of
    // the screen instead of off its edge. The orb swaps to the window's other edge, so the
    // window shifts by the same amount and the orb stays exactly where it was left.
    // Returns that shift in CSS pixels, or 0 when the edge holds.
    function reanchor() {
      if (!foldedAt || (window.screenX === foldedAt.x && window.screenY === foldedAt.y)) return 0;
      const before = bar.getBoundingClientRect();
      const side = sideOf(before);
      if (side === root.dataset.collapseAnchor) return 0;
      root.dataset.collapseAnchor = side;
      return before.left - bar.getBoundingClientRect().left;
    }

    function expand(focus = true) {
      clearTimeout(waitTimer); waitTimer = null;
      clearTimeout(timer); timer = null;
      press = null;
      if (state === "open" || state === "opening" || moving) return;
      const wasClosed = state === "closed";
      const shift = wasClosed ? reanchor() : 0;
      if (shift) {
        // Hold the orb in place on screen until the window has moved under it.
        bar.style.translate = `${px(shift)} 0`;
        moving = true;
        const mine = ++token;
        Promise.resolve(move ? move(shift) : false).catch(() => false).then((moved) => {
          moving = false;
          bar.style.translate = "";
          if (mine !== token || state !== "closed") return;
          foldedAt = { x: window.screenX, y: window.screenY };
          // Without a window move the new edge would only make the orb jump, so keep the old one.
          if (!moved) root.dataset.collapseAnchor = root.dataset.collapseAnchor === "right" ? "left" : "right";
          expand(focus);
        });
        return;
      }
      const from = bar.getBoundingClientRect();
      const radius = style(bar).borderTopLeftRadius;
      const folding = parts(), inside = contents();
      const start = new Map(wasClosed ? [] : [...folding, ...inside].map((n) => [n, snapshot(n)]));
      token++;
      stopAll();
      setState("opening");
      // Lets the composer settle at its full width before the target size is measured.
      onExpand?.(focus);
      const to = bar.getBoundingClientRect();
      const toRadius = style(bar).borderTopLeftRadius;
      if (!motion()) { opened(); return; }
      const t = timings();
      const grow = Math.round(t.t4 * 0.75);
      const animations = [play(bar, [
        { width: px(from.width), height: px(from.height), borderRadius: radius },
        { width: px(to.width), height: px(to.height), borderRadius: toRadius }
      ], { duration: grow, easing: easeMove() })];
      // Single keyframes end on each element's own value, so a hidden Send stays hidden.
      for (const node of inside) {
        const first = wasClosed ? { opacity: 0 } : { opacity: start.get(node).opacity };
        animations.push(play(node, [{ ...first, offset: 0 }], { duration: t.t2, delay: wasClosed ? Math.round(grow * 0.45) : 0, easing: "linear" }));
      }
      // Nearest first, so the stack rises back out of the bar.
      [...folding].reverse().forEach((part, i) => {
        const first = wasClosed ? { opacity: 0, transform: sink(part) } : start.get(part);
        animations.push(play(part, [{ ...first, offset: 0 }], { duration: t.t3, delay: wasClosed ? Math.round(grow * 0.3) + i * 40 : 0, easing: EASE_OUT }));
      });
      settle(animations, opened);
    }

    function opened() {
      token++;
      stopAll();
      foldedAt = null;
      setState("open");
      onOpened?.();
      // Clicked away again while it was opening: start a fresh count.
      if (!document.hasFocus()) blur();
    }

    // Straight back to normal with no animation, for a window that is going out of sight.
    function reset() {
      clearTimeout(timer); clearTimeout(waitTimer);
      timer = waitTimer = null;
      press = null;
      if (state === "open") return;
      token++;
      stopAll();
      moving = false;
      foldedAt = null;
      bar.style.translate = "";
      setState("open");
      onExpand?.(false);
      onOpened?.();
    }

    function arm(ms) {
      clearTimeout(timer); timer = null;
      if (state !== "open" || !(seconds() > 0)) return;
      timer = setTimeout(check, Math.max(0, ms));
    }

    function check() {
      timer = null;
      const limit = seconds() * 1000;
      if (state !== "open" || !(limit > 0) || document.hasFocus()) return;
      const t = now();
      // Hover can stick if the pointer leaves through a click-through edge, so it only counts
      // while the pointer has moved recently.
      const hovered = stack.matches(":hover") && t - lastPointer < 60000;
      if (hovered || blocked()) { held = true; arm(1000); return; }
      // Whatever held it open (a reply, the pointer, Settings) just let go: the count starts now.
      if (held) { held = false; idleSince = t; }
      const left = idleSince + limit - t;
      if (left > 0) { arm(left); return; }
      collapse();
    }

    // The window lost focus: start counting.
    function blur() { idleSince = now(); held = false; arm(seconds() * 1000); }
    // Settings changed: pick up a new delay without restarting the count.
    function wake() { if (!document.hasFocus() && state === "open") arm(idleSince + seconds() * 1000 - now()); }

    function focus() {
      clearTimeout(timer); timer = null;
      if (!folded()) return;
      // A click on the folded orb focuses the window too. Leave that press to decide, so it can
      // drag the orb without opening it. Anything else that focuses the window opens it now.
      if (bar.matches(":hover")) {
        clearTimeout(waitTimer);
        waitTimer = setTimeout(() => { waitTimer = null; if (!press && folded()) expand(true); }, 400);
        return;
      }
      expand(true);
    }

    const touch = () => { lastPointer = now(); idleSince = lastPointer; };
    document.addEventListener("pointermove", touch, { passive: true });
    document.addEventListener("wheel", touch, { passive: true });

    // While folded the whole circle is the handle: press and move to drag, release to open.
    // Capture phase, so the orb's own drag handler never sees these presses.
    bar.addEventListener("pointerdown", (e) => {
      if (!folded()) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.button !== 0) return;
      clearTimeout(waitTimer); waitTimer = null;
      press = { x: e.clientX, y: e.clientY, dragged: false };
      bar.setPointerCapture?.(e.pointerId);
    }, true);
    bar.addEventListener("pointermove", (e) => {
      if (!press || press.dragged || !folded()) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return;
      press.dragged = true;
      drag?.();
    }, true);
    bar.addEventListener("pointerup", (e) => {
      if (!press) return;
      e.stopPropagation();
      const { dragged } = press;
      press = null;
      if (!dragged && folded()) expand(true);
    }, true);
    bar.addEventListener("pointercancel", () => { press = null; }, true);
    bar.addEventListener("lostpointercapture", () => { if (press?.dragged) press = null; }, true);
    window.addEventListener("keydown", (e) => { if (folded() && !MODIFIERS.has(e.key)) expand(true); }, true);

    return {
      get state() { return state; },
      get folded() { return folded(); },
      blur, focus, wake, collapse, expand, reset
    };
  }

  window.QCollapse = { create };
})();
