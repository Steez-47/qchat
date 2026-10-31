// Synthetic DOM and bridge tests for src-tauri/bridge/gemini-bridge.js. No app, browser profile, credentials, or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/bridge/gemini-bridge.js', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

// Sanitized live reply fixture captured from gemini.google.com/app
const LIVE_SANITIZED_REPLY_HTML = `<model-response class="enable-lr26-response-chrome-updates ng-star-inserted"><div><response-container class="reduced-bottom-padding enable-lr26-response-chrome-updates enable-luminous-sources ng-star-inserted"><div class="response-container response-container-with-gpi no-background response-container-has-multiple-responses"><div class="presented-response-container"><div class="response-container-content"><div highlighttoaskhost="" class="response-content"><thinking-overlay class="enable-luminous-fast-follows ng-star-inserted"></thinking-overlay><div class="model-response-label-announcer" aria-busy="false" aria-live="polite"><h6 class="cdk-visually-hidden screen-reader-model-response-label ng-star-inserted"> Gemini said </h6></div><model-response-content><structured-content-container class="model-response-text processing-state-visible ng-star-inserted"><div class="container"><message-content id="message-content-id-r_e39960d21aa7fca0" class="ng-star-inserted"><div inline-copy-host="" class="markdown markdown-main-panel md-content enable-luminous-fast-follows enable-updated-hr-color stronger tutor-markdown-rendering" id="model-response-message-contentr_e39960d21aa7fca0" aria-busy="false" aria-live="polite" dir="ltr"><h2 data-path-to-node="0">Heading Two</h2><ul data-path-to-node="1"><li><p data-path-to-node="1,0,0"><span>First item</span></p></li><li><p data-path-to-node="1,1,0"><span>Second item</span></p></li></ul><p data-path-to-node="2"><b data-path-to-node="2" data-index-in-node="0">Important</b></p><p data-path-to-node="3"><response-element class="no-md"><link-block class="ng-star-inserted"><a target="_blank" rel="noopener" externallink="" href="https://example.com" class="ng-star-inserted">Example Link</a></link-block></response-element></p><div class="horizontal-scroll-wrapper md-has-block-component"><div class="table-block-component"><response-element class="no-md"><table-block class="enable-luminous-table-block enable-extended-and-xl-grid ng-star-inserted"><div class="table-block has-export-button new-table-style"><div not-end-of-paragraph="" class="table-content md-content"><table data-path-to-node="4"><thead><tr><th><span data-path-to-node="4,0,0,0">Col 1</span></th><th><span data-path-to-node="4,0,1,0">Col 2</span></th></tr></thead><tbody><tr><td><span data-path-to-node="4,1,0,0">A</span></td><td><span data-path-to-node="4,1,1,0">B</span></td></tr></tbody></table></div><div hide-from-message-actions="" class="table-footer hide-on-print hide-from-message-actions"><gem-icon-button arialabel="More options"><button aria-label="More options"><gem-icon><mat-icon role="img" aria-hidden="true">more_horiz</mat-icon></gem-icon></button></gem-icon-button></div></div></table-block></response-element></div></div><response-element class="no-md md-has-block-component"><code-block class="enable-luminous-code-block ng-star-inserted"><div class="code-block"><div class="formatted-code-block-internal-container"><div class="animated-opacity"><div class="code-block-decoration header-formatted gds-emphasized-body-m"><span>Python</span><div class="buttons"><gem-icon-button arialabel="Download code"><button aria-label="Download code"><gem-icon><mat-icon aria-hidden="true">arrow_circle_down</mat-icon></gem-icon></button></gem-icon-button><gem-icon-button arialabel="Copy code" data-test-id="gem-copy-button"><button aria-label="Copy code"><gem-icon><mat-icon aria-hidden="true">copy</mat-icon></gem-icon></button></gem-icon-button></div></div><pre><code role="text" data-test-id="code-content" class="code-container formatted">print(<span class="hljs-string">"Hello, world!"</span>)\n</code></pre></div></div></div></code-block></response-element><p data-path-to-node="6"><span class="math-inline" data-math="e=mc^2" data-index-in-node="0"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>e</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">e=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="katex-base">e=mc2</span></span></span></span></p><p data-path-to-node="7"><span>pineapple</span></p></div></message-content></div></structured-content-container></model-response-content><div class="response-footer gap complete"><sources-list class="sources-list ng-star-inserted"></sources-list><election-info-disclaimer class="ng-star-inserted" style="display: none;"></election-info-disclaimer><finance-info-disclaimer class="ng-star-inserted" style="display: none;"></finance-info-disclaimer></div></div></div></div><div class="response-container-footer"><message-actions footer="" class="hide-on-print"><div class="actions-container-v2"><div class="buttons-container-v2"><regenerate-button><gem-icon-button arialabel="Redo" data-test-id="regenerate-button"><button aria-label="Redo">Redo</button></gem-icon-button></regenerate-button><copy-button><gem-icon-button arialabel="Copy"><button aria-label="Copy">Copy</button></gem-icon-button></copy-button></div></div></message-actions></div></div></response-container><freemium-rag-disclaimer class="ng-star-inserted"></freemium-rag-disclaimer></div></model-response>`;

// Minimal DOM tree builder & CSS selector matcher for synthetic tests
function makeText(value) {
  return {
    nodeType: 3,
    nodeValue: String(value),
    textContent: String(value),
    innerText: String(value),
    parentElement: null,
    closest: () => null
  };
}

function makeEl(tag, attrs = {}, children = []) {
  const cleanAttrs = { ...attrs };
  const classes = new Set(String(cleanAttrs.class || cleanAttrs.className || '').split(/\s+/).filter(Boolean));
  delete cleanAttrs.className;
  if (classes.size) cleanAttrs.class = [...classes].join(' ');
  let hidden = 'hidden' in cleanAttrs && cleanAttrs.hidden !== false;
  let disabled = Boolean(cleanAttrs.disabled);

  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    childNodes: [],
    isConnected: true,
    order: 0,
    get className() { return [...classes].join(' '); },
    set className(val) {
      classes.clear();
      String(val || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
      cleanAttrs.class = [...classes].join(' ');
    },
    classList: {
      contains: c => classes.has(c),
      add: (...cs) => { cs.forEach(c => classes.add(c)); cleanAttrs.class = [...classes].join(' '); },
      remove: (...cs) => { cs.forEach(c => classes.delete(c)); cleanAttrs.class = [...classes].join(' '); }
    },
    get hidden() { return hidden; },
    set hidden(val) { hidden = Boolean(val); if (hidden) cleanAttrs.hidden = ''; else delete cleanAttrs.hidden; },
    get disabled() { return disabled; },
    set disabled(val) { disabled = Boolean(val); },
    get href() { return cleanAttrs.href || ''; },
    set href(val) { cleanAttrs.href = val; },
    get src() { return cleanAttrs.src || ''; },
    set src(val) { cleanAttrs.src = val; },
    get currentSrc() { return cleanAttrs.currentSrc || cleanAttrs.src || ''; },
    set currentSrc(val) { cleanAttrs.currentSrc = val; },
    get accept() { return cleanAttrs.accept || ''; },
    set accept(val) { cleanAttrs.accept = val; },
    get textContent() {
      return this.childNodes.map(c => c.textContent || '').join('');
    },
    set textContent(val) {
      this.childNodes = val ? [makeText(val)] : [];
      this.childNodes.forEach(c => { c.parentElement = this; });
    },
    get innerText() {
      if (this.hidden || cleanAttrs['aria-hidden'] === 'true') return '';
      return this.childNodes.map(c => c.innerText ?? c.textContent ?? '').join('');
    },
    set innerText(val) {
      this.textContent = val;
    },
    get children() {
      return this.childNodes.filter(c => c.nodeType === 1);
    },
    get rows() {
      if (this.tagName !== 'TABLE') return undefined;
      return this.querySelectorAll('tr');
    },
    get cells() {
      if (this.tagName !== 'TR') return undefined;
      return this.children.filter(c => c.tagName === 'TD' || c.tagName === 'TH');
    },
    getAttribute(k) { return k === 'class' ? this.className : (cleanAttrs[k] ?? null); },
    setAttribute(k, v) {
      if (k === 'class') this.className = v;
      else cleanAttrs[k] = String(v);
    },
    hasAttribute(k) { return k === 'class' ? classes.size > 0 : (k in cleanAttrs); },
    removeAttribute(k) { delete cleanAttrs[k]; },
    getClientRects() {
      if (this.hidden || cleanAttrs.style?.includes('display: none')) return [];
      return [{ width: 100, height: 24, left: 10, top: 10 }];
    },
    getBoundingClientRect() {
      const r = this.getClientRects()[0];
      return r || { width: 0, height: 0, left: 0, top: 0 };
    },
    focus() {},
    click() { this.onClick?.(); },
    dispatchEvent(e) { this.onEvent?.(e); if (e?.type === 'click') this.onClick?.(e); return true; },
    compareDocumentPosition(other) {
      return (this.order || 0) < (other.order || 0) ? 4 : 2;
    },
    append(...items) {
      for (const item of items) {
        const child = typeof item === 'string' ? makeText(item) : item;
        child.parentElement = this;
        this.childNodes.push(child);
      }
      return this;
    },
    remove() {
      if (!this.parentElement) return;
      const idx = this.parentElement.childNodes.indexOf(this);
      if (idx >= 0) this.parentElement.childNodes.splice(idx, 1);
      this.parentElement = null;
      this.isConnected = false;
    },
    cloneNode(deep = false) {
      const copy = makeEl(this.tagName.toLowerCase(), { ...cleanAttrs }, deep ? this.childNodes.map(c => c.nodeType === 3 ? makeText(c.nodeValue) : c.cloneNode(true)) : []);
      copy.hidden = this.hidden;
      copy.disabled = this.disabled;
      return copy;
    },
    matches(selectorGroup) {
      return matchSelectorGroup(this, selectorGroup);
    },
    closest(selectorGroup) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (matchSelectorGroup(cur, selectorGroup)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selectorGroup) {
      const results = [];
      const visit = el => {
        for (const child of el.children) {
          if (matchSelectorGroup(child, selectorGroup)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    },
    querySelector(selectorGroup) {
      return this.querySelectorAll(selectorGroup)[0] || null;
    }
  };

  node.append(...children);
  return node;
}

function splitSelectors(group) {
  const res = [];
  let cur = '', depth = 0, quote = '';
  for (let i = 0; i < group.length; i++) {
    const ch = group[i];
    if (quote) { if (ch === quote) quote = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) res.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) res.push(cur.trim());
  return res;
}

function splitDescendantParts(sel) {
  const parts = [];
  let cur = '', depth = 0, quote = '';
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) { if (ch === quote) quote = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function matchSimpleSelector(el, simple) {
  if (!el || el.nodeType !== 1) return false;
  if (simple === '*') return true;
  let rem = simple;
  const attrs = [];
  rem = rem.replace(/\[([^\]]+)\]/g, (_, content) => {
    attrs.push(content.trim());
    return '';
  });
  const classMatches = [...rem.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  rem = rem.replace(/\.[A-Za-z0-9_-]+/g, '');
  const idMatch = rem.match(/#([A-Za-z0-9_-]+)/)?.[1];
  rem = rem.replace(/#[A-Za-z0-9_-]+/g, '').trim();
  if (rem && el.tagName.toLowerCase() !== rem.toLowerCase()) return false;
  if (idMatch && el.getAttribute('id') !== idMatch) return false;
  for (const cls of classMatches) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const attr of attrs) {
    const m = attr.match(/^([A-Za-z0-9_:-]+)(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+([iI]))?)?$/);
    if (!m) return false;
    const [, name, op, v1, v2, v3, flag] = m;
    if (!op) {
      if (!el.hasAttribute(name)) return false;
      continue;
    }
    const rawVal = el.getAttribute(name);
    if (rawVal == null) return false;
    const target = v1 ?? v2 ?? v3 ?? '';
    const a = flag ? rawVal.toLowerCase() : rawVal;
    const b = flag ? target.toLowerCase() : target;
    if (op === '=' && a !== b) return false;
    if (op === '*=' && !a.includes(b)) return false;
    if (op === '^=' && !a.startsWith(b)) return false;
    if (op === '$=' && !a.endsWith(b)) return false;
  }
  return true;
}

function matchChain(el, parts, idx) {
  if (!matchSimpleSelector(el, parts[idx])) return false;
  if (idx === 0) return true;
  let parent = el.parentElement;
  while (parent) {
    if (matchChain(parent, parts, idx - 1)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function matchSelectorGroup(el, group) {
  for (const sel of splitSelectors(group)) {
    const parts = splitDescendantParts(sel);
    if (parts.length && matchChain(el, parts, parts.length - 1)) return true;
  }
  return false;
}

function parseHTML(html) {
  const root = makeEl('div');
  let stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/([A-Za-z0-9_-]+)\s*>|<([A-Za-z0-9_-]+)((?:\s+[A-Za-z0-9_:-]+(?:="[^"]*"|='[^']*'|[^\s>]*))*\s*)\/?>|([^<]+)/g;
  const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
  let m;
  while ((m = tokenRe.exec(html))) {
    const [full, closeTag, openTag, attrStr, text] = m;
    if (full.startsWith('<!--')) continue;
    if (closeTag) {
      const lower = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === lower) {
          stack.length = i;
          break;
        }
      }
    } else if (openTag) {
      const attrs = {};
      const attrRe = /([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let am;
      while ((am = attrRe.exec(attrStr || ''))) {
        attrs[am[1]] = am[2] ?? am[3] ?? am[4] ?? '';
      }
      const el = makeEl(openTag, attrs);
      stack[stack.length - 1].append(el);
      if (!full.endsWith('/>') && !voidTags.has(openTag.toLowerCase())) {
        stack.push(el);
      }
    } else if (text) {
      stack[stack.length - 1].append(makeText(text));
    }
  }
  return root.children.length === 1 ? root.children[0] : root;
}

function createBrowser({ hostname = 'gemini.google.com', pathname = '/app', ready = true, loggedIn = false, emitHook } = {}) {
  let now = 0, serial = 0, orderCounter = 1;
  const timers = new Map(), events = [], navigations = [];
  const body = makeEl('body');

  const location = {
    hostname,
    pathname,
    href: `https://${hostname}${pathname}`,
    origin: `https://${hostname}`,
    assign(url) {
      navigations.push(url);
      try {
        const u = new URL(url, this.href);
        this.hostname = u.hostname;
        this.pathname = u.pathname;
        this.href = u.href;
      } catch (_) {}
    }
  };

  let composerText = '';
  const richTextarea = makeEl('rich-textarea', { class: 'text-input-field_textarea' });
  const composer = makeEl('div', {
    class: 'ql-editor textarea new-input-ui',
    contenteditable: 'true',
    role: 'textbox',
    'aria-label': 'Enter a prompt for Gemini'
  });
  composer.hidden = !ready;
  richTextarea.append(composer);
  body.append(richTextarea);

  const sendButton = makeEl('button', { 'aria-label': 'Send message', 'aria-disabled': 'false' });
  body.append(sendButton);

  const signInBtn = makeEl('button', {}, [makeText('Sign in')]);
  const accountLink = makeEl('a', { 'aria-label': 'Google Account: User (user@example.com)', href: 'https://accounts.google.com/SignOutOptions' }, [makeText('Account')]);
  signInBtn.hidden = loggedIn;
  accountLink.hidden = !loggedIn;
  body.append(signInBtn, accountLink);

  let stopButton = null;
  let observerCallbacks = [];
  const notifyMutations = () => { observerCallbacks.forEach(cb => cb()); };

  const document = {
    title: 'Google Gemini',
    body,
    visibilityState: 'visible',
    hasFocus: () => true,
    activeElement: composer,
    execCommand(cmd, _, val) {
      if (cmd === 'selectAll') composerText = '';
      if (cmd === 'insertText') { composerText += val; composer.textContent = composerText; }
      return true;
    },
    querySelector(sel) { return body.querySelector(sel); },
    querySelectorAll(sel) { return body.querySelectorAll(sel); },
    getElementById(id) { return body.querySelector(`#${id}`); }
  };

  const schedule = (fn, delay = 0, interval = 0) => {
    const id = ++serial;
    timers.set(id, { fn, at: now + Math.max(0, Number(delay) || 0), interval });
    return id;
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 720,
    dispatchEvent() {},
    __QCHAT_EMIT__: event => { events.push(event); return emitHook?.(event); }
  };
  window.top = window;

  const context = vm.createContext({
    window,
    document,
    location,
    history: {
      pushState(_, __, path) {
        navigations.push(path);
        location.pathname = path;
        location.href = `https://${location.hostname}${path}`;
      }
    },
    PopStateEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    MouseEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    PointerEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    KeyboardEvent: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { observerCallbacks.push(this.cb); }
      disconnect() { observerCallbacks = observerCallbacks.filter(c => c !== this.cb); }
    },
    URL,
    console,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => timers.delete(id)
  });

  vm.runInContext(source, context);

  return {
    window,
    document,
    body,
    location,
    events,
    navigations,
    composer,
    sendButton,
    get api() { return window.__qchat; },
    get composerText() { return composerText; },
    setReady(val) { composer.hidden = !val; notifyMutations(); },
    setLoggedIn(val) {
      signInBtn.hidden = val;
      accountLink.hidden = !val;
      notifyMutations();
    },
    setStop(visible) {
      if (visible && !stopButton) {
        stopButton = makeEl('button', { 'aria-label': 'Stop response' });
        stopButton.onClick = () => this.setStop(false);
        body.append(stopButton);
      } else if (!visible && stopButton) {
        stopButton.remove();
        stopButton = null;
      }
      notifyMutations();
    },
    addTurn({ userText, replyHtml, streaming = false, convId }) {
      if (userText != null) {
        const uq = makeEl('user-query', {}, [
          makeEl('div', { class: 'query-text' }, [
            makeEl('h5', { class: 'cdk-visually-hidden screen-reader-user-query-label' }, [makeText(`You said ${userText}`)]),
            makeEl('p', { class: 'query-text-line' }, [makeText(userText)])
          ])
        ]);
        uq.order = ++orderCounter;
        body.append(uq);
      }
      let mr = null;
      if (replyHtml != null) {
        if (replyHtml.trim().startsWith('<model-response')) {
          mr = parseHTML(replyHtml);
        } else {
          const md = parseHTML(`<div class="markdown markdown-main-panel${streaming ? ' animate' : ''}">${replyHtml}</div>`);
          const mc = makeEl('message-content', {}, [md]);
          mr = makeEl('model-response', {}, [mc]);
        }
        mr.order = ++orderCounter;
        body.append(mr);
      }
      if (convId) {
        location.pathname = `/app/${convId}`;
        location.href = `https://${location.hostname}/app/${convId}`;
      }
      notifyMutations();
      return mr;
    },
    notifyMutations,
    async tick(ms) {
      await drain();
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn();
        await drain();
      }
      now = end;
      await drain();
    }
  };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('hostname guard only installs on gemini.google.com and is idempotent', async () => {
  const other = createBrowser({ hostname: 'chatgpt.com' });
  assert.equal(other.api, undefined);

  const gem = createBrowser({ hostname: 'gemini.google.com' });
  assert.ok(gem.api);
  const firstRef = gem.api;
  // Running again in same context does not overwrite
  assert.equal(gem.api, firstRef);
});

test('status emits on load, route change, and requires positive signed-in signal', async () => {
  const b = createBrowser({ ready: true, loggedIn: false });
  await b.tick(200);
  const first = b.events.filter(e => e.type === 'status').at(-1);
  assert.equal(first.ready, true);
  assert.equal(first.loggedIn, false);
  assert.equal(first.url, 'https://gemini.google.com/app');

  // Ambiguous state: neither Sign in nor Google Account link -> loggedIn must be false
  b.body.querySelectorAll('button, a').forEach(n => { if (/sign in|google account/i.test((n.innerText || '') + (n.getAttribute('aria-label') || ''))) n.hidden = true; });
  await b.api.status();
  await b.tick(200);
  assert.equal(b.events.filter(e => e.type === 'status').at(-1).loggedIn, false);

  // Positive signal: Google Account link visible and no Sign in control
  b.setLoggedIn(true);
  await b.api.status();
  await b.tick(200);
  assert.equal(b.events.filter(e => e.type === 'status').at(-1).loggedIn, true);

  // Route change triggers status emission
  const countBefore = b.events.filter(e => e.type === 'status').length;
  b.location.pathname = '/app/6c98fba71ccb5d25';
  b.location.href = 'https://gemini.google.com/app/6c98fba71ccb5d25';
  await b.tick(600);
  const latest = b.events.filter(e => e.type === 'status').at(-1);
  assert.ok(b.events.filter(e => e.type === 'status').length > countBefore);
  assert.equal(latest.url, 'https://gemini.google.com/app/6c98fba71ccb5d25');
});

test('HTML to Markdown converter round-trips live sanitized Gemini fixture accurately', async () => {
  const b = createBrowser();
  const dom = parseHTML(LIVE_SANITIZED_REPLY_HTML);
  const mdRoot = dom.querySelector('message-content .markdown');
  const md = b.api._htmlToMarkdown(mdRoot);

  assert.match(md, /^## Heading Two/m);
  assert.match(md, /- First item\n- Second item/);
  assert.match(md, /\*\*Important\*\*/);
  assert.match(md, /\[Example Link\]\(https:\/\/example\.com\/?\)/);
  assert.match(md, /\| Col 1 \| Col 2 \|\n\| --- \| --- \|\n\| A \| B \|/);
  assert.match(md, /```python\nprint\("Hello, world!"\)\n```/);
  assert.match(md, /\$e=mc\^2\$/);
  assert.match(md, /pineapple$/);
  // Ensure stripped chrome is absent
  assert.doesNotMatch(md, /Gemini said|Copy code|Download code|More options|Redo|e=mc2/);
});

test('HTML to Markdown converter handles nested lists, blockquotes, hr, inline code, and display math', async () => {
  const b = createBrowser();
  const sample = parseHTML(`
    <div class="markdown">
      <h3>Section</h3>
      <p>Use <code>const x = 1</code> and <em>italics</em>.</p>
      <blockquote><p>Quoted line</p></blockquote>
      <hr>
      <ol start="2">
        <li>Second<ul><li>Sub A</li><li>Sub B</li></ul></li>
        <li>Third</li>
      </ol>
      <div class="math-block" data-math="\\int_0^1 x^2 dx = \\frac{1}{3}">
        <span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true">glyphs</span></span></span>
      </div>
    </div>
  `);
  const md = b.api._htmlToMarkdown(sample);
  assert.match(md, /### Section/);
  assert.match(md, /Use `const x = 1` and \*italics\*\./);
  assert.match(md, /> Quoted line/);
  assert.match(md, /---/);
  assert.match(md, /2\. Second\n  - Sub A\n  - Sub B\n3\. Third/);
  assert.match(md, /\$\$\n\\int_0\^1 x\^2 dx = \\frac\{1\}\{3\}\n\$\$/);
  assert.doesNotMatch(md, /glyphs/);
});

test('send scopes to new model-response turn, streams throttled deltas, emits activity, and finishes when settled', async () => {
  const b = createBrowser({ ready: true });
  // Pre-existing turn that must be ignored
  b.addTurn({ userText: 'old question', replyHtml: '<p>Old answer that must not restream</p>', convId: '1111222233334444' });
  await b.tick(200);

  let mr = null;
  b.sendButton.onClick = () => {
    b.setStop(true);
    mr = b.addTurn({
      userText: 'new prompt',
      replyHtml: '<p>Streaming chunk 1</p>',
      streaming: true,
      convId: '6c98fba71ccb5d25'
    });
    const overlay = makeEl('thinking-overlay', {}, [makeText('Searching Google...')]);
    mr.append(overlay);
  };

  await b.api.send({ id: 'turn-1', prompt: 'new prompt', reasoningEffort: 'high' });
  await b.tick(200);

  assert.ok(b.events.some(e => e.type === 'start' && e.id === 'turn-1'));
  const deltas1 = b.events.filter(e => e.type === 'delta' && e.id === 'turn-1');
  assert.ok(deltas1.length >= 1);
  assert.equal(deltas1.at(-1).text, 'Streaming chunk 1');
  assert.ok(!deltas1.some(d => d.text.includes('Old answer')));

  // Update chunk while still streaming
  const mdNode = mr.querySelector('.markdown');
  mdNode.append(makeEl('p', {}, [makeText('Final paragraph')]));
  b.notifyMutations();
  await b.tick(200);
  assert.equal(b.events.filter(e => e.type === 'delta').at(-1).text, 'Streaming chunk 1\n\nFinal paragraph');
  assert.equal(b.events.filter(e => e.type === 'done').length, 0, 'Must not finish while stop and .animate are active');

  // Remove stop and .animate, wait >=600ms settle window
  b.setStop(false);
  mdNode.classList.remove('animate');
  b.notifyMutations();
  await b.tick(400);
  assert.equal(b.events.filter(e => e.type === 'done').length, 0, 'Must wait 600ms after stop and animate clear');
  await b.tick(400);

  const doneEvt = b.events.find(e => e.type === 'done' && e.id === 'turn-1');
  assert.ok(doneEvt);
  assert.equal(doneEvt.text, 'Streaming chunk 1\n\nFinal paragraph');
  assert.equal(doneEvt.conversationId, '6c98fba71ccb5d25');
});

test('send rejects concurrent request with busy and reports stream_failed on empty settled response', async () => {
  const b = createBrowser({ ready: true });
  let mr = null;
  b.sendButton.onClick = () => {
    b.setStop(true);
    mr = b.addTurn({ userText: 'hello', replyHtml: '', streaming: true });
  };

  await b.api.send({ id: 'job-1', prompt: 'hello' });
  await b.api.send({ id: 'job-2', prompt: 'second' });
  await b.tick(200);

  const busyErr = b.events.find(e => e.type === 'error' && e.id === 'job-2');
  assert.equal(busyErr?.code, 'busy');

  // Settle job-1 with empty markdown
  b.setStop(false);
  mr.querySelector('.markdown').classList.remove('animate');
  await b.tick(800);

  const emptyErr = b.events.find(e => e.type === 'error' && e.id === 'job-1');
  assert.equal(emptyErr?.code, 'stream_failed');
});

test('quota banner triggers rate_limited error', async () => {
  const b = createBrowser({ ready: true });
  b.sendButton.onClick = () => {
    b.setStop(true);
    b.body.append(makeEl('div', { role: 'alert' }, [makeText('You have reached your usage limit for today.')]));
  };
  await b.api.send({ id: 'quota-job', prompt: 'test' });
  await b.tick(300);
  const err = b.events.find(e => e.type === 'error' && e.id === 'quota-job');
  assert.equal(err?.code, 'rate_limited');
});

test('guest attachmentInput and temporary newChat emit specified error codes', async () => {
  const b = createBrowser({ ready: true, loggedIn: false });
  await assert.rejects(b.api.attachmentInput(), /attachment_unavailable/);
  await b.tick(200);
  assert.ok(b.events.some(e => e.type === 'error' && e.code === 'attachment_unavailable' && e.message === 'Sign in to Gemini to attach files.'));

  await b.api.newChat({ temporary: true });
  await b.tick(200);
  assert.ok(b.events.some(e => e.type === 'error' && e.code === 'temporary_unavailable'));
});

test('listModels and chooseModel read mode picker and verify selection', async () => {
  const b = createBrowser({ ready: true, loggedIn: false });
  let menuOpen = false;
  let currentMode = 'Flash-Lite';

  const switcherBtn = makeEl('button', {
    'data-test-id': 'bard-mode-menu-button',
    'aria-label': `Open mode picker, currently ${currentMode}`,
    'aria-expanded': 'false',
    'aria-controls': 'mode-menu-1'
  }, [makeText(currentMode)]);

  const item1 = makeEl('gem-menu-item', { role: 'menuitem', class: 'selected' }, [
    makeEl('gem-menu-item-content', { class: 'selected' }, [
      makeEl('span', { class: 'label' }, [makeText('3.5 Flash-Lite')]),
      makeEl('div', { class: 'sublabel' }, [makeText('Fastest answers')])
    ])
  ]);
  const item2 = makeEl('gem-menu-item', { role: 'menuitem' }, [
    makeEl('gem-menu-item-content', {}, [
      makeEl('span', { class: 'label' }, [makeText('3.6 Flash')]),
      makeEl('div', { class: 'sublabel' }, [makeText('All-around help')])
    ])
  ]);
  item2.onClick = () => {
    item1.classList.remove('selected');
    item2.classList.add('selected');
    currentMode = '3.6 Flash';
    switcherBtn.setAttribute('aria-label', `Open mode picker, currently ${currentMode}`);
    switcherBtn.textContent = currentMode;
  };

  const menu = makeEl('gem-menu', { id: 'mode-menu-1', role: 'menu' }, [item1, item2]);
  menu.hidden = true;
  switcherBtn.onClick = () => {
    menuOpen = true;
    menu.hidden = false;
    switcherBtn.setAttribute('aria-expanded', 'true');
  };
  switcherBtn.onEvent = e => {
    if (e?.key === 'Escape') {
      menuOpen = false;
      menu.hidden = true;
      switcherBtn.setAttribute('aria-expanded', 'false');
    }
  };
  const switcher = makeEl('bard-mode-switcher', {}, [switcherBtn]);
  b.body.append(switcher, menu);

  const p1 = b.api.listModels();
  await b.tick(2000);
  await p1;

  const modelsEvt = b.events.find(e => e.type === 'models');
  assert.ok(modelsEvt);
  assert.deepEqual(Array.from(modelsEvt.models, m => ({ ...m })), [
    { id: '3.5 Flash-Lite', label: '3.5 Flash-Lite', selected: true },
    { id: '3.6 Flash', label: '3.6 Flash', selected: false }
  ]);

  const p2 = b.api.chooseModel('3.6 Flash');
  await b.tick(2000);
  await p2;

  const chosenEvt = b.events.find(e => e.type === 'model-chosen');
  assert.ok(chosenEvt);
  assert.equal(chosenEvt.model.label, '3.6 Flash');
});

test('listConversations returns empty list without error for guests and reads side nav links when signed in', async () => {
  const b = createBrowser({ ready: true, loggedIn: false });
  await b.api.listConversations(0);
  await b.tick(200);
  const guestConvs = b.events.filter(e => e.type === 'conversations').at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(guestConvs)), { type: 'conversations', items: [], offset: 0, total: 0 });

  b.setLoggedIn(true);
  b.body.append(
    makeEl('a', { class: 'conversation', href: '/app/abcdef1234567890' }, [
      makeEl('div', { class: 'conversation-title' }, [makeText('First Gemini Chat')])
    ]),
    makeEl('a', { class: 'conversation', href: '/app/9876543210fedcba' }, [
      makeEl('div', { class: 'conversation-title' }, [makeText('Second Gemini Chat')])
    ])
  );
  await b.api.listConversations(0);
  await b.tick(200);
  const signedInConvs = b.events.filter(e => e.type === 'conversations').at(-1);
  assert.equal(signedInConvs.items.length, 2);
  assert.equal(signedInConvs.items[0].id, 'abcdef1234567890');
  assert.equal(signedInConvs.items[0].title, 'First Gemini Chat');
});

test('readConversation emits transcript from page turns and openConversation validates id', async () => {
  const b = createBrowser({ ready: true, loggedIn: true, pathname: '/app/abcdef1234567890' });
  b.addTurn({ userText: 'What is 2+2?', replyHtml: '<p>It is <strong>4</strong>.</p>', convId: 'abcdef1234567890' });

  const reading = b.api.readConversation('abcdef1234567890');
  await b.tick(1000);
  await reading;

  const transcript = b.events.find(e => e.type === 'transcript');
  assert.ok(transcript);
  assert.equal(transcript.conversationId, 'abcdef1234567890');
  assert.deepEqual(Array.from(transcript.messages, m => ({ ...m })), [
    { role: 'user', text: 'What is 2+2?', hasMedia: false },
    { role: 'assistant', text: 'It is **4**.', hasMedia: false }
  ]);

  for (const invalid of ['short', '../bad/id', 'bad?query=1']) {
    await assert.rejects(b.api.openConversation(invalid), /invalid_id/);
    await assert.rejects(b.api.readConversation(invalid), /invalid_id/);
  }
});

test('reply images register media items and resolveMedia returns safe url, kind, and name', async () => {
  const b = createBrowser({ ready: true });
  b.sendButton.onClick = () => {
    b.setStop(true);
    b.addTurn({
      userText: 'show image',
      replyHtml: '<p>Here is the image:</p><img src="https://lh3.googleusercontent.com/a/generated-image-123" alt="Generated Sunset">',
      streaming: false,
      convId: 'abcdef1234567890'
    });
  };
  await b.api.send({ id: 'img-job', prompt: 'show image' });
  await b.tick(200);
  b.setStop(false);
  await b.tick(800);

  const mediaEvt = b.events.filter(e => e.type === 'media' && e.id === 'img-job').at(-1);
  assert.ok(mediaEvt);
  assert.equal(mediaEvt.items.length, 1);
  assert.equal(mediaEvt.items[0].kind, 'image');
  assert.equal(mediaEvt.items[0].name, 'Generated Sunset');

  const resolved = await b.api.resolveMedia(mediaEvt.items[0].id);
  assert.equal(resolved.url, 'https://lh3.googleusercontent.com/a/generated-image-123');
  assert.equal(resolved.kind, 'image');
  assert.equal(resolved.name, 'Generated Sunset');
});

test('stop cancels active stream, clicks stop button, and emits done once', async () => {
  const b = createBrowser({ ready: true });
  b.sendButton.onClick = () => {
    b.setStop(true);
    b.addTurn({ userText: 'write essay', replyHtml: '<p>Partial reply</p>', streaming: true, convId: 'abcdef1234567890' });
  };
  await b.api.send({ id: 'stop-job', prompt: 'write essay' });
  await b.tick(200);
  await b.api.stop();
  await b.tick(200);

  const doneEvents = b.events.filter(e => e.type === 'done' && e.id === 'stop-job');
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].text, 'Partial reply');
});

test('newChat falls back to location.assign when side nav click leaves turns on page', async () => {
  const b = createBrowser({ ready: true, pathname: '/app/abcdef1234567890' });
  b.addTurn({ userText: 'hi', replyHtml: '<p>hello</p>', convId: 'abcdef1234567890' });
  // Add a non-working New chat button that does not clear turns
  const newBtn = makeEl('a', { 'aria-label': 'New chat', href: '/app' }, [makeText('New chat')]);
  b.body.append(newBtn);

  const p = b.api.newChat();
  await b.tick(1500);
  await p;
  assert.ok(b.navigations.includes('https://gemini.google.com/app'));
});

test('rendered sources-list links emit sources event and watchdog times out stalled stream', async () => {
  const b = createBrowser({ ready: true });
  b.sendButton.onClick = () => {
    b.setStop(true);
    const mr = b.addTurn({ userText: 'cite', replyHtml: '<p>Fact</p>', streaming: true });
    const sourcesList = makeEl('sources-list', {}, [
      makeEl('a', { href: 'https://example.org/fact' }, [makeText('Example Fact Source')])
    ]);
    mr.append(sourcesList);
  };
  await b.api.send({ id: 'src-job', prompt: 'cite' });
  await b.tick(200);

  const srcEvt = b.events.find(e => e.type === 'sources' && e.id === 'src-job');
  assert.ok(srcEvt);
  assert.equal(srcEvt.items.length, 1);
  assert.equal(srcEvt.items[0].url, 'https://example.org/fact');
  assert.equal(srcEvt.items[0].title, 'Example Fact Source');

  // Advance 5 minutes with stop still active -> watchdog timeout
  await b.tick(301000);
  const errEvt = b.events.find(e => e.type === 'error' && e.id === 'src-job');
  assert.equal(errEvt?.code, 'timeout');
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(failed ? `${failed} FAILED` : `ALL PASS (${tests.length})`);
process.exitCode = failed ? 1 : 0;
