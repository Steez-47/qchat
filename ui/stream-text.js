// Turns a partial Markdown stream into something safe to render on every frame: unfinished
// syntax is closed or held back so text never flashes as raw markers and then jumps.
// Also finds the point before which a stream can no longer change, so only the tail is reparsed.
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

  // Everything before the returned index is finished for reading: paragraphs end at a blank
  // line, while list items, table rows, quotes, headings and code lines end at their newline.
  function completeBoundary(text) {
    let fence = null, offset = 0, end = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      const next = offset + line.length + 1;
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match) {
        if (!fence) fence = { marker: match[1][0], size: match[1].length };
        else if (match[1][0] === fence.marker && match[1].length >= fence.size && !match[2].trim()) fence = null;
        end = next;
      } else if (fence || !line.trim() || /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#{1,6}\s)/.test(line)) {
        end = next;
      }
      offset = next;
    }
    return end;
  }

  function closeInline(line) {
    let out = line;
    // A link still being typed shows its label only; the URL appears once it is whole.
    out = out.replace(/\[([^\]\n]*)\]\([^)\n]*$/, "$1");
    out = out.replace(/\[([^\]\n]*)\]$/, "[$1]");
    const lastOpen = out.lastIndexOf("[");
    if (lastOpen >= 0 && out.indexOf("]", lastOpen) < 0) out = out.slice(0, lastOpen) + out.slice(lastOpen + 1);

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
    const dollars = source.lastIndexOf("$$");
    if (dollars >= 0 && (source.slice(0, dollars).match(/\$\$/g) || []).length % 2 === 0) source = source.slice(0, dollars);
    const bracket = source.lastIndexOf("\\[");
    if (bracket >= 0 && source.indexOf("\\]", bracket) < 0) source = source.slice(0, bracket);
    const paren = source.lastIndexOf("\\(");
    if (paren >= 0 && source.indexOf("\\)", paren) < 0) source = source.slice(0, paren);

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
