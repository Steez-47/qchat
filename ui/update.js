// Update notice. When GitHub has a newer release, a small arrow badge sits on the orb. Hovering
// the orb (or the whole circle while folded) shows a chip above it with an "Update to vX"
// button; /update checks on demand and shows the same chip. The native side
// (src-tauri/src/update.rs) downloads the release, verifies it, swaps the executable and
// relaunches, so the button only ever asks it to install what it found itself.
(() => {
  "use strict";

  const FIRST_CHECK = 8000;
  const EVERY = 6 * 60 * 60 * 1000;
  const HIDE_DELAY = 350;
  const SKIP_KEY = "qchat.update.skip";

  function create({ bar, orb, composer, invoke, listen, enabled }) {
    const root = document.documentElement;
    const stack = composer.parentElement;
    const badge = document.getElementById("update-badge");
    const chip = document.getElementById("update-chip");
    const button = document.getElementById("btn-update");
    const label = document.getElementById("update-label");
    const skip = document.getElementById("btn-update-skip");
    let found = null; // { version, url }
    let phase = "idle"; // idle | installing | failed
    let hideTimer = null, checking = null, checked = false;

    const readSkip = () => { try { return localStorage.getItem(SKIP_KEY) || ""; } catch (_) { return ""; } };
    const writeSkip = (v) => { try { localStorage.setItem(SKIP_KEY, v); } catch (_) {} };
    const available = () => !!found && (enabled() || phase !== "idle");
    // A reply task owns the orb's corner and the hover surface while it is shown.
    const taskShown = () => Boolean(root.dataset.orbTask);

    function paint() {
      badge.hidden = !available() || taskShown();
      if (!available() || taskShown()) { hide(true); return; }
      button.disabled = phase === "installing";
      skip.hidden = phase !== "idle";
      if (phase === "idle") label.textContent = `Update to v${found.version}`;
      else if (phase === "failed") label.textContent = "Couldn't update · Get it on GitHub";
      chip.setAttribute("aria-label", `QChat ${found.version} is available`);
    }

    // Line the chip up with the orb, opening toward the middle of the composer.
    function place() {
      const box = composer.getBoundingClientRect(), o = orb.getBoundingClientRect();
      if (o.left + o.width / 2 - box.left > box.width / 2) {
        chip.style.left = "auto";
        chip.style.right = `${Math.max(0, Math.round(box.right - o.right - 8))}px`;
      } else {
        chip.style.right = "auto";
        chip.style.left = `${Math.max(0, Math.round(o.left - box.left - 8))}px`;
      }
    }

    // Like the command menu, the chip overlays the stack and the tabs on the bar step aside.
    function setVisible(visible) {
      chip.hidden = !visible;
      stack?.toggleAttribute("data-update-chip", visible);
    }
    function show() {
      if (!available() || taskShown()) return false;
      clearTimeout(hideTimer); hideTimer = null;
      place();
      setVisible(true);
      return true;
    }
    // Progress stays up until the app restarts.
    function hide(now = false) {
      clearTimeout(hideTimer); hideTimer = null;
      if (chip.hidden || (phase === "installing" && found)) return;
      if (now) setVisible(false);
      else hideTimer = setTimeout(() => { hideTimer = null; if (!chip.matches(":hover, :focus-within")) setVisible(false); }, HIDE_DELAY);
    }

    // Folded, the whole circle is the orb; open, only the orb itself.
    const target = () => (root.dataset.collapse === "closed" ? bar : orb);
    bar.addEventListener("pointermove", (e) => { if (target().contains(e.target)) show(); else hide(); }, { passive: true });
    bar.addEventListener("pointerleave", () => hide());
    // A press on the orb drags the window, so the chip gets out of the way.
    orb.addEventListener("pointerdown", () => hide(true));
    chip.addEventListener("pointerenter", () => show());
    chip.addEventListener("pointerleave", () => hide());
    chip.addEventListener("focusout", (e) => { if (!chip.contains(e.relatedTarget)) hide(); });
    chip.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); hide(true); } });

    button.addEventListener("click", async () => {
      if (!found || phase === "installing") return;
      if (phase === "failed") { invoke("open_external", { url: found.url }).catch(() => {}); return; }
      phase = "installing";
      label.textContent = "Downloading…";
      paint();
      try {
        await invoke("update_install");
        label.textContent = "Restarting…";
      } catch (err) {
        phase = "failed";
        button.title = String(err?.message || err || "");
        paint();
      }
    });
    skip.addEventListener("click", () => {
      if (!found) return;
      writeSkip(found.version);
      found = null;
      paint();
    });
    listen("qchat://update-progress", ({ payload }) => {
      if (phase !== "installing" || !(payload?.total > 0)) return;
      label.textContent = `Downloading… ${Math.min(100, Math.floor(payload.received * 100 / payload.total))}%`;
    });

    // Resolves with the native answer, or null when it could not ask. A manual check also
    // brings back a version that was skipped.
    function check(manual = false) {
      if (!manual && !enabled()) return Promise.resolve(null);
      if (checking) return checking;
      checking = (async () => {
        try {
          const result = await invoke("update_check");
          checked = true;
          if (phase === "installing") return result;
          if (result?.available && result.version && (manual || result.version !== readSkip())) {
            if (found?.version !== result.version) phase = "idle";
            found = { version: String(result.version), url: String(result.url || "") };
          } else if (!result?.available) found = null;
          paint();
          return result;
        } catch (err) {
          if (manual) throw err;
          return null;
        } finally { checking = null; }
      })();
      return checking;
    }

    // Settings changed: hide the badge when checks are off, check soon after they come on.
    function sync() {
      paint();
      if (enabled() && !checked) setTimeout(() => check(), 1000);
    }

    setTimeout(() => check(), FIRST_CHECK);
    setInterval(() => check(), EVERY);

    return {
      check, sync, show,
      get found() { return found; },
      focus() { if (show()) button.focus({ preventScroll: true }); }
    };
  }

  window.QUpdate = { create };
})();
