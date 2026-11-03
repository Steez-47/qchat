// What a live reply shows while it streams: every finished block as it is, plus the block still
// being written, patched up so its unfinished markup never shows raw (see liveView).
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
  function completeBoundary(text, cache) {
    // Resume only after a closed top-level block and a physical newline. List
    // siblings and unfinished scopes still need their earlier parsing context.
    // A corrected snapshot invalidates the checkpoint if its prefix changed.
    const prefix = cache?.prefix && text.startsWith(cache.prefix) ? cache.prefix : '';
    text = text.slice(prefix.length);
    let checkpoint = 0;
    const finish = end => {
      if (cache) cache.prefix = prefix + text.slice(0, checkpoint);
      return prefix.length + end;
    };
    let fence = null, offset = 0, end = 0, math = null, mathFresh = false, inline = null, container = false;
    let skipUntil = 0, prevBlank = true, scopeFresh = false, listIndent = 0, rootListIndent = null;
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
      // A sibling with real content proves that the previous item is finished. Keep
      // the current item (including its nested lists, tags and code) buffered.
      const sibling = !fence && !math && !inline && !tags.length && skipUntil <= offset &&
        /^( {0,3})(?:[-+*]|\d+[.)]) +\S/.exec(line);
      if (sibling) {
        const indent = sibling[1].length;
        if (rootListIndent !== null && indent <= rootListIndent) end = Math.max(end, offset);
        if (!container || rootListIndent !== null && indent <= rootListIndent) rootListIndent = indent;
      }
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
              if (body.partial) return finish(end);
              if (!tags.length && !line.slice(0, i).trim()) releaseAfter(body.end);
              skipUntil = body.end;
              i = body.end - offset;
              continue;
            }
            const directive = window.QResponseTags.eachAt(text, offset + i);
            if (directive) {
              if (directive.partial) return finish(end);
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
            if (tag.partial) return finish(end);
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
          if (!math && !tags.length && (!container || !continuation)) { end = next; container = false; listIndent = 0; rootListIndent = null; }
        }
      }
      prevBlank = !fence && !math && !line.trim();
      if (!last && end === next && !container && !fence && !math && !inline && !tags.length && skipUntil <= next) checkpoint = next;
      offset = next;
    }
    return finish(end);
  }

  // Blanks inline code so markup inside it is ignored, keeping every offset valid.
  const blankCode = (text) => text.replace(/(`+)[^\n]*?\1/g, code => " ".repeat(code.length));

  // Whether an emphasis run is left open. A marker closes after text and opens before it, so
  // "*a* b" is closed and "2 * 3" opens nothing. Escaped markers are literal.
  function unclosed(text, marker) {
    let open = false;
    for (const match of text.matchAll(marker)) {
      const before = text[match.index - 1] || " ", after = text[match.index + match[0].length] || " ";
      if (before === "\\") continue;
      if (open && /\S/.test(before)) open = false;
      else if (!open && /\S/.test(after)) open = true;
    }
    return open;
  }

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
      // Closers go before trailing spaces: "**word **" is not emphasis.
      const space = /\s*$/.exec(out)[0];
      out = out.slice(0, out.length - space.length);
      const stripped = out.replace(/`[^`]*`/g, "");
      if (unclosed(stripped, /\*\*/g)) out += "**";
      if (unclosed(out.replace(/`[^`]*`/g, "").replace(/\*\*/g, ""), /\*/g)) out += "*";
      if (unclosed(stripped, /~~/g)) out += "~~";
      out += space;
    }
    return out;
  }

  // What should be rendered for this tail right now. The canonical text is untouched.
  function stabilize(text) {
    return stabilizeMarkdown(window.QResponseTags.stabilize(text));
  }

  // Closes open emphasis on the last line and holds back a half-typed fence opener, table row,
  // link URL or display formula. Response tags are left for the renderer.
  function stabilizeMarkdown(source) {
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
    // Bare block markers: nothing to show until their first word. A link reference
    // definition waits for its whole line, so no link points at half a URL.
    if (/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s*$/.test(last) || /^ {0,3}\[[^\]\n]+\]:/.test(last)) last = "";
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
      // Markdown markers go with their word: an opener with the word after it, a closer
      // with the word before it, so "**" never shows half typed.
      if (/^[*_~`]+$/.test(part.segment)) {
        let start = from + part.index;
        while (start > 0 && /[*_~`]/.test(text[start - 1])) start--;
        if (start === 0 || /\s/.test(text[start - 1])) continue;
        if (stops.length) stops[stops.length - 1] = end; else stops.push(end);
        continue;
      }
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

  // Where the unfinished block stops being safe to show: at the outermost tag, {#each} or
  // {@body} scope that has not closed yet, or at an inline formula still being written.
  // Closed tags (citations, inline marks) are fine, and code content is literal.
  function liveEnd(text) {
    const tags = [];
    let fence = null, inline = null;
    const cut = at => tags.length ? tags[0].at : at;
    for (let i = 0; i < text.length;) {
      if (!tags.length && !inline && (i === 0 || text[i - 1] === "\n")) {
        const nl = text.indexOf("\n", i), stop = nl < 0 ? text.length : nl;
        const match = /^(?:\s*(?:>|[-+*]\s|\d+[.)]\s))*\s*(`{3,}|~{3,})(.*)$/.exec(text.slice(i, stop));
        if (match && !fence) fence = { marker: match[1][0], size: match[1].length };
        else if (match && match[1][0] === fence.marker && match[1].length >= fence.size && !match[2].trim()) fence = null;
        if (match || fence) { i = stop + 1; continue; }
      }
      const c = text[i];
      const top = tags.at(-1)?.name || "";
      if (LITERAL_TAG.test(top)) {
        const close = new RegExp("</" + top + "\\s*>", "i").exec(text.slice(i));
        if (!close) return cut(i);
        tags.pop();
        i += close.index + close[0].length;
        continue;
      }
      const run = /^`+/.exec(text.slice(i, i + 16));
      if (run) { inline = !inline ? run[0] : inline === run[0] ? null : inline; i += run[0].length; continue; }
      if (inline) { i++; continue; }
      if (c === "\\") { i += 2; continue; }
      // A citation token is whole once its closing mark arrives.
      if (c === "") { const close = text.indexOf("", i); if (close < 0) return cut(i); i = close + 1; continue; }
      if (c === "$" && text[i + 1] !== "$" && text[i - 1] !== "$") {
        // Currency ($5, $ 5) is prose. Anything else is a formula until its closer arrives.
        if (i + 1 >= text.length) return cut(i);
        if (!/[\s\d]/.test(text[i + 1])) {
          const to = window.QResponseTags.mathEnd(text, i);
          if (to <= i) return cut(i);
          i = to;
          continue;
        }
      }
      if (c === "{") {
        const body = window.QResponseTags.bodyAt(text, i);
        if (body) { if (body.partial) return cut(i); i = body.end; continue; }
        const each = window.QResponseTags.eachAt(text, i);
        if (each) {
          if (each.partial) return cut(i);
          const at = tags.map(t => t.name).lastIndexOf("@each");
          if (!each.close) tags.push({ name: "@each", at: i });
          else if (at >= 0) tags.length = at;
          i = each.end;
          continue;
        }
      }
      if (c === "<" && /^<\/?[a-zA-Z]/.test(text.slice(i, i + 3))) {
        // The same tag rules as completeBoundary: prose generics (List<Item>) are not tags.
        const tag = window.QResponseTags.tagAt(text, i);
        const semantic = tag && (SEMANTIC_TAG.test(tag.name.toLowerCase()) || (/^[A-Z]/.test(tag.name) && (tag.self || Object.keys(tag.attrs || {}).length)));
        if (!tag || (/[\p{L}\p{N}]/u.test(text[i - 1] || "") && !tag.close && !semantic)) { i++; continue; }
        if (tag.partial) return cut(i);
        const name = tag.name.toLowerCase();
        const at = tags.map(t => t.name).lastIndexOf(name);
        if (tag.close) { if (at >= 0) tags.length = at; }
        else if (!tag.self && !VOID_TAG.test(name)) tags.push({ name, at: i });
        i = tag.end;
        continue;
      }
      i++;
    }
    return cut(text.length);
  }

  // The text to show for a live snapshot: complete blocks untouched, then the block still being
  // written up to where it is safe, with its open markup closed. Layout and interactive scopes,
  // display maths, fence openers and table rows only ever appear whole.
  function liveView(text, cache) {
    const boundary = completeBoundary(text, cache);
    const head = text.slice(0, boundary);
    let tail = text.slice(boundary);
    if (!/\S/.test(tail)) return head;
    // A lone "<" or "</" at the very end may be the start of a tag.
    tail = tail.slice(0, liveEnd(tail)).replace(/<\/?$/, "");
    if (!/\S/.test(tail) || window.QResponseTags.hasInteractive(tail)) return head;
    return head + stabilizeMarkdown(tail);
  }

  // The first grapheme boundary at or after `at`. A snapshot can extend a character that was
  // already shown (e + ́, 👩 + ‍💻), so a reveal position must never sit inside one.
  function graphemeEnd(text, at) {
    if (at <= 0 || at >= text.length) return Math.max(0, Math.min(at, text.length));
    const start = Math.max(0, text.lastIndexOf("\n", at - 1), at - 64);
    for (const part of graphemes.segment(text.slice(start, at + 64))) {
      const end = start + part.index + part.segment.length;
      if (start + part.index === at || end >= at) return start + part.index === at ? at : end;
    }
    return text.length;
  }

  window.QStream = { stabilize, stableBoundary, completeBoundary, liveView, revealStops, graphemeEnd };
})();
