// Finds finished blocks for buffered response display. Legacy stabilization and reveal
// helpers remain available, but live replies only use completeBoundary.
(function () {
  "use strict";

  // Fence state from the start of a line, per CommonMark's opener and closer rules.
  function scanFences(text) {
    let open = null, offset = 0;
    for (const line of text.split("\n")) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!open) open = { marker: match[1][0], size: match[1].length, at: offset };
        else if (match[1][0] === open.marker && match[1].length >= open.size && !match[2].trim()) open = null;
      }
      offset += line.length + 1;
    }
    return open;
  }

  // Everything before the returned index is complete blocks. A blank line only ends a
  // block when what follows cannot continue it: list items and indented text can.
  function stableBoundary(text) {
    let boundary = 0, fence = null, offset = 0, blank = false;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!fence) {
          if (blank) boundary = offset;
          fence = { marker: match[1][0], size: match[1].length };
        } else if (match[1][0] === fence.marker && match[1].length >= fence.size && !match[2].trim()) {
          fence = null;
        }
      } else if (!fence) {
        const isBlank = !line.trim();
        // The block may still grow if it is a list, a table, a quote or indented continuation.
        if (blank && !isBlank && !/^(\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line)) boundary = offset;
        blank = isBlank;
        offset += line.length + 1;
        continue;
      }
      blank = false;
      offset += line.length + 1;
    }
    return boundary;
  }

  const LITERAL_TAG = /^(pre|code|script|style|iframe|svg|object|template)$/;
  const VOID_TAG = /^(area|base|br|col|embed|hr|img|input|meta|param|source|track|wbr|divider|asyncimage|asyncimagegroup|entity|cite|icon)$/;
  const INLINE_TAG = /^(a|b|i|s|u|em|strong|del|ins|mark|sub|sup|span|code|kbd|small|abbr)$/;
  const SEMANTIC_TAG = /^(?:a$|b$|i$|s$|u$|em$|strong$|del$|ins$|mark$|sub$|sup$|span$|code$|pre$|div$|p$|box$|text$|section$|blockquote$|h[1-6]$)/;

  // The largest prefix of finished blocks: the only text a response ever shows while it streams.
  // Prose ends at a blank line. A fence, display maths, tag or {#each} scope ends at its real closer
  // (at once, even with no newline after it), and never at a blank line inside the scope.
  function completeBoundary(text) {
    let fence = null, offset = 0, end = 0, math = null, mathFresh = false, inline = null, container = false;
    let skipUntil = 0, prevBlank = true, scopeFresh = false, listIndent = 0;
    const tags = [];
    const lines = text.split("\n");
    // Release a finished block, unless a list or quote may still continue around it.
    const release = (to) => { if (!container && to > end) end = to; };
    const releaseAfter = (at) => {
      const nl = text.indexOf("\n", at), stop = nl < 0 ? text.length : nl;
      release(!/\S/.test(text.slice(at, stop)) ? (nl < 0 ? text.length : nl + 1) : at);
    };
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n], last = n === lines.length - 1;
      const next = offset + line.length + (last ? 0 : 1);
      const fresh = prevBlank || offset === end;
      // A closer belongs to the opener's quote/list context. A list marker or a
      // four-space indent inside a top-level fence is code, not a closing fence.
      let fenceLine = line.replace(/\r$/, "").replace(/\t/g, "    "), quotes = 0, quote;
      while ((quote = /^ {0,3}> ?/.exec(fenceLine))) { quotes++; fenceLine = fenceLine.slice(quote[0].length); }
      const list = !fence && /^ {0,3}(?:[-+*]|\d+[.)]) +/.exec(fenceLine);
      if (!fence && !math && !tags.length && list) listIndent = list[0].length;
      const indent = /^ */.exec(fenceLine)[0].length;
      const baseIndent = fence ? fence.baseIndent : list ? list[0].length : (listIndent && indent >= listIndent ? listIndent : 0);
      const sameContext = !fence || (quotes === fence.quotes && indent >= baseIndent);
      const match = skipUntil <= offset && sameContext && /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(fenceLine.slice(baseIndent));
      const literalTop = LITERAL_TAG.test(tags.at(-1) || "");
      if (!fence && !math && !tags.length && /^ {0,3}(?:[-+*]\s|\d+[.)]\s|>)/.test(line)) container = true;
      if (!math && !inline && !literalTop && match) {
        if (!fence) fence = { marker: match[1][0], size: match[1].length, quotes, baseIndent };
        else if (match[1][0] === fence.marker && match[1].length >= fence.size && !match[2].trim()) {
          fence = null;
          if (!tags.length) release(next);
        }
      } else if (!fence) {
        for (let i = Math.max(0, skipUntil - offset); i < line.length;) {
          if (math) {
            if (line.startsWith(math, i)) {
              i += math.length;
              const display = math !== "\\)";
              math = null;
              if (display && mathFresh && !/\S/.test(line.slice(i))) release(next);
            } else i += line[i] === "\\" ? 2 : 1;
            continue;
          }
          // HTML code and inert script bodies are literal until their matching closer.
          const raw = tags.at(-1);
          if (LITERAL_TAG.test(raw || "") && (line[i] !== "<" || !new RegExp("^</" + raw + "\\s*>", "i").test(line.slice(i)))) { i++; continue; }
          const run = /^`+/.exec(line.slice(i));
          if (run) { if (!inline) inline = run[0]; else if (inline === run[0]) inline = null; i += run[0].length; continue; }
          if (inline) { i++; continue; }
          // Share the renderer's currency-aware inline math rules. Markup inside a
          // finished $...$ expression is literal, including strings like <section>.
          if (line[i] === "$" && !line.startsWith("$$", i)) {
            const to = window.QResponseTags.mathEnd(text, offset + i);
            if (to > offset + i) { i = to - offset; continue; }
          }
          const opener = line.startsWith("$$", i) ? "$$" : line.startsWith("\\[", i) ? "\\]" : line.startsWith("\\(", i) ? "\\)" : null;
          if (opener) {
            math = opener;
            mathFresh = fresh && !tags.length && !container && !line.slice(0, i).trim();
            i += 2;
            continue;
          }
          if (line[i] === "\\") { i += 2; continue; }
          if (line[i] === "{") {
            const body = window.QResponseTags.bodyAt(text, offset + i);
            if (body) {
              if (body.partial) return end;
              if (!tags.length && !line.slice(0, i).trim()) releaseAfter(body.end);
              skipUntil = body.end;
              i = body.end - offset;
              continue;
            }
            const directive = window.QResponseTags.eachAt(text, offset + i);
            if (directive) {
              if (directive.partial) return end;
              if (directive.close) {
                const index = tags.lastIndexOf("@each");
                if (index >= 0 && index === tags.length - 1) {
                  tags.length = index;
                  if (!tags.length && scopeFresh) releaseAfter(directive.end);
                }
              } else {
                if (!tags.length) scopeFresh = offset + i === end || (fresh && !line.slice(0, i).trim());
                tags.push("@each");
              }
              skipUntil = directive.end;
              i = directive.end - offset;
              continue;
            }
          }
          if (line[i] === "<" && /^<\/?[a-zA-Z]/.test(line.slice(i))) {
            // Share the renderer's quote/JSX-aware tokenizer; comparisons aren't tag prefixes.
            const at = offset + i;
            const tag = window.QResponseTags.tagAt(text, at);
            // Prose generics (Array<object>, List<Item>) are not tags; a letter before "<" needs
            // a recognised element, or a component that clearly has attributes or self-closes.
            const semantic = tag && (SEMANTIC_TAG.test(tag.name.toLowerCase()) || (/^[A-Z]/.test(tag.name) && (tag.self || Object.keys(tag.attrs || {}).length)));
            if (!tag || (/[\p{L}\p{N}]/u.test(text[at - 1] || "") && !tag.close && !semantic)) { i++; continue; }
            // A closer or attribute still arriving: nothing from here is finished.
            if (tag.partial) return end;
            const name = tag.name.toLowerCase();
            if (tag.close) {
              const index = tags.lastIndexOf(name);
              if (index >= 0 && index === tags.length - 1) {
                tags.length = index;
                if (!tags.length && scopeFresh) releaseAfter(tag.end);
              }
            } else if (!tag.self && !VOID_TAG.test(name)) {
              if (!tags.length) scopeFresh = !INLINE_TAG.test(name) && (offset + i === end || (fresh && !line.slice(0, i).trim()));
              tags.push(name);
            } else if (!tags.length && (offset + i === end || (fresh && !line.slice(0, i).trim()))) {
              releaseAfter(tag.end);
            }
            // Skip the complete token, including any following physical lines.
            skipUntil = tag.end;
            i = tag.end - offset;
            continue;
          }
          i++;
        }
        // Inline math cannot span physical lines; display math remains buffered.
        if (math === "\\)") math = null;
        if (!last && !line.trim() && skipUntil <= offset) {
          // An unmatched backtick is literal once its paragraph ends.
          inline = null;
          const following = container ? /^(?:[ \t\r]*\n)*([^\n]*)/.exec(text.slice(next))[1] : "";
          const continuation = container && (!following || /^(?:\s|[-+*](?:\s|$)|\d+(?:[.)](?:\s|$)|$)|>)/.test(following));
          if (!math && !tags.length && (!container || !continuation)) { end = next; container = false; listIndent = 0; }
        }
      }
      prevBlank = !fence && !math && !line.trim();
      offset = next;
    }
    return end;
  }

  // Blanks inline code so markup inside it is ignored, keeping every offset valid.
  const blankCode = (text) => text.replace(/(`+)[^\n]*?\1/g, code => " ".repeat(code.length));

  function closeInline(line) {
    let out = line;
    const prose = () => {
      const blank = blankCode(out), open = blank.indexOf("`");
      return open < 0 ? blank : blank.slice(0, open) + " ".repeat(blank.length - open);
    };
    // A link still being typed shows its label only; the URL appears once it is whole.
    const link = /\[([^\]\n]*)\]\([^)\n]*$/.exec(prose());
    if (link) out = out.slice(0, link.index) + out.slice(link.index + 1, link.index + 1 + link[1].length);
    const text = prose(), lastOpen = text.lastIndexOf("[");
    if (lastOpen >= 0 && text.indexOf("]", lastOpen) < 0) out = out.slice(0, lastOpen) + out.slice(lastOpen + 1);

    // Inline code first: markers inside it are literal.
    const codeRuns = out.match(/`+/g) || [];
    let inCode = false;
    if (codeRuns.length % 2) { out += "`"; inCode = true; }
    if (!inCode) {
      // A lone marker at the very end has nothing to emphasise yet.
      if (/(^|\s)\*{1,3}$/.test(out.replace(/`[^`]*`/g, ""))) out = out.replace(/\*{1,3}$/, "");
      const stripped = out.replace(/`[^`]*`/g, "");
      if ((stripped.match(/\*\*/g) || []).length % 2) out += "**";
      const afterBold = out.replace(/`[^`]*`/g, "").replace(/\*\*/g, "");
      if ((afterBold.match(/(^|[^\\\s*])\*(?=\S)|(^|\s)\*(?=\S)/g) || []).length % 2) out += "*";
      if ((stripped.match(/~~/g) || []).length % 2) out += "~~";
    }
    return out;
  }

  // What should be rendered for this tail right now. The canonical text is untouched.
  function stabilize(text) {
    let source = window.QResponseTags.stabilize(text);
    const fence = scanFences(source);
    if (fence) {
      // Keep the opener line out until its language is known; the block appears whole.
      const rest = source.slice(fence.at);
      return rest.includes("\n") ? source : source.slice(0, fence.at);
    }
    // A fence opener still being typed.
    source = source.replace(/(^|\n) {0,3}(`{1,2}|~{1,2})$/, "$1");

    // Display maths: hold from the opener until it closes.
    // Delimiters shown as inline code are not openers; blanking keeps the offsets valid.
    const prose = () => blankCode(source);
    let plain = prose();
    const dollars = plain.lastIndexOf("$$");
    if (dollars >= 0 && (plain.slice(0, dollars).match(/\$\$/g) || []).length % 2 === 0) { source = source.slice(0, dollars); plain = prose(); }
    const bracket = plain.lastIndexOf("\\[");
    if (bracket >= 0 && plain.indexOf("\\]", bracket) < 0) { source = source.slice(0, bracket); plain = prose(); }
    const paren = plain.lastIndexOf("\\(");
    if (paren >= 0 && plain.indexOf("\\)", paren) < 0) source = source.slice(0, paren);

    const cut = source.lastIndexOf("\n") + 1;
    const head = source.slice(0, cut);
    let last = source.slice(cut);

    // A table appears once its separator row has arrived, and only with whole rows.
    if (/^\s*\|/.test(last)) {
      const before = head.trimEnd().split("\n").pop() || "";
      const inTable = /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(before) || /^\s*\|/.test(before);
      const pipes = (line) => (line.match(/\|/g) || []).length;
      if (!inTable || !/\|\s*$/.test(last) || pipes(last) < pipes(before)) last = "";
    }
    const lines = (head + last).split("\n");
    // A header row with no separator yet is not a table, so do not show it as prose.
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end--;
    if (end > 0 && /^\s*\|.*\|\s*$/.test(lines[end - 1]) && !(end > 1 && /^\s*\|/.test(lines[end - 2]))) {
      lines.length = end - 1;
      return lines.join("\n");
    }
    if (end > 1 && /^\s*\|?[\s:|-]+$/.test(lines[end - 1]) && /-/.test(lines[end - 1]) && /^\s*\|/.test(lines[end - 2]) && !/\|\s*$/.test(lines[end - 1])) {
      lines.length = end - 2;
      return lines.join("\n");
    }
    // Bare block markers: nothing to show until their first word.
    if (/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s*$/.test(last)) last = "";
    else if (last) {
      const marker = /^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)*)(.*)$/.exec(last);
      last = marker[1] + closeInline(marker[2]);
    }
    return head + last;
  }

  // Word-sized reveal units as string offsets: never inside a grapheme, and capped so
  // an unbroken run (a URL, base64) still flows instead of arriving in one lump.
  const words = new Intl.Segmenter(undefined, { granularity: "word" });
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  function revealStops(text, from = 0, cap = 14) {
    const stops = [];
    for (const part of words.segment(text.slice(from))) {
      const end = from + part.index + part.segment.length;
      // Spaces and closing punctuation belong to the word before them.
      if (stops.length && /^[\s.,;:!?)\]'"’”…]+$/.test(part.segment)) { stops[stops.length - 1] = end; continue; }
      if (part.segment.length <= cap) { stops.push(end); continue; }
      let at = from + part.index, run = 0;
      for (const g of graphemes.segment(part.segment)) {
        run += g.segment.length;
        if (run >= cap) { at += run; stops.push(at); run = 0; }
      }
      if (run) stops.push(at + run);
    }
    return stops;
  }

  window.QStream = { stabilize, stableBoundary, completeBoundary, revealStops };
})();
