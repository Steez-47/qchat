(function () {
  'use strict';

  function indices(text, query) {
    if (!query) return [];
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, 'giu');
    const results = [];
    for (const match of text.matchAll(regex)) {
      results.push({ start: match.index, end: match.index + match[0].length });
    }
    return results;
  }

  function ranges(root, query) {
    if (!query) return [];
    const doc = root.ownerDocument || root;
    const view = doc.defaultView;
    const filter = view.NodeFilter;
    const blocks = new Set(['P', 'LI', 'PRE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
    const excluded = 'button,input,textarea,select,script,style,.code-header,.selection-chip,.katex-mathml,[hidden]';
    const results = [];

    function invisible(element) {
      if (element.matches(excluded)) return true;
      const style = view.getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }

    for (const row of root.querySelectorAll('.history-row')) {
      let logical = '';
      const segments = [];
      function addText(node) {
        if (!node.data) return;
        const start = logical.length;
        logical += node.data;
        segments.push({ start, end: logical.length, node });
      }
      function boundary(element, after) {
        if (!logical || logical.endsWith('\n')) return;
        const start = logical.length;
        logical += '\n';
        segments.push({ start, end: logical.length, boundary: element, after });
      }
      for (const content of row.querySelectorAll('.turn-content')) {
        if (content.closest('.history-row') !== row) continue;
        let hidden = false;
        for (let el = content; el; el = el.parentElement) {
          if (invisible(el)) { hidden = true; break; }
          if (el === root) break;
        }
        if (hidden) continue;
        if (logical) boundary(content, false);
        const walker = doc.createTreeWalker(content, filter.SHOW_ELEMENT | filter.SHOW_TEXT, {
          acceptNode(node) {
            if (node.nodeType === 1 && (invisible(node) || node.matches('.history-row'))) return filter.FILTER_REJECT;
            return filter.FILTER_ACCEPT;
          }
        });
        const openBlocks = [];
        let node;
        while ((node = walker.nextNode())) {
          while (openBlocks.length && !openBlocks[openBlocks.length - 1].contains(node)) {
            boundary(openBlocks.pop(), true);
          }
          if (node.nodeType === 3) addText(node);
          else if (node.tagName === 'BR') boundary(node, false);
          else if (blocks.has(node.tagName)) {
            boundary(node, false);
            openBlocks.push(node);
          }
        }
        while (openBlocks.length) boundary(openBlocks.pop(), true);
      }
      const matches = indices(logical, query);
      let startIndex = 0;
      let endIndex = 0;
      function point(segment, offset) {
        if (segment.node) return [segment.node, offset - segment.start];
        // Resolve sibling positions only for matches touching a line break;
        // computing these for every paragraph makes long histories quadratic.
        const element = segment.boundary, parent = element.parentNode;
        const index = Array.prototype.indexOf.call(parent.childNodes, element) + (segment.after ? 1 : 0);
        return [parent, index + (offset === segment.end && element.tagName === 'BR' ? 1 : 0)];
      }
      for (const match of matches) {
        while (startIndex < segments.length - 1 && segments[startIndex].end <= match.start) startIndex++;
        if (endIndex < startIndex) endIndex = startIndex;
        while (endIndex < segments.length - 1 && segments[endIndex].end < match.end) endIndex++;
        const start = point(segments[startIndex], match.start);
        const end = point(segments[endIndex], match.end);
        const range = doc.createRange();
        range.setStart(start[0], start[1]);
        range.setEnd(end[0], end[1]);
        results.push({ range, key: row.dataset.id + ':' + match.start });
      }
    }
    return results;
  }

  window.QFindText = { indices, ranges };
})();
