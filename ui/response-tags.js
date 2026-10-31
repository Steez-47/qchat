(function () {
  'use strict';
  let shieldSerial = 0;
  // Each pass owns its placeholders, including nested conversions and literal private-use text.
  function escaped(text, at) {
    let slashes = 0;
    while (at > 0 && text[--at] === '\\') slashes++;
    return slashes % 2 === 1;
  }
  function mathEnd(text, at) {
    const opener = text.startsWith('$$', at) ? '$$' : text.startsWith('\\[', at) ? '\\[' : text.startsWith('\\(', at) ? '\\(' : text[at] === '$' ? '$' : '';
    if (!opener || escaped(text, at) || (opener === '$' && /\s|^$/.test(text[at + 1] || ''))) return at;
    const closer = opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener;
    for (let j = at + opener.length; j < text.length; j++) {
      if ((opener === '$' || opener === '\\(') && text[j] === '\n') return at;
      if (text.startsWith(closer, j) && !escaped(text, j) && (opener !== '$' || (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] || '')))) return j + closer.length;
    }
    return opener === '$' ? at : text.length;
  }
  function protect(text, fn, transform = raw => raw) {
    let prefix;
    do { prefix = `\uE100q${shieldSerial++}:`; } while (text.includes(prefix));
    const saved = []; let out = '', i = 0, start = 0;
    while (i < text.length) {
      let end = i, html = null;
      const fence = (i === 0 || text[i - 1] === '\n') && /^(?:(?:[ \t]*>[ \t]?)|[ \t]*[-+*][ \t]+|[ \t]*\d+[.)][ \t]+)*[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(i));
      if (fence) {
        end = i + fence[0].length;
        const close = new RegExp('^(?:[ \\t]*>[ \\t]?)*[ \\t]*' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*$');
        while (end < text.length) { const n = text.indexOf('\n', end); const stop = n < 0 ? text.length : n; const line = text.slice(end, stop); end = n < 0 ? stop : stop + 1; if (close.test(line)) break; }
      } else if (text[i] === '<' && !escaped(text, i)) {
        const tag = tagAt(text, i);
        if (tag && !tag.partial) {
          if (!tag.close && !tag.self && /^(pre|code|script|style|iframe|svg|object|template)$/i.test(tag.name)) {
            const close = new RegExp('</' + tag.name + '\\s*>', 'ig'); close.lastIndex = tag.end;
            const match = close.exec(text);
            if (match || /^(pre|code)$/i.test(tag.name)) {
              end = match ? close.lastIndex : text.length;
              html = { ...tag, body: text.slice(tag.end, match ? match.index : text.length) };
            } else { i = tag.end; continue; }
          } else { i = tag.end; continue; }
        }
      } else if (mathEnd(text, i) > i) {
        end = mathEnd(text, i);
      } else if (text[i] === '`' && !escaped(text, i)) {
        const run = /^`+/.exec(text.slice(i))[0]; let at = i + run.length; end = text.length;
        while (at < text.length) { const next = text.indexOf('`', at); if (next < 0) break; const r = /^`+/.exec(text.slice(next))[0]; at = next + r.length; if (r.length === run.length) { end = at; break; } }
      }
      if (end > i) { out += text.slice(start, i) + prefix + saved.length + '\uE101'; saved.push(transform(text.slice(i, end), html)); i = end; start = i; } else i++;
    }
    out += text.slice(start);
    const restore = value => value.replace(new RegExp(prefix + '(\\d+)\uE101', 'g'), (_, n) => saved[n]);
    return restore(fn(out,restore));
  }
  function safeURL(value) { try { const u = new URL(String(value)); return /^(https?:|mailto:)$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; } }
  const escape = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const label = s => String(s ?? '').replace(/[\[\]\\\n]/g, ' ').replace(/</g, '&lt;');
  function decodeEntities(value) {
    return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (token, key) => {
      const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
      if (key[0] !== '#') return named[key.toLowerCase()];
      const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : token;
    });
  }
  const attributeLabel = value => escape(decodeEntities(value));
  function htmlCode(raw, tag) {
    if (!tag) return raw;
    if (/^(script|style|iframe|svg|object|template)$/i.test(tag.name)) return '';
    let body = tag.body;
    if (tag.name.toLowerCase() === 'pre') body = body.replace(/^\s*<code(?:\s[^>]*)?>/i, '').replace(/<\/code>\s*$/i, '');
    body = decodeEntities(body);
    const marker = tag.name.toLowerCase() === 'pre' ? '~' : '`';
    const size = (body.match(marker === '~' ? /~+/g : /`+/g) || []).reduce((max, run) => Math.max(max, run.length + 1), marker === '~' ? 3 : 1);
    const fence = marker.repeat(size);
    return marker === '~' ? '\n\n' + fence + '\n' + body + '\n' + fence + '\n\n' : fence + ' ' + body + ' ' + fence;
  }
  function literal(s) {
    s = s.trim();
    try { return JSON.parse(s); } catch (_) {}
    if (/^'(?:[^'\\]|\\.)*'$/.test(s)) return s.slice(1, -1).replace(/\\(['\\])/g, '$1');
    return undefined;
  }
  // A tag ends only outside quotes and balanced JSX data braces. No evaluation.
  function tagAt(s, at) {
    const head = /^<\/?([A-Za-z][\w:.-]*)/.exec(s.slice(at)); if (!head || !/^[\s/>]|^$/.test(s.slice(at + head[0].length))) return null;
    let i = at + head[0].length, assigned = 0; const attrs = Object.create(null), bare = [];
    const partial = () => {
      const plausible = bare.every(key => /^(disabled|checked|selected|multiple|readonly|open|required|autofocus|tabularnums)$/i.test(key));
      return (!bare.length || plausible || (!assigned && bare.length === 1 && /^[A-Z]/.test(head[1]))) ? {partial:true,end:s.length,name:head[1]} : null;
    };
    while (i < s.length) {
      while (/\s/.test(s[i] || '') && i < s.length) i++;
      const self = s.startsWith('/>', i);
      if (s[i] === '>' || self) { const end = i + (self ? 2 : 1); return {name:head[1],attrs,raw:s.slice(at,end),close:head[0][1]==='/',self,end}; }
      if (i === s.length) return partial();
      if (head[0][1] === '/') return null;
      const keyMatch = /^[A-Za-z_][\w:-]*/.exec(s.slice(i)); if (!keyMatch) return null;
      const key = keyMatch[0].toLowerCase(); i += keyMatch[0].length;
      while (/\s/.test(s[i] || '') && i < s.length) i++;
      if (s[i] !== '=') {
        attrs[key] = true; bare.push(key);
        if (s[i] && !/[\w\s/>]/.test(s[i])) return null;
        continue;
      }
      assigned++; i++;
      while (/\s/.test(s[i] || '') && i < s.length) i++;
      if (i === s.length) return partial();
      const first = s[i], start = i++;
      if (first === '"' || first === "'") {
        while (i < s.length && (s[i] !== first || escaped(s,i))) i++;
        if (i === s.length) return partial();
        attrs[key] = s.slice(start + 1, i++);
      } else if (first === '{') {
        let depth = 1, quote = '';
        for (; i < s.length && depth; i++) {
          const c = s[i];
          if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
          else if (c === '"' || c === "'") quote = c;
          else if (c === '{') depth++; else if (c === '}') depth--;
        }
        if (depth) return partial();
        attrs[key] = literal(s.slice(start + 1, i - 1));
      } else {
        i = start;
        while (i < s.length && !/[\s"'=<>`]/.test(s[i]) && !s.startsWith('/>',i)) i++;
        if (i === start) return null;
        attrs[key] = s.slice(start,i);
      }
      if (i < s.length && !/[\s/>]/.test(s[i])) return null;
    }
    return partial();
  }
  const inert = new Set('u ins mark sub sup table thead tbody tfoot tr th td dl dt dd details summary figure figcaption'.split(' '));
  const blocks = new Set('box row col column stack grid text card section div p article header footer main aside ul ol'.split(' '));
  const blocked = /^(script|style|iframe|svg|object|template)$/i;
  function readableBody(body) {
    if (!/^\s*\n/.test(body)) return body;
    const lines = body.split('\n'), nonblank = lines.filter(line => line.trim());
    const indent = nonblank.reduce((min,line) => Math.min(min,/^[ \t]*/.exec(line)[0].length), Infinity);
    return indent > 0 && Number.isFinite(indent) ? lines.map(line => line.slice(Math.min(indent,/^[ \t]*/.exec(line)[0].length))).join('\n') : body;
  }
  function toMarkdown(input, options = {}) {
    return protect(String(input ?? ''), (source,restore) => {
      const root = { children: [] }, stack = [root]; let i = 0, count = 0;
      const add = v => stack[stack.length - 1].children.push(v);
      while (i < source.length) {
        if (++count > 100000) break;
        if (source[i] !== '<' || escaped(source,i)) { const n = source.indexOf('<', i + 1); const part = source.slice(i, n < 0 ? source.length : n); add(n < 0 ? part : part.replace(i === 0 || source[i - 1] === '\n' ? /(^|\n)[ \t]+$/ : /(\n)[ \t]+$/, '$1')); i = n < 0 ? source.length : n; continue; }
        const auto = /^<(?:https?:\/\/|mailto:)[^<>\s]+>/.exec(source.slice(i));
        if (auto) { add(auto[0]); i += auto[0].length; continue; }
        const t = tagAt(source, i);
        if (!t) { add('&lt;'); i++; continue; }
        i = t.end; if (t.partial) break;
        const name = t.name.toLowerCase();
        if (t.close) { for (let j = stack.length - 1; j > 0; j--) if (stack[j].name.toLowerCase() === name) { stack.length = j; break; } continue; }
        if (blocked.test(name)) {
          const close = new RegExp('</' + name + '\\s*>', 'ig'); close.lastIndex = i;
          const match = close.exec(source);
          if (match) i = close.lastIndex;
          else if (!t.self) add(escape(t.raw));
          continue;
        }
        const node = { ...t, children: [] }; add(node);
        if (!t.self && (name === 'pre' || name === 'code')) {
          const close = new RegExp('</' + name + '\\s*>', 'ig'); close.lastIndex = i;
          const match = close.exec(source); let raw = source.slice(i, match ? match.index : source.length);
          if (name === 'pre') raw = raw.replace(/^<code(?:\s[^>]*)?>/, '').replace(/<\/code>$/, '');
          node.children.push(raw); i = match ? close.lastIndex : source.length; continue;
        }
        if (!t.self && !/^(br|hr|img|input|divider|asyncimage|asyncimagegroup|entity|cite|icon)$/.test(name) && stack.length < 128) stack.push(node);
      }
      const refs = value => {
        const list = (Array.isArray(value) ? value.flat() : String(value ?? '').split(/[\s,;\uE202]+/)).filter(x => typeof x === 'string').map(x => x.replace(/(?::L\d+(?:-L?\d+)?)$/, '')).filter(x => x && !/^L\d+(?:-L?\d+)?$/.test(x));
        return options.citation ? options.citation([...new Set(list)].join(' ')) : list.length ? '\uE200cite\uE202' + list.join('\uE202') + '\uE201' : '';
      };
      const render = node => {
        if (typeof node === 'string') return node;
        const n = node.name?.toLowerCase(), a = node.attrs || {}, body = node.children.map(render).join('');
        const attributeText = [a.value, a.title, a.label, a.children, a.text, a.alt].find(value => typeof value === 'string' || typeof value === 'number');
        const display = body || attributeLabel(attributeText);
        if (!n) return body;
        if (blocked.test(n)) return '';
        if (n === 'cite') return refs(a.refs ?? a.ref);
        if (n === 'entity') return label(display);
        if (n === 'link' || n === 'a') { const url = safeURL(a.href || a.url); return url ? '[' + label(display || url) + '](' + url.replace(/[()<>]/g, c => '%' + c.charCodeAt(0).toString(16)) + ')' : display; }
        if (n === 'asyncimage' || n === 'asyncimagegroup') return options.image ? (Array.isArray(a.query) ? a.query : [a.query]).map(q => options.image(q, '')).filter(Boolean).join(' ') : '';
        if (n === 'grid-item') { const image = node.children.find(c => typeof c !== 'string' && c.name.toLowerCase() === 'asyncimage'); if (image && options.image) { const caption = node.children.filter(c => c !== image).map(render).join('').replace(/[*\n]/g, ' ').trim(); return options.image(image.attrs.query, caption) + '\n'; } return '\n' + body + '\n'; }
        if (n === 'img') return options.media ? options.media(a.src, a.alt || '') : (a.alt ? attributeLabel(a.alt) : escape(node.raw));
        if (/^h[1-6]$/.test(n)) return '\n\n' + '#'.repeat(+n[1]) + ' ' + display.trim() + '\n\n';
        if (n === 'title' || n === 'b' || n === 'strong') return '**' + display + '**' + (n === 'title' ? ' ' : '');
        if (n === 'i' || n === 'em' || n === 'caption') return '*' + display + '*';
        if (/^(s|del|strike)$/.test(n)) return '~~' + display + '~~';
        if (n === 'br') return '\n';
        if (n === 'hr' || n === 'divider') return '\n\n---\n\n';
        if (n === 'ol' || n === 'ul') {
          let number = Number.isInteger(Number(a.start)) ? Number(a.start) : 1;
          const items = node.children.filter(c => typeof c !== 'string' && c.name.toLowerCase() === 'li');
          if (!items.length) return '\n\n' + body + '\n\n';
          return '\n\n' + items.map(item => {
            const marker = n === 'ol' ? `${number++}. ` : '- ';
            const content = restore(item.children.map(render).join('')).trim();
            return marker + content.split('\n').join('\n' + ' '.repeat(marker.length));
          }).join('\n') + '\n\n';
        }
        if (n === 'li') return '\n- ' + display.trim();
        if (n === 'blockquote') return '\n\n' + restore(body).trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        if (n === 'pre' || n === 'code') return body ? htmlCode('',{name:n,body}) : '';
        if (inert.has(n)) { const gap = /^(table|dl|details|figure)$/.test(n) ? '\n\n' : ''; return gap + '<' + n + '>' + body + '</' + n + '>' + gap; }
        if (blocks.has(n)) return '\n\n' + readableBody(display).trim() + '\n\n';
        return readableBody(display);
      };
      let rendered = render(root);
      if (root.children.some(c => typeof c !== 'string')) rendered = protect(rendered, s => s.replace(/\n{3,}/g, '\n\n'));
      return protect(rendered, prose => prose.replace(/\uE200([^\uE202\uE201]*)\uE202([^\uE201]*)\uE201/g, (all, family, r) => /^(cite|navlist|image)$/.test(family) ? (options.citation ? refs(r) : all) : '').replace(/\uE200[^\uE201]*$/, '').replace(/[\uE203-\uE206]/g, ''));
    }, htmlCode);
  }
  function hasLayout(text) {
    let found = false;
    protect(String(text), source => {
      let at = -1;
      while ((at = source.indexOf('<',at + 1)) >= 0) {
        if (escaped(source,at)) continue;
        const tag = tagAt(source,at); if (!tag) continue;
        const name = tag.name.toLowerCase();
        if (name === 'cite' || (tag.partial && ['cite','http','https','mailto'].some(value => value.startsWith(name)))) continue;
        if (blocked.test(name) && !tag.partial && !Object.keys(tag.attrs).length && !new RegExp('</' + name + '\\s*>','i').test(source.slice(tag.end))) continue;
        found = true; break;
      }
      return source;
    });
    return found;
  }
  function sanitizeHTML(html, inline = escape) {
    return String(html).split(/(<[^>]*>)/g).map(part => {
      if (!part.startsWith('<')) return inline(part);
      const allowed = /^<\/?([a-z]+)\s*>$/i.exec(part);
      return allowed && inert.has(allowed[1].toLowerCase()) ? part.toLowerCase() : escape(part);
    }).join('');
  }
  window.QResponseTags = { toMarkdown, hasLayout, stabilize: text => toMarkdown(text), protect, sanitizeHTML, safeURL };
})();
