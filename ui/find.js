(function () {
  "use strict";

  function create({ panel, controls, onOpen, onClose, onHold, onLayout }) {
    const make = (tag, id, text) => {
      const node = document.createElement(tag);
      node.id = id;
      if (text) node.textContent = text;
      return node;
    };
    const bar = make("div", "find-bar");
    bar.className = "find-bar glass glass-tiny";
    bar.setAttribute("role", "search");
    bar.setAttribute("aria-label", "Find in conversation");
    bar.hidden = true;
    const input = make("input", "find-input");
    input.type = "search";
    input.maxLength = 200;
    input.placeholder = "Find in conversation";
    input.setAttribute("aria-label", "Find in conversation");
    input.setAttribute("aria-controls", panel.id);
    input.setAttribute("aria-describedby", "find-count");
    const count = make("span", "find-count", "0/0");
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");
    count.setAttribute("aria-label", "No matches");
    const button = (id, label, text) => {
      const node = make("button", id, text);
      node.type = "button";
      node.className = "find-nav";
      node.setAttribute("aria-label", label);
      return node;
    };
    const previous = button("find-prev", "Previous match", "↑");
    const next = button("find-next", "Next match", "↓");
    const dismiss = button("find-close", "Close find", "×");
    bar.append(input, count, previous, next, dismiss);
    controls.append(bar);

    let opened = false, matches = [], index = -1, frame = 0, timer = 0;
    const clearHighlights = () => {
      window.CSS?.highlights?.delete("qchat-find");
      window.CSS?.highlights?.delete("qchat-find-current");
    };
    function paint() {
      const total = matches.length;
      const label = `${total ? index + 1 : 0}/${total}`;
      if (count.textContent !== label) {
        count.textContent = label;
        count.setAttribute("aria-label", total ? `Match ${index + 1} of ${total}` : "No matches");
      }
      previous.disabled = next.disabled = !total;
      clearHighlights();
      if (!total || !window.CSS?.highlights || typeof window.Highlight !== "function") return;
      const all = new Highlight();
      for (const item of matches) all.add(item.range);
      const current = new Highlight(matches[index].range);
      current.priority = 1;
      CSS.highlights.set("qchat-find", all);
      CSS.highlights.set("qchat-find-current", current);
    }
    function reveal() {
      const range = matches[index]?.range;
      if (!range) return;
      onHold();
      const box = panel.getBoundingClientRect(), target = range.getBoundingClientRect();
      panel.scrollTop += target.top - box.top - Math.max(0, (panel.clientHeight - target.height) * .35);
      for (let element = range.startContainer.parentElement; element && element !== panel; element = element.parentElement) {
        if (element.scrollWidth <= element.clientWidth) continue;
        if (!/auto|scroll/.test(getComputedStyle(element).overflowX)) continue;
        const bounds = element.getBoundingClientRect(), rect = range.getBoundingClientRect();
        if (rect.left < bounds.left) element.scrollLeft += rect.left - bounds.left - 8;
        else if (rect.right > bounds.right) element.scrollLeft += rect.right - bounds.right + 8;
      }
    }
    function scan(jump = false, reset = false) {
      if (!opened) return;
      const held = !reset && matches[index]?.key;
      matches = window.QFindText.ranges(panel, input.value);
      const retained = held ? matches.findIndex(item => item.key === held) : -1;
      index = matches.length ? retained >= 0 ? retained : reset ? 0 : Math.max(0, Math.min(index, matches.length - 1)) : -1;
      paint();
      if (jump) reveal();
    }
    function cancelScan() {
      cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0;
    }
    function schedule() {
      if (frame || timer) return;
      const run = () => { cancelScan(); scan(); };
      frame = requestAnimationFrame(run);
      // Hidden native test windows can throttle animation frames.
      timer = setTimeout(run, 80);
    }
    const observer = new MutationObserver(schedule);
    function open() {
      if (!opened) {
        onOpen();
        opened = true;
        bar.hidden = false;
        controls.dataset.finding = "";
        observer.observe(panel, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "class"] });
        scan(true, true);
        onLayout();
      }
      input.focus({ preventScroll: true }); input.select();
    }
    function close({ focus = true, reset = false } = {}) {
      if (reset) input.value = "";
      if (!opened) return;
      opened = false;
      observer.disconnect(); cancelScan(); clearHighlights();
      matches = []; index = -1;
      bar.hidden = true;
      delete controls.dataset.finding;
      if (focus) onClose();
      onLayout();
    }
    function move(direction) {
      if (!opened) return;
      if (frame || timer) { cancelScan(); scan(); }
      if (!matches.length) return;
      index = (index + direction + matches.length) % matches.length;
      paint(); reveal();
    }
    input.addEventListener("input", () => { cancelScan(); scan(true, true); });
    input.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); move(event.shiftKey ? -1 : 1); }
    });
    previous.addEventListener("click", () => move(-1));
    next.addEventListener("click", () => move(1));
    dismiss.addEventListener("click", () => close());
    return { open, close, move, input, get isOpen() { return opened; } };
  }

  window.QFind = { create };
})();
