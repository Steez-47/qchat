(function () {
  "use strict";

  const STORAGE_KEY = "qchat.look";
  const ALLOWED_LOOKS = [
    "aurora",
    "frost",
    "sunset",
    "sakura",
    "forest",
    "graphite",
    "system"
  ];
  const DEFAULT_STATE = { look: "aurora", glass: 0.72 };

  function normalizeLook(val) {
    return typeof val === "string" && ALLOWED_LOOKS.includes(val)
      ? val
      : DEFAULT_STATE.look;
  }

  function normalizeGlass(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return DEFAULT_STATE.glass;
    const scaled = num > 1.05 ? num / 100 : num;
    const clamped = Math.min(1, Math.max(0.35, scaled));
    return Math.round(clamped * 100) / 100;
  }

  function loadStored() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STATE };
      return {
        look: normalizeLook(parsed.look),
        glass: normalizeGlass(parsed.glass)
      };
    } catch (_) {
      return { ...DEFAULT_STATE };
    }
  }

  function saveStored(state) {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ look: state.look, glass: state.glass })
      );
    } catch (_) {}
  }

  const state = loadStored();

  function applyToRoot() {
    const root = document.documentElement;
    root.dataset.look = state.look;
    root.style.setProperty("--glass", String(state.glass));
  }

  // Apply before first paint
  applyToRoot();

  function syncControls() {
    const swatches = document.querySelectorAll(
      '[role="radiogroup"] [role="radio"][data-look]'
    );
    swatches.forEach((btn) => {
      const checked = btn.dataset.look === state.look;
      btn.setAttribute("aria-checked", String(checked));
      btn.tabIndex = checked ? 0 : -1;
    });

    const range = document.getElementById("glass-range");
    const pct = Math.round(state.glass * 100);
    if (range && Number(range.value) !== pct) {
      range.value = String(pct);
    }
    const readout = document.getElementById("glass-value");
    if (readout) {
      readout.textContent = `${pct}%`;
    }
  }

  function setLookState(patch, focusActiveRadio = false) {
    if (!patch || typeof patch !== "object") {
      return { look: state.look, glass: state.glass };
    }
    if (patch.look !== undefined) {
      state.look = normalizeLook(patch.look);
    }
    if (patch.glass !== undefined) {
      state.glass = normalizeGlass(patch.glass);
    }
    applyToRoot();
    saveStored(state);
    syncControls();
    if (focusActiveRadio) {
      const activeBtn = document.querySelector(
        `[role="radiogroup"] [role="radio"][data-look="${state.look}"]`
      );
      activeBtn?.focus();
    }
    return { look: state.look, glass: state.glass };
  }

  function initControls() {
    syncControls();

    const group = document.getElementById("look-radiogroup");
    if (group) {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest('[role="radio"][data-look]');
        if (!btn) return;
        setLookState({ look: btn.dataset.look }, false);
      });

      group.addEventListener("keydown", (e) => {
        const radios = Array.from(
          group.querySelectorAll('[role="radio"][data-look]')
        );
        if (!radios.length) return;
        const currentIdx = Math.max(
          0,
          radios.findIndex((r) => r.dataset.look === state.look)
        );
        let nextIdx = -1;

        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          nextIdx = (currentIdx + 1) % radios.length;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          nextIdx = (currentIdx - 1 + radios.length) % radios.length;
        } else if (e.key === "Home") {
          nextIdx = 0;
        } else if (e.key === "End") {
          nextIdx = radios.length - 1;
        }

        if (nextIdx >= 0) {
          e.preventDefault();
          setLookState({ look: radios[nextIdx].dataset.look }, true);
        }
      });
    }

    const range = document.getElementById("glass-range");
    if (range) {
      const onRange = () => {
        setLookState({ glass: Number(range.value) / 100 }, false);
      };
      range.addEventListener("input", onRange);
      range.addEventListener("change", onRange);
    }

    // Ensure suggestion chips outside #empty-state populate #prompt-input
    const suggestions = document.querySelector(".suggestions");
    const emptyState = document.getElementById("empty-state");
    if (suggestions && (!emptyState || !emptyState.contains(suggestions))) {
      suggestions.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-suggestion]");
        if (!chip) return;
        const promptInput = document.getElementById("prompt-input");
        if (!promptInput) return;
        promptInput.value = chip.dataset.suggestion;
        promptInput.dispatchEvent(new Event("input", { bubbles: true }));
        promptInput.focus();
        const end = promptInput.value.length;
        promptInput.setSelectionRange(end, end);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initControls, { once: true });
  } else {
    initControls();
  }

  window.QLook = {
    get() {
      return { look: state.look, glass: state.glass };
    },
    set(patch) {
      return setLookState(patch, false);
    }
  };
})();
