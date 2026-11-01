// KaTeX maths for replies. This file is tiny; KaTeX itself (script, styles and
// fonts) is requested the first time a reply actually contains a formula.
// Formulas are lifted out before Markdown is parsed and replaced with inert
// placeholder tokens, so emphasis, lists and code fences never touch the TeX.
(function () {
  "use strict";

  const TOKEN_OPEN = "\uE000";
  const TOKEN_CLOSE = "\uE001";
  const KATEX_SCRIPT = "vendor/katex/katex.min.js";
  const KATEX_STYLES = "vendor/katex/katex.min.css";

  let loader = null;
  let ready = false;
  let failed = false;
  const rendered = new Map();

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));

  // A backslash run of odd length escapes the character that follows it.
  function isEscaped(text, index) {
    let slashes = 0;
    while (index - slashes - 1 >= 0 && text[index - slashes - 1] === "\\") slashes++;
    return slashes % 2 === 1;
  }

  // Returns the index just past a complete fenced code block, or -1 when the
  // line does not open one. Unclosed fences run to the end, as Markdown does.
  function fenceEnd(text, start) {
    const open = /^( {0,3})(`{3,}|~{3,})/.exec(text.slice(start));
    if (!open) return -1;
    const marker = open[2][0];
    const size = open[2].length;
    let pos = start + open[0].length;
    while (pos < text.length) {
      const newline = text.indexOf("\n", pos);
      const lineEnd = newline < 0 ? text.length : newline;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text.slice(pos, lineEnd));
      if (close && close[1][0] === marker && close[1].length >= size) {
        return newline < 0 ? text.length : newline + 1;
      }
      if (newline < 0) break;
      pos = newline + 1;
    }
    return text.length;
  }

  // Inline code spans end at a backtick run of exactly the same length.
  function codeSpanEnd(text, start) {
    let size = 0;
    while (text[start + size] === "`") size++;
    let i = start + size;
    while (i < text.length) {
      if (text[i] !== "`") { i++; continue; }
      let run = 0;
      while (text[i + run] === "`") run++;
      if (run === size) return i + run;
      i += run;
    }
    return text.length;
  }

  function delimiterEnd(text, from, closer, allowNewline) {
    let i = from;
    while (i < text.length) {
      if (!allowNewline && text[i] === "\n") return -1;
      if (text.startsWith(closer, i) && !isEscaped(text, i)) return i;
      if (text[i] === "\\") { i += 2; continue; }
      i++;
    }
    return -1;
  }

  // A single $ only counts when it reads as maths rather than money:
  // `$5 and $10` must stay prose.
  const CURRENCY = /^\s*(?:[$€£¥])?\s*\d[\d,.]*\s*(?:k|m|bn|b|usd|eur|gbp|jpy|cad|aud|nzd|chf|dollars?|euros?|pounds?|cents?)?\s*$/i;

  function isCurrency(content) {
    return CURRENCY.test(content);
  }

  // The rest of the line holds no closing $ at all, so no later $ on it can open a formula.
  const NO_CLOSER = -2;

  function inlineDollarEnd(text, start) {
    if (start + 1 >= text.length || /\s/.test(text[start + 1])) return -1;
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === "\n") return NO_CLOSER;
      if (text[i] === "\\") { i++; continue; }
      if (text[i] !== "$" || isEscaped(text, i)) continue;
      if (/\s/.test(text[i - 1])) continue;
      if (text[i + 1] && /[0-9]/.test(text[i + 1])) continue;
      const content = text.slice(start + 1, i);
      if (!content.trim() || isCurrency(content)) return -1;
      return i;
    }
    return NO_CLOSER;
  }

  function placeholder(index, tex, display) {
    const attrs = [
      'class="qmath"',
      "data-qmath",
      'role="math"',
      `aria-label="${escapeHtml(tex)}"`,
      display ? 'data-display="1"' : ""
    ].filter(Boolean).join(" ");
    const span = `<span ${attrs}></span>`;
    return display ? `<span class="math-block">${span}</span>` : span;
  }

  function prepare(markdown) {
    const source = String(markdown ?? "");
    const formulas = [];
    let text = "";
    let i = 0;
    // Where each closer is known to be absent, so a reply full of openers stays linear.
    const missing = new Map();
    const closerEnd = (from, closer, allowNewline) => {
      if (from < (missing.get(closer) ?? 0)) return -1;
      const end = delimiterEnd(source, from, closer, allowNewline);
      if (end < 0) {
        const newline = allowNewline ? -1 : source.indexOf("\n", from);
        missing.set(closer, newline < 0 ? source.length : newline);
      }
      return end;
    };

    const add = (tex, display) => {
      const index = formulas.length;
      formulas.push({ token: `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`, tex, display, html: placeholder(index, tex, display) });
      text += `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
    };

    while (i < source.length) {
      const atLineStart = i === 0 || source[i - 1] === "\n";
      if (atLineStart && (source[i] === "`" || source[i] === "~")) {
        const end = fenceEnd(source, i);
        if (end > i) { text += source.slice(i, end); i = end; continue; }
      }

      const ch = source[i];
      if (ch === "\\") {
        const next = source[i + 1];
        if (next === "$" || next === "`" || next === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (next === "(" || next === "[") {
          const display = next === "[";
          const end = closerEnd(i + 2, display ? "\\]" : "\\)", display);
          if (end >= 0) {
            const tex = source.slice(i + 2, end);
            if (tex.trim()) { add(tex, display); i = end + 2; continue; }
          }
          // Keep an incomplete opener visible as literal text; a lone `\(`
          // would otherwise be swallowed by Markdown's backslash escaping.
          text += "\\\\" + next;
          i += 2;
          continue;
        }
        text += ch;
        i++;
        continue;
      }

      if (ch === "`") {
        const end = codeSpanEnd(source, i);
        text += source.slice(i, end);
        i = end;
        continue;
      }

      if (ch === "$") {
        if (source[i + 1] === "$") {
          const end = closerEnd(i + 2, "$$", true);
          if (end >= 0) {
            const tex = source.slice(i + 2, end);
            if (tex.trim()) { add(tex, true); i = end + 2; continue; }
          }
          text += "$$";
          i += 2;
          continue;
        }
        const end = i < (missing.get("$") ?? 0) ? -1 : inlineDollarEnd(source, i);
        if (end === NO_CLOSER) {
          const newline = source.indexOf("\n", i);
          missing.set("$", newline < 0 ? source.length : newline);
        }
        if (end >= 0) {
          add(source.slice(i + 1, end), false);
          i = end + 1;
          continue;
        }
        text += ch;
        i++;
        continue;
      }

      text += ch;
      i++;
    }

    // An unclosed formula is left as plain text; once its closer streams in the
    // whole reply is re-prepared and the formula appears.
    if (formulas.length) load();
    return { text, formulas };
  }

  function load() {
    if (loader) return loader;
    loader = new Promise((resolve) => {
      const styles = document.createElement("link");
      styles.rel = "stylesheet";
      styles.href = KATEX_STYLES;
      document.head.append(styles);
      const script = document.createElement("script");
      script.src = KATEX_SCRIPT;
      script.async = true;
      script.addEventListener("load", () => {
        ready = typeof window.katex?.renderToString === "function";
        failed = !ready;
        resolve();
        paintAll();
      });
      script.addEventListener("error", () => {
        failed = true;
        resolve();
        paintAll();
      });
      document.head.append(script);
    });
    return loader;
  }

  function renderTex(tex, display) {
    const key = `${display ? "d" : "i"}:${tex}`;
    if (rendered.has(key)) return rendered.get(key);
    let html;
    try {
      if (typeof window.katex?.renderToString !== "function") throw new Error("KaTeX unavailable");
      html = window.katex.renderToString(tex, {
        throwOnError: false,
        displayMode: display,
        output: "html",
        trust: false
      });
      if (/class="katex-error"/.test(html)) throw new Error("Invalid TeX");
    } catch (_) {
      html = `<code class="math-raw">${escapeHtml(tex)}</code>`;
    }
    // QChat stays running for days, so the cache can't grow with every formula it ever saw.
    if (rendered.size >= 500) rendered.clear();
    rendered.set(key, html);
    return html;
  }

  function paint(node) {
    const tex = node.getAttribute("aria-label") || "";
    const display = node.getAttribute("data-display") === "1";
    const key = `${display ? "d" : "i"}:${tex}`;
    if (node.dataset.math === key) return;
    node.innerHTML = renderTex(tex, display);
    node.dataset.math = key;
  }

  function paintAll() {
    for (const node of document.querySelectorAll("[data-qmath]")) paint(node);
  }

  function renderInto(root) {
    if (!root?.querySelectorAll) return;
    const nodes = root.querySelectorAll("[data-qmath]");
    if (!nodes.length) return;
    if (!ready && !failed) { load(); return; }
    for (const node of nodes) paint(node);
  }

  window.QMath = { prepare, renderInto };
})();
