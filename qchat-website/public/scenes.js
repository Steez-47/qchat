// The feature tour. Each scene is pinned while you scroll through it, and its vignette is a
// pure function of that scene's progress, so every one scrubs forwards and backwards.
(() => {
  "use strict";

  const QS = window.QS;
  const { seg, lerp, clamp, ease } = QS;
  const BAR_W = 460, BAR_H = 44, VIG_W = 720, VIG_H = 500;

  // ---------------------------------------------------------------------------
  // Shared bits
  // ---------------------------------------------------------------------------

  // Piecewise path through [t, x, y] keys, eased between each pair.
  function track(t, keys) {
    if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
    for (let i = 1; i < keys.length; i++) {
      const [t1, x1, y1] = keys[i];
      if (t <= t1) {
        const [t0, x0, y0] = keys[i - 1];
        const k = ease.inOut(seg(t, t0, t1));
        return [lerp(x0, x1, k), lerp(y0, y1, k)];
      }
    }
    const last = keys[keys.length - 1];
    return [last[1], last[2]];
  }

  const css = (el, props) => { for (const k in props) el.style[k] = props[k]; };
  const rise = (t, dist = 14) => `translateY(${((1 - t) * dist).toFixed(2)}px) scale(${(0.97 + 0.03 * t).toFixed(4)})`;

  // A QChat bar inside a vignette: typing, send button and opening from the orb.
  function makeBar(bar) {
    const typed = bar.querySelector(".typed");
    const ph = bar.querySelector(".ph");
    const send = bar.querySelector(".send");
    const caret = bar.querySelector(".caret");
    const parts = [...bar.children].filter((n) => !n.classList.contains("orb"));
    return {
      el: bar,
      type(text, t) {
        const n = typed ? QS.type(typed, text, t) : 0;
        if (ph) ph.style.opacity = n ? 0 : 1;
        return n;
      },
      send(v) {
        if (!send) return;
        send.style.opacity = clamp(v);
        send.style.transform = `scale(${(0.8 + 0.2 * clamp(v, 0, 1.2)).toFixed(3)})`;
      },
      caret(on) { if (caret) caret.style.visibility = on ? "visible" : "hidden"; },
      // 0 = folded orb, 1 = full bar.
      open(t, centre = VIG_W / 2) {
        const w = lerp(BAR_H, BAR_W, ease.inOut(seg(t, 0.25, 1)));
        bar.style.width = `${w.toFixed(1)}px`;
        bar.style.left = `${(centre - w / 2).toFixed(1)}px`;
        bar.style.opacity = ease.out(seg(t, 0, 0.3));
        bar.style.transform = `scale(${(0.6 + 0.4 * ease.out(seg(t, 0, 0.35))).toFixed(3)})`;
        const c = ease.out(seg(t, 0.7, 1));
        for (const p of parts) p.style.opacity = c;
      }
    };
  }

  function pointerAt(el, [x, y], opacity = 1, pressed = false) {
    el.style.opacity = opacity;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${pressed ? 0.88 : 1})`;
  }

  function keysAt(el, t0, t1, press) {
    return (t) => {
      const v = ease.out(seg(t, t0, t0 + 0.05)) * (1 - seg(t, t1 - 0.04, t1));
      el.style.opacity = v;
      el.style.transform = `translateY(${((1 - v) * 12).toFixed(1)}px) scale(${(0.96 + 0.04 * v).toFixed(3)})`;
      el.classList.toggle("is-pressed", t >= press && t < t1);
    };
  }

  function setup(section, build) {
    const vig = section.querySelector(".vig");
    const wall = section.querySelector(".scene-wall");
    const prog = section.querySelector(".scene-progress");
    const el = (name) => vig.querySelector(`[data-el="${name}"]`);
    const scene = build({ vig, el });
    let scale = 1;
    QS.scrub(section, {
      measure() {
        const card = vig.parentElement;
        const fitW = card.clientWidth < 600 ? 540 : VIG_W;
        scale = Math.min(1.12, (card.clientWidth - 16) / fitW, (card.clientHeight - 16) / VIG_H);
        vig.style.transform = `scale(${scale.toFixed(4)})`;
        scene.measure?.();
      },
      paint(p) {
        prog?.style.setProperty("--p", p.toFixed(3));
        if (!QS.reduce.matches) wall.style.transform = `translate3d(0, ${(-p * 50).toFixed(1)}px, 0) scale(1.04)`;
        // A short lead-in and a hold at the end, so each scene settles before it scrolls away.
        scene.paint(seg(p, 0.03, 0.9));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 1. Selected text → Ctrl+Alt+Q
  // ---------------------------------------------------------------------------
  const scenes = {
    select({ vig, el }) {
      const words = QS.words(vig.querySelector(".sel-target"));
      const pointer = el("pointer"), chip = el("chip"), user = el("user"), reply = el("reply");
      const bar = makeBar(el("bar"));
      const keys = keysAt(el("keys"), 0.36, 0.5, 0.42);
      const stream = QS.stream(reply, { pad: 29 });
      let rects = [];
      return {
        measure() { rects = words.map((w) => QS.offset(w, vig)); stream.measure(); },
        paint(t) {
          // Sweep a selection across the sentence, the pointer riding its end.
          const first = rects[0], n = Math.round(seg(t, 0.1, 0.34) * words.length);
          words.forEach((w, i) => w.classList.toggle("is-sel", i < n));
          const at = n ? rects[n - 1] : first;
          const end = n ? [at.x + at.w, at.y + at.h * 0.35] : [first.x - 2, first.y + first.h * 0.35];
          const pos = track(t, [[0, 560, 420], [0.09, first.x - 2, first.y + first.h * 0.35], [0.1, ...end]]);
          pointerAt(pointer, t < 0.1 ? pos : end, ease.out(seg(t, 0, 0.05)) * (1 - seg(t, 0.44, 0.5)), t > 0.09 && t < 0.34);

          keys(t);

          // QChat opens with the selection quoted.
          bar.open(seg(t, 0.44, 0.56));
          bar.caret(t > 0.52);
          const sent = t >= 0.72;
          bar.type(sent ? "" : "Make this sound friendlier", seg(t, 0.58, 0.7));
          bar.send(sent ? 1 - seg(t, 0.95, 0.97) : ease.back(seg(t, 0.585, 0.61)));
          const c = ease.out(seg(t, 0.52, 0.58)) * (1 - seg(t, 0.72, 0.75));
          css(chip, { opacity: c, transform: rise(c, 12) });

          // Sent: the quote and question rise as one bubble, then the reply grows beneath.
          const rp = ease.out(seg(t, 0.77, 0.8));
          const { height, started } = stream.paint(seg(t, 0.8, 0.98));
          css(reply, { height: `${height.toFixed(1)}px`, bottom: "82px", opacity: rp, transform: rise(rp, 10) });
          reply.classList.toggle("is-thinking", rp > 0 && !started);
          const u = ease.out(seg(t, 0.72, 0.77));
          css(user, { bottom: `${(82 + rp * (height + 8)).toFixed(1)}px`, opacity: clamp(u * 2), transform: rise(u, 40) });
        }
      };
    },

    // -------------------------------------------------------------------------
    // 2. Snapshot the window behind
    // -------------------------------------------------------------------------
    snap({ vig, el }) {
      const win = el("win"), frame = el("frame"), flash = el("flash"), fly = el("fly");
      const pointer = el("pointer"), chip = el("chip"), thumb = el("thumb"), user = el("user"), reply = el("reply"), cam = el("cam");
      const bar = makeBar(el("bar"));
      const stream = QS.stream(reply, { pad: 29 });
      const clone = () => {
        const c = win.cloneNode(true);
        c.removeAttribute("data-el");
        c.style.cssText = `position:absolute;left:0;top:0;width:${win.offsetWidth}px;height:${win.offsetHeight}px;transform-origin:0 0`;
        return c;
      };
      fly.append(clone());
      thumb.append(clone());
      const small = user.querySelector(".thumb-sm");
      small.append(clone());
      let W = { x: 0, y: 0, w: 1, h: 1 }, th = W, cm = W;
      return {
        measure() {
          W = QS.offset(win, vig);
          th = QS.offset(thumb, vig);
          cm = QS.offset(cam, vig);
          const ts = Math.max(th.w / W.w, th.h / W.h);
          thumb.firstChild.style.transform = `scale(${ts})`;
          small.firstChild.style.transform = `scale(${small.offsetWidth / W.w})`;
          stream.measure();
        },
        paint(t) {
          bar.open(1);
          bar.el.style.opacity = ease.out(seg(t, 0, 0.05));
          bar.caret(t > 0.02);

          // Pointer to the camera, click.
          const cx = cm.x + cm.w / 2 - 4, cy = cm.y + cm.h / 2 - 2;
          pointerAt(pointer, track(t, [[0.02, 560, 230], [0.15, cx, cy], [0.22, cx, cy], [0.3, cx + 60, cy + 40]]),
            ease.out(seg(t, 0.02, 0.06)) * (1 - seg(t, 0.24, 0.3)), t > 0.17 && t < 0.2);
          cam.classList.toggle("is-hot", t > 0.14 && t < 0.24);

          // Capture: corners lock on, a flash, then the shot flies into an attachment.
          const f = ease.out(seg(t, 0.19, 0.23)) * (1 - seg(t, 0.27, 0.32));
          css(frame, { opacity: f, transform: `scale(${(1.05 - 0.05 * ease.out(seg(t, 0.19, 0.24))).toFixed(4)})` });
          const fl = seg(t, 0.2, 0.21) * (1 - seg(t, 0.21, 0.27));
          flash.style.opacity = (fl * 0.85).toFixed(3);

          const k = ease.inOut(seg(t, 0.25, 0.42));
          const s = lerp(1, Math.max(th.w / W.w, th.h / W.h), k);
          const x = lerp(W.x, th.x + th.w / 2 - (W.w * s) / 2, k);
          const y = lerp(W.y, th.y + th.h / 2 - (W.h * s) / 2, k);
          css(fly, {
            opacity: t > 0.25 && t < 0.43 ? 1 - seg(t, 0.4, 0.43) : 0,
            transform: `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${s.toFixed(4)})`,
            borderRadius: `${lerp(10, 60, k).toFixed(1)}px`
          });
          win.style.filter = `brightness(${(1 - 0.06 * f).toFixed(3)})`;

          const sent = t >= 0.6;
          const c = ease.out(seg(t, 0.39, 0.45)) * (1 - seg(t, 0.6, 0.63));
          css(chip, { opacity: c, transform: rise(c, 12) });
          bar.type(sent ? "" : "Summarize this chart in one line", seg(t, 0.46, 0.58));
          bar.send(sent ? 1 - seg(t, 0.95, 0.97) : ease.back(seg(t, 0.465, 0.49)));

          const rp = ease.out(seg(t, 0.66, 0.69));
          const { height, started } = stream.paint(seg(t, 0.69, 0.97));
          css(reply, { height: `${height.toFixed(1)}px`, bottom: "82px", opacity: rp, transform: rise(rp, 10) });
          reply.classList.toggle("is-thinking", rp > 0 && !started);
          const u = ease.out(seg(t, 0.6, 0.66));
          css(user, { bottom: `${(82 + rp * (height + 8)).toFixed(1)}px`, opacity: clamp(u * 2), transform: rise(u, 40) });
        }
      };
    },

    // -------------------------------------------------------------------------
    // 3. Slash commands: switch provider, then go temporary
    // -------------------------------------------------------------------------
    slash({ el }) {
      const menu = el("menu"), toast = el("toast"), toastText = el("toast-text"), tabText = el("tab-text");
      const gpt = el("logo-gpt"), gem = el("logo-gem"), mode = el("mode");
      const items = [...menu.querySelectorAll(".slash-item")];
      const bar = makeBar(el("bar"));
      return {
        paint(t) {
          bar.open(1);
          bar.caret(true);
          const phase2 = t >= 0.56;
          const text = !phase2
            ? (t < 0.36 ? (t < 0.04 ? "" : t < 0.2 ? "/" : "/" + "ge".slice(0, Math.round(seg(t, 0.2, 0.3) * 2))) : "")
            : (t < 0.72 ? "/temp".slice(0, Math.max(0, Math.round(seg(t, 0.58, 0.66) * 5))) : "");
          bar.type(text, 1);

          // The menu: rises, filters as you type, and sinks on Enter.
          let show, pick;
          if (!phase2) {
            show = ease.out(seg(t, 0.05, 0.13)) * (1 - ease.out(seg(t, 0.36, 0.41)));
            pick = t >= 0.24 ? "gemini" : "chatgpt";
          } else {
            show = ease.out(seg(t, 0.585, 0.63)) * (1 - ease.out(seg(t, 0.72, 0.77)));
            pick = "temp";
          }
          css(menu, { opacity: show, transform: rise(show, 12) });
          for (const item of items) {
            const cmd = item.dataset.cmd;
            const keep = !phase2 ? (cmd === "gemini" ? 1 : 1 - ease.out(seg(t, 0.24, 0.28))) : (cmd === "temp" ? 1 : 0);
            item.style.height = `${(34 * keep).toFixed(1)}px`;
            item.style.opacity = keep;
            item.classList.toggle("is-sel", cmd === pick);
          }

          // Switched: the tab's logo changes and a toast confirms it.
          const sw = ease.inOut(seg(t, 0.4, 0.46));
          gpt.style.opacity = 1 - sw;
          gem.style.opacity = sw;
          gem.style.transform = `rotate(${((1 - sw) * -90).toFixed(1)}deg) scale(${(0.6 + 0.4 * sw).toFixed(3)})`;
          const tempOn = ease.out(seg(t, 0.72, 0.8));
          const label = t >= 0.73 ? "Temporary chat · stays out of history" : "Now chatting with Gemini";
          if (toastText.textContent !== label) toastText.textContent = label;
          const tabLabel = t >= 0.73 ? "Temporary chat" : "New chat";
          if (tabText.textContent !== tabLabel) tabText.textContent = tabLabel;
          const toastV = ease.out(seg(t, 0.42, 0.48)) * (1 - seg(t, 0.52, 0.56)) + ease.out(seg(t, 0.74, 0.8)) * (1 - seg(t, 0.95, 1.01));
          css(toast, { opacity: toastV, transform: rise(toastV, 16) });

          // Temporary mode shows in the bar itself.
          css(mode, {
            maxWidth: `${(84 * tempOn).toFixed(1)}px`,
            padding: `2px ${(8 * tempOn).toFixed(1)}px`,
            marginLeft: `${(2 * tempOn).toFixed(1)}px`,
            opacity: tempOn
          });
        }
      };
    },

    // -------------------------------------------------------------------------
    // 4. Drag files onto the chat
    // -------------------------------------------------------------------------
    drop({ el }) {
      const pointer = el("pointer"), zone = el("zone"), ghost = el("ghost"), gImg = el("ghost-img"), gPdf = el("ghost-pdf");
      const f1 = el("f1"), f2 = el("f2"), c1 = el("c1"), c2 = el("c2");
      const bar = makeBar(el("bar"));
      const A = [158, 76], B = [158, 196], DROP1 = [300, 372], DROP2 = [470, 372];
      return {
        paint(t) {
          bar.open(1);
          bar.caret(t > 0.68);
          const path = [
            [0, 520, 120], [0.08, ...A], [0.1, ...A], [0.3, ...DROP1], [0.33, ...DROP1],
            [0.42, ...B], [0.44, ...B], [0.62, ...DROP2], [0.66, DROP2[0] + 40, DROP2[1] + 50]
          ];
          const pos = track(t, path);
          const dragging1 = t > 0.09 && t < 0.3, dragging2 = t > 0.43 && t < 0.62;
          pointerAt(pointer, pos, ease.out(seg(t, 0, 0.05)) * (1 - seg(t, 0.64, 0.68)), dragging1 || dragging2);
          f1.classList.toggle("is-lifted", dragging1);
          f2.classList.toggle("is-lifted", dragging2);

          // The ghost follows the pointer, then shrinks into the chip on drop.
          const drop1 = seg(t, 0.3, 0.34), drop2 = seg(t, 0.62, 0.66);
          const showGhost = (dragging1 || (t >= 0.3 && drop1 < 1)) || (dragging2 || (t >= 0.62 && drop2 < 1));
          const d = t < 0.42 ? drop1 : drop2;
          gImg.style.opacity = t < 0.42 ? 1 : 0;
          gPdf.style.opacity = t < 0.42 ? 0 : 1;
          css(ghost, {
            opacity: showGhost ? (1 - d) * 0.92 : 0,
            transform: `translate3d(${(pos[0] - 28).toFixed(1)}px, ${(pos[1] - 22).toFixed(1)}px, 0) rotate(${(-6 * (1 - d)).toFixed(1)}deg) scale(${(1.06 - 0.6 * d).toFixed(3)})`
          });

          const z = Math.max(ease.out(seg(t, 0.2, 0.26)) * (1 - seg(t, 0.3, 0.35)), ease.out(seg(t, 0.52, 0.58)) * (1 - seg(t, 0.62, 0.67)));
          css(zone, { opacity: z, transform: `scale(${(0.98 + 0.02 * z).toFixed(4)})` });

          const a1 = ease.back(seg(t, 0.31, 0.37)), a2 = ease.back(seg(t, 0.63, 0.69));
          css(c1, { opacity: clamp(a1), transform: rise(clamp(a1, 0, 1.1), 18) });
          css(c2, { opacity: clamp(a2), transform: rise(clamp(a2, 0, 1.1), 18) });

          bar.type("Plan a day around these", seg(t, 0.7, 0.86));
          bar.send(ease.back(seg(t, 0.705, 0.73)));
        }
      };
    },

    // -------------------------------------------------------------------------
    // 5. Ctrl+P: search every chat
    // -------------------------------------------------------------------------
    search({ el }) {
      const panel = el("panel"), q = el("q"), qph = el("q-ph"), reply = el("reply"), user = el("user");
      const tabNew = el("tab-new"), tabCur = el("tab-cur");
      const keys = keysAt(el("keys"), 0.02, 0.18, 0.08);
      const items = [...panel.querySelectorAll(".search-item")].map((n) => ({ n, t: n.querySelector(".t"), text: n.dataset.match, last: "" }));
      const groups = [...panel.querySelectorAll(".search-group")];
      const bar = makeBar(el("bar"));
      const stream = QS.stream(reply, { pad: 29 });
      const QUERY = "kyo";
      let tabW = 0;
      return {
        measure() {
          css(tabNew, { maxWidth: "none", paddingLeft: "", paddingRight: "" });
          tabW = tabNew.offsetWidth;
          stream.measure();
        },
        paint(t) {
          bar.open(1);
          keys(t);
          const show = ease.out(seg(t, 0.12, 0.2)) * (1 - ease.out(seg(t, 0.48, 0.54)));
          css(panel, { opacity: show, transform: rise(show, 14) });
          const n = QS.type(q, QUERY, seg(t, 0.26, 0.4));
          qph.style.opacity = n ? 0 : 1;
          const query = QUERY.slice(0, n);

          for (const it of items) {
            const match = !query || it.text.toLowerCase().includes(query);
            // Rows that stop matching fold away just after the keystroke that ruled them out.
            const keep = match ? 1 : 1 - ease.out(seg(t, 0.29, 0.33));
            it.n.style.height = `${(34 * keep).toFixed(1)}px`;
            it.n.style.opacity = keep;
            it.n.classList.toggle("is-sel", match && query && it === items[0] && t > 0.3);
            if (it.last !== query) {
              it.last = query;
              const i = query ? it.text.toLowerCase().indexOf(query) : -1;
              it.t.innerHTML = i < 0 ? it.text : `${it.text.slice(0, i)}<mark>${it.text.slice(i, i + query.length)}</mark>${it.text.slice(i + query.length)}`;
            }
          }
          for (const g of groups) g.style.opacity = 1;

          // Enter: the chat opens as the current tab, with its conversation.
          const o = ease.inOut(seg(t, 0.5, 0.6));
          css(tabNew, { maxWidth: `${(tabW * o).toFixed(1)}px`, paddingLeft: `${(10 * o).toFixed(1)}px`, paddingRight: `${(10 * o).toFixed(1)}px`, opacity: o });
          tabNew.classList.toggle("is-current", o > 0.5);
          tabCur.classList.toggle("is-current", o <= 0.5);
          const rp = ease.out(seg(t, 0.56, 0.62));
          const { height } = stream.paint(seg(t, 0.6, 0.9));
          css(reply, { height: `${height.toFixed(1)}px`, bottom: "106px", opacity: rp, transform: rise(rp, 12) });
          css(user, { bottom: `${(106 + height + 8).toFixed(1)}px`, opacity: rp, transform: rise(rp, 18) });
        }
      };
    }
  };

  for (const section of document.querySelectorAll("[data-scene]")) {
    const build = scenes[section.dataset.scene];
    if (build) setup(section, build);
  }
  QS.refresh();
})();
