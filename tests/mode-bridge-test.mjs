// Synthetic DOM tests for the Chat/Work and Chat/Task mode contract in both
// provider bridges. No app, browser profile, credentials, network or real DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const chatgptSource = readFileSync(new URL('../src-tauri/bridge/chatgpt-bridge.js', import.meta.url), 'utf8');
const geminiSource = readFileSync(new URL('../src-tauri/bridge/gemini-bridge.js', import.meta.url), 'utf8');
const responseTags = readFileSync(new URL('../ui/response-tags.js', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

// ---- Minimal DOM tree builder & CSS selector matcher (same style as gemini-bridge-test) ----
function makeText(value) {
  return { nodeType: 3, nodeValue: String(value), textContent: String(value), innerText: String(value), parentElement: null, closest: () => null };
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
    get textContent() { return this.childNodes.map(c => c.textContent || '').join(''); },
    set textContent(val) { this.childNodes = val ? [makeText(val)] : []; this.childNodes.forEach(c => { c.parentElement = this; }); },
    get innerText() {
      if (this.hidden || cleanAttrs['aria-hidden'] === 'true') return '';
      return this.childNodes.map(c => c.innerText ?? c.textContent ?? '').join('');
    },
    set innerText(val) { this.textContent = val; },
    get children() { return this.childNodes.filter(c => c.nodeType === 1); },
    getAttribute(k) { return k === 'class' ? this.className : (cleanAttrs[k] ?? null); },
    setAttribute(k, v) { if (k === 'class') this.className = v; else cleanAttrs[k] = String(v); },
    hasAttribute(k) { return k === 'class' ? classes.size > 0 : (k in cleanAttrs); },
    removeAttribute(k) { delete cleanAttrs[k]; },
    getClientRects() {
      if (this.hidden || cleanAttrs.style?.includes('display: none')) return [];
      return [{ width: 100, height: 24, left: 10, top: 10 }];
    },
    getBoundingClientRect() { return this.getClientRects()[0] || { width: 0, height: 0, left: 0, top: 0 }; },
    focus() {},
    click() { this.onClick?.(); },
    dispatchEvent(e) { this.onEvent?.(e); if (e?.type === 'click') this.onClick?.(e); return true; },
    compareDocumentPosition(other) { return (this.order || 0) < (other.order || 0) ? 4 : 2; },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === this) return true; return false; },
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
    matches(selectorGroup) { return matchSelectorGroup(this, selectorGroup); },
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
    querySelector(selectorGroup) { return this.querySelectorAll(selectorGroup)[0] || null; }
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
  rem = rem.replace(/\[([^\]]+)\]/g, (_, content) => { attrs.push(content.trim()); return ''; });
  const classMatches = [...rem.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(m => m[1]);
  rem = rem.replace(/\.[A-Za-z0-9_-]+/g, '');
  const idMatch = rem.match(/#([A-Za-z0-9_-]+)/)?.[1];
  rem = rem.replace(/#[A-Za-z0-9_-]+/g, '').trim();
  if (rem && el.tagName.toLowerCase() !== rem.toLowerCase()) return false;
  if (idMatch && el.getAttribute('id') !== idMatch) return false;
  for (const cls of classMatches) if (!el.classList.contains(cls)) return false;
  for (const attr of attrs) {
    const m = attr.match(/^([A-Za-z0-9_:-]+)(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+([iI]))?)?$/);
    if (!m) return false;
    const [, name, op, v1, v2, v3, flag] = m;
    if (!op) { if (!el.hasAttribute(name)) return false; continue; }
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
        if (stack[i].tagName.toLowerCase() === lower) { stack.length = i; break; }
      }
    } else if (openTag) {
      const attrs = {};
      const attrRe = /([A-Za-z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let am;
      while ((am = attrRe.exec(attrStr || ''))) attrs[am[1]] = am[2] ?? am[3] ?? am[4] ?? '';
      const el = makeEl(openTag, attrs);
      stack[stack.length - 1].append(el);
      if (!full.endsWith('/>') && !voidTags.has(openTag.toLowerCase())) stack.push(el);
    } else if (text) {
      stack[stack.length - 1].append(makeText(text));
    }
  }
  return root.children.length === 1 ? root.children[0] : root;
}

// ---- Shared fake clock / window / document ----
function harness({ hostname, pathname, ready, script, extraGlobals = {} }) {
  let now = 0, serial = 0;
  const timers = new Map(), events = [], navigations = [];
  const body = makeEl('body');
  const location = {
    hostname, pathname, href: `https://${hostname}${pathname}`, origin: `https://${hostname}`,
    assign(url) {
      navigations.push(url);
      try {
        const u = new URL(url, this.href);
        this.hostname = u.hostname; this.pathname = u.pathname; this.href = u.href;
      } catch (_) {}
    }
  };
  const document = {
    title: 'Provider', body, visibilityState: 'visible', hasFocus: () => true, activeElement: null,
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
    innerWidth: 1280, innerHeight: 720, dispatchEvent() {},
    __QCHAT_EMIT__: event => { events.push(event); },
    fetch: async () => ({ ok: false, json: async () => ({}) })
  };
  window.top = window;
  let observerCallbacks = [];
  const context = vm.createContext({
    window, document, location,
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
    URL, AbortController, btoa, atob, console,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => schedule(fn, ms, 0),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms),
    clearInterval: id => timers.delete(id),
    HTMLTextAreaElement: class {},
    ...extraGlobals
  });
  if (hostname === 'chatgpt.com') vm.runInContext(responseTags, context);
  vm.runInContext(script, context);
  const notifyMutations = () => observerCallbacks.forEach(cb => cb());
  return {
    window, document, body, location, events, navigations, notifyMutations, composer: null,
    get api() { return window.__qchat; },
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

// ---- Mode switch fixture: two exact controls, like a Chat/Work or Chat/Task switch ----
function addModeSwitch(b, { workLabel = 'Work', chatLabel = 'Chat', selected = 'chat', state = true } = {}) {
  const box = makeEl('div', { class: 'mode-switch' });
  const attrs = role => state ? { role, 'aria-selected': String(selected === 'chat') } : { role };
  const chat = makeEl('button', attrs('tab'), [makeText(chatLabel)]);
  const work = makeEl('button', attrs('tab'), [makeText(workLabel)]);
  const status = { mode: selected, clicks: [] };
  const apply = () => {
    if (!state) return;
    chat.setAttribute('aria-selected', String(status.mode === 'chat'));
    work.setAttribute('aria-selected', String(status.mode === 'work'));
  };
  for (const [node, mode] of [[chat, 'chat'], [work, 'work']]) {
    node.onClick = () => {
      status.clicks.push(mode);
      status.mode = mode;
      apply();
      b.notifyMutations();
    };
  }
  apply();
  box.append(chat, work);
  b.body.append(box);
  return { box, chat, work, status };
}

function addIgnoredChatTitles(b, provider, title) {
  if (provider === 'chatgpt') {
    const nav = makeEl('nav');
    nav.append(makeEl('a', { role: 'link', href: '/c/abcdefgh1234' }, [makeText(title)]));
    b.body.append(nav, makeEl('div', { 'data-testid': 'history-item-7' }, [makeEl('button', {}, [makeText(title)])]));
  } else {
    b.body.append(makeEl('conversations-list', {}, [
      makeEl('a', { class: 'conversation', href: '/app/abcdefgh1234' }, [
        makeEl('div', { class: 'conversation-title' }, [makeText(title)]),
        makeEl('button', {}, [makeText(title)])
      ])
    ]));
  }
  const message = provider === 'chatgpt'
    ? makeEl('div', { 'data-message-author-role': 'assistant' }, [makeEl('button', {}, [makeText(title)])])
    : makeEl('model-response', {}, [makeEl('button', {}, [makeText(title)])]);
  b.body.append(message);
}

// ---- ChatGPT fixture ----
function createChatgpt({ pathname = '/', ready = true } = {}) {
  const b = harness({ hostname: 'chatgpt.com', pathname, ready, script: chatgptSource });
  let composerText = '';
  const composer = makeEl('div', { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox', 'aria-label': 'Chat with ChatGPT' });
  composer.hidden = !ready;
  b.body.append(makeEl('form', {}, [composer]));
  const sendButton = makeEl('button', { 'data-testid': 'send-button', 'aria-label': 'Send prompt' }, [makeText('Send')]);
  b.body.append(sendButton);
  let stopButton = null;
  let order = 0;
  b.document.activeElement = composer;
  b.document.execCommand = (cmd, _, val) => {
    if (cmd === 'selectAll') composerText = '';
    if (cmd === 'insertText') { composerText += val; composer.textContent = composerText; }
    return true;
  };
  b.composer = composer;
  b.sendButton = sendButton;
  Object.defineProperty(b, 'composerText', { get: () => composerText });
  b.setStop = visible => {
    if (visible && !stopButton) {
      stopButton = makeEl('button', { 'data-testid': 'stop-button', 'aria-label': 'Stop streaming' });
      stopButton.onClick = () => b.setStop(false);
      b.body.append(stopButton);
    } else if (!visible && stopButton) {
      stopButton.remove();
      stopButton = null;
    }
    b.notifyMutations();
  };
  b.addTurn = ({ userText, replyText, attention, convId } = {}) => {
    if (userText != null) {
      const user = makeEl('div', { 'data-message-author-role': 'user' }, [makeEl('div', {}, [makeText(userText)])]);
      user.order = ++order;
      b.body.append(user);
    }
    let node = null;
    if (replyText != null || attention) {
      node = makeEl('div', { 'data-message-author-role': 'assistant' });
      if (replyText != null) node.append(parseHTML(`<div class="markdown">${replyText}</div>`));
      if (attention) node.append(makeEl('button', {}, [makeText(attention)]));
      node.order = ++order;
      b.body.append(node);
    }
    if (convId) { b.location.pathname = `/c/${convId}`; b.location.href = `https://chatgpt.com/c/${convId}`; }
    b.notifyMutations();
    return node;
  };
  return b;
}

// ---- Gemini fixture ----
function createGemini({ pathname = '/app', ready = true } = {}) {
  const b = harness({ hostname: 'gemini.google.com', pathname, ready, script: geminiSource });
  let composerText = '';
  const composer = makeEl('div', { class: 'ql-editor', contenteditable: 'true', role: 'textbox', 'aria-label': 'Enter a prompt for Gemini' });
  composer.hidden = !ready;
  b.body.append(makeEl('rich-textarea', {}, [composer]));
  const sendButton = makeEl('button', { 'aria-label': 'Send message', 'aria-disabled': 'false' }, [makeText('Send')]);
  b.body.append(sendButton);
  let stopButton = null;
  let order = 0;
  b.document.activeElement = composer;
  b.document.execCommand = (cmd, _, val) => {
    if (cmd === 'selectAll') composerText = '';
    if (cmd === 'insertText') { composerText += val; (b.document.activeElement || composer).textContent = composerText; }
    return true;
  };
  b.composer = composer;
  b.sendButton = sendButton;
  Object.defineProperty(b, 'composerText', { get: () => composerText });
  b.setStop = visible => {
    if (visible && !stopButton) {
      stopButton = makeEl('button', { 'aria-label': 'Stop response' });
      stopButton.onClick = () => b.setStop(false);
      b.body.append(stopButton);
    } else if (!visible && stopButton) {
      stopButton.remove();
      stopButton = null;
    }
    b.notifyMutations();
  };
  b.addTurn = ({ userText, replyText, attention, convId } = {}) => {
    if (userText != null) {
      const user = makeEl('user-query', {}, [
        makeEl('div', { class: 'query-text' }, [makeEl('p', {}, [makeText(userText)])])
      ]);
      user.order = ++order;
      b.body.append(user);
    }
    let node = null;
    if (replyText != null || attention) {
      node = makeEl('model-response');
      const md = makeEl('div', { class: 'markdown markdown-main-panel' });
      if (replyText != null) md.append(makeEl('p', {}, [makeText(replyText)]));
      node.append(makeEl('message-content', {}, [md]));
      if (attention) node.append(makeEl('button', {}, [makeText(attention)]));
      node.order = ++order;
      b.body.append(node);
    }
    if (convId) { b.location.pathname = `/app/${convId}`; b.location.href = `https://gemini.google.com/app/${convId}`; }
    b.notifyMutations();
    return node;
  };
  return b;
}

const PROVIDERS = [
  {
    id: 'chatgpt', work: 'Work', fallback: 'Work',
    message: "ChatGPT Work isn't available on this account right now.",
    attention: 'ChatGPT Work is waiting for your approval. Open the chat in ChatGPT to continue.',
    create: createChatgpt, source: chatgptSource
  },
  {
    id: 'gemini', work: 'Task', fallback: 'Task',
    message: "Gemini Task isn't available on this account right now.",
    attention: 'Gemini Task is waiting for your approval. Open the chat in Gemini to continue.',
    create: createGemini, source: geminiSource
  }
];

const tests = [];
const test = (name, run) => tests.push({ name, run });
const eventsOf = (b, type, id) => b.events.filter(e => e.type === type && (id === undefined || e.id === id));
const lastOf = (b, type) => b.events.filter(e => e.type === type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));

// Real Gemini switch: state belongs to wrappers, never the action buttons.
function segmentedSwitch(b, selected = 'chat') {
  const box = makeEl('div');
  const status = { mode: selected, clicks: [] };
  const wrappers = {};
  for (const [mode, label] of [['chat', 'Chat'], ['work', 'Task']]) {
    const button = makeEl('button', { class: 'gem-segmented-button-action' }, [label]);
    const wrapper = makeEl('div', { class: 'gem-segmented-button' }, [button]);
    wrappers[mode] = wrapper;
    button.onClick = () => { status.clicks.push(mode); status.mode = mode; apply(); };
    box.append(wrapper);
  }
  function apply() {
    for (const mode of ['chat', 'work']) wrappers[mode].className = 'gem-segmented-button' + (status.mode === mode ? ' gem-segmented-button-selected' : '');
    b.composer.setAttribute('data-placeholder', status.mode === 'work' ? 'Describe a task' : 'Ask Gemini');
  }
  apply(); b.body.append(box);
  return { status };
}

function modelMenu(b, provider, mode) {
  const menu = makeEl('div', { role: 'menu', id: 'models' });
  const switcher = makeEl('button', { 'aria-label': provider === 'chatgpt' ? 'Select ChatGPT model' : 'Open mode picker', 'aria-controls': 'models', 'aria-expanded': 'false' });
  const labels = () => provider === 'gemini' ? (mode.status.mode === 'work' ? ['3.8 Flash', '4 Argon'] : ['Flash', 'Pro', 'Thinking']) : (mode.status.mode === 'work' ? ['Default', 'GPT-6.1 Sol', 'GPT-6.1 Terra', 'GPT-6 Astra', 'Auto', 'Fast', 'Deep', 'Pro', 'Max'] : ['GPT-6', 'GPT-5.6 Sol']);
  const keys = []; let index = 1;
  const readout = makeEl('div', { id: 'idA' }, ['Light, 2 of 5.']);
  const help = makeEl('div', { id: 'idB' }, ['Use arrow keys']);
  const slider = makeEl('div', { role: 'menuitem', 'aria-label': 'Power', 'data-reasoning-slider': 'true', 'aria-describedby': 'idA idB' });
  slider.focus = () => { b.document.activeElement = slider; };
  slider.onEvent = e => {
    if (e.type === 'keydown' && ['ArrowRight', 'ArrowLeft'].includes(e.key)) {
      keys.push(e.key); index += e.key === 'ArrowRight' ? 1 : -1;
      readout.textContent = `${['Minimal', 'Light', 'Medium', 'High', 'Extra High'][index]}, ${index + 1} of 5.`;
    }
    if (e.key === 'Escape') switcher.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.childNodes = [];
    for (const label of labels()) {
      const row = makeEl('div', { role: 'menuitemradio', 'aria-checked': 'false' }, [label]);
      row.onClick = () => switcher.setAttribute('aria-expanded', 'false');
      menu.append(row);
    }
    if (provider === 'chatgpt' && slider.isConnected) menu.append(slider);
    switcher.setAttribute('aria-expanded', 'true');
  };
  switcher.onClick = open;
  switcher.onEvent = e => { if (e.key === 'ArrowDown') open(); if (e.key === 'Escape') switcher.setAttribute('aria-expanded', 'false'); };
  switcher.focus = () => { b.document.activeElement = switcher; };
  b.composer.onEvent = e => { if (e.key === 'Escape') switcher.setAttribute('aria-expanded', 'false'); };
  b.body.append(switcher, menu, readout, help);
  return { switcher, slider, readout, keys, labels };
}

for (const selected of ['chat', 'work']) test(`Gemini segmented parent state ${selected}`, async () => {
  const b = createGemini(); const mode = segmentedSwitch(b, selected);
  b.api.listModes();
  assert.equal(lastOf(b, 'modes').modes.find(m => m.selected).id, selected);
  const pending = b.api.setMode('work'); await b.tick(4000); await pending;
  assert.equal(lastOf(b, 'modes').modes.find(m => m.selected).id, 'work');
  assert.deepEqual(mode.status.clicks, selected === 'chat' ? ['work'] : []);
});

for (const p of PROVIDERS) {
  test(`${p.id} model reads match requested mode before opening menu`, async () => {
    const b = p.create(); const mode = p.id === 'gemini' ? segmentedSwitch(b) : addModeSwitch(b);
    const menu = modelMenu(b, p.id, mode);
    for (const requested of [undefined, null, 'chat', 'work', 'work', 'chat']) {
      const before = mode.status.clicks.length, previous = mode.status.mode;
      const pending = b.api.listModels(undefined, requested); await b.tick(5000); await pending;
      assert.equal(mode.status.clicks.length - before, requested && requested !== previous ? 1 : 0, `${p.id} requested=${requested} previous=${previous}`);
      assert.deepEqual(Array.from(lastOf(b, 'models').models, m => m.label), menu.labels());
      if (p.id === 'gemini' && requested === 'work') assert.deepEqual(plain(lastOf(b, 'models').levels), []);
    }
    const pending = b.api.send({ id: 'busy-models', prompt: 'hold' }); await b.tick(300); await pending;
    const before = mode.status.clicks.length;
    const listing = b.api.listModels(undefined, 'work'); await b.tick(5000); await listing;
    assert.equal(mode.status.clicks.length, before, 'active job must not touch switch');
    b.api.stop(); await b.tick(200);
  });
}

test('ChatGPT reads and steps Power, closes menu, and refreshes after model choice', async () => {
  const b = createChatgpt(); const mode = addModeSwitch(b, { selected: 'work' });
  const menu = modelMenu(b, 'chatgpt', mode);
  const run = async fn => { const pending = fn(); await b.tick(5000); await pending; };
  await run(() => b.api.listModels());
  assert.deepEqual(plain(lastOf(b, 'models').effort), { label: 'Light', index: 1, count: 5 });
  for (const [direction, key, label, index] of [['up', 'ArrowRight', 'Medium', 2], ['down', 'ArrowLeft', 'Light', 1]]) {
    const before = menu.keys.length;
    await run(() => b.api.chooseModel('__effort:' + direction));
    assert.deepEqual(menu.keys.slice(before), [key]);
    assert.deepEqual(plain(lastOf(b, 'models').effort), { label, index, count: 5 });
    assert.equal(menu.switcher.getAttribute('aria-expanded'), 'false');
  }
  menu.readout.textContent = 'unparseable';
  await run(() => b.api.listModels()); assert.equal(lastOf(b, 'models').effort, null);
  menu.slider.remove();
  await run(() => b.api.listModels()); assert.equal(lastOf(b, 'models').effort, null);
  const before = b.events.length;
  await run(() => b.api.chooseModel('GPT-6.1 Sol'));
  assert.deepEqual(b.events.slice(before).filter(e => ['model-chosen', 'models'].includes(e.type)).map(e => e.type), ['model-chosen', 'models']);
  assert.equal(menu.switcher.getAttribute('aria-expanded'), 'false');
});

for (const p of PROVIDERS) {
  test(`${p.id} listModes without a control emits both modes with chat selected`, () => {
    const b = p.create();
    b.api.listModes();
    const event = plain(lastOf(b, 'modes'));
    assert.deepEqual(event, {
      type: 'modes', available: false,
      modes: [
        { id: 'chat', label: 'Chat', selected: true },
        { id: 'work', label: p.fallback, selected: false }
      ]
    });
  });

  test(`${p.id} listModes reads the real switch labels and selection`, async () => {
    const b = p.create();
    const mode = addModeSwitch(b, { workLabel: p.work });
    b.api.listModes();
    let event = plain(lastOf(b, 'modes'));
    assert.equal(event.available, true);
    assert.deepEqual(event.modes.map(m => [m.id, m.label, m.selected]), [
      ['chat', 'Chat', true], ['work', p.work, false]
    ]);
    const p1 = b.api.setMode('work');
    await b.tick(1000); await p1;
    event = plain(lastOf(b, 'modes'));
    assert.deepEqual(event.modes.map(m => [m.id, m.label, m.selected]), [
      ['chat', 'Chat', false], ['work', p.work, true]
    ]);
    assert.deepEqual(mode.status.clicks, ['work']);
  });

  test(`${p.id} a history or message item titled like the work mode never matches`, () => {
    const b = p.create();
    addIgnoredChatTitles(b, p.id, p.work);
    b.api.listModes();
    assert.deepEqual(plain(lastOf(b, 'modes')), {
      type: 'modes', available: false,
      modes: [
        { id: 'chat', label: 'Chat', selected: true },
        { id: 'work', label: p.fallback, selected: false }
      ]
    });
  });

  test(`${p.id} a history item titled like the work mode is not chosen over the real switch`, async () => {
    const b = p.create();
    addIgnoredChatTitles(b, p.id, p.work);
    const mode = addModeSwitch(b, { workLabel: p.work });
    const p1 = b.api.setMode('work');
    await b.tick(1000); await p1;
    assert.deepEqual(mode.status.clicks, ['work']);
    assert.equal(plain(lastOf(b, 'modes')).available, true);
  });

  test(`${p.id} setMode refuses an unknown mode and an active job`, async () => {
    const b = p.create();
    await b.api.setMode('spark');
    assert.equal(lastOf(b, 'error').code, 'invalid_mode');
    assert.equal('id' in lastOf(b, 'error'), false);
    b.sendButton.onClick = () => {};
    const sending = b.api.send({ id: 'busy-job', prompt: 'hello' });
    await b.tick(200); await sending;
    await b.api.setMode('work');
    assert.equal(lastOf(b, 'error').code, 'busy');
    assert.equal('id' in lastOf(b, 'error'), false);
    b.api.stop(); await b.tick(200);
  });

  test(`${p.id} setMode fails safely with no work control on a new chat`, async () => {
    const b = p.create();
    const p1 = b.api.setMode('work');
    await b.tick(4000); await p1;
    const error = lastOf(b, 'error');
    assert.equal(error.code, 'mode_unavailable');
    assert.equal(error.message, p.message);
    assert.equal('id' in error, false);
    assert.equal(eventsOf(b, 'modes').length, 0);
  });

  test(`${p.id} with no readable selection, a click that changes nothing is refused`, async () => {
    const b = p.create();
    const mode = addModeSwitch(b, { workLabel: p.work, state: false });
    let sends = 0;
    b.sendButton.onClick = () => { sends++; };
    const sent = b.api.send({ id: 'no-proof', prompt: 'secret prompt', mode: 'work' });
    await b.tick(4000); await sent;
    assert.deepEqual(mode.status.clicks, ['work']);
    assert.equal(sends, 0, 'an unconfirmed switch must never send');
    assert.equal(eventsOf(b, 'error', 'no-proof')[0].code, 'mode_unavailable');
  });

  test(`${p.id} with no readable selection, a visibly changed composer counts as the switch`, async () => {
    const b = p.create();
    const mode = addModeSwitch(b, { workLabel: p.work, state: false });
    const click = mode.work.onClick;
    mode.work.onClick = () => { click(); b.composer.setAttribute('aria-label', 'Do anything'); };
    const p1 = b.api.setMode('work');
    await b.tick(1000); await p1;
    assert.deepEqual(mode.status.clicks, ['work']);
    assert.equal(eventsOf(b, 'error').length, 0);
    assert.equal(plain(lastOf(b, 'modes')).available, true);
  });

  test(`${p.id} a refused pick reports which mode failed`, async () => {
    const b = p.create();
    const p1 = b.api.setMode('work');
    await b.tick(4000); await p1;
    assert.equal(lastOf(b, 'error').mode, 'work');
  });

  test(`${p.id} send work with no control on a new chat fails and never sends`, async () => {
    const b = p.create();
    let sends = 0;
    b.sendButton.onClick = () => { sends++; };
    const sent = b.api.send({ id: 'work-missing', prompt: 'secret prompt', mode: 'work' });
    await b.tick(4000); await sent;
    const error = eventsOf(b, 'error', 'work-missing')[0];
    assert.equal(error.code, 'mode_unavailable');
    assert.equal(error.message, p.message);
    assert.equal(sends, 0);
    assert.equal(b.composerText, '');
  });

  test(`${p.id} send work into a thread it wasn't recorded for fails and never sends`, async () => {
    const b = p.create({ pathname: p.id === 'chatgpt' ? '/c/abcdefgh1234' : '/app/abcdefgh1234' });
    for (const [id, conversationId] of [['work-new', undefined], ['work-other', 'zzzzzzzz9999']]) {
      let sends = 0;
      b.sendButton.onClick = () => { sends++; };
      const sent = b.api.send({ id, prompt: 'secret prompt', mode: 'work', conversationId });
      await b.tick(500); await sent;
      assert.equal(sends, 0);
      assert.equal(eventsOf(b, 'error', id)[0].code, 'mode_unavailable');
    }
  });

  test(`${p.id} send work in its own recorded thread passes without a control`, async () => {
    const b = p.create({ pathname: p.id === 'chatgpt' ? '/c/abcdefgh1234' : '/app/abcdefgh1234' });
    let sends = 0;
    b.sendButton.onClick = () => { sends++; b.addTurn({ userText: b.composerText }); };
    const sent = b.api.send({ id: 'work-thread', prompt: 'keep the thread', mode: 'work', conversationId: 'abcdefgh1234' });
    await b.tick(500); await sent;
    assert.equal(sends, 1);
    assert.equal(eventsOf(b, 'error', 'work-thread').length, 0);
    b.api.stop(); await b.tick(200);
  });

  test(`${p.id} send work selects the mode before it clicks send, then completes from the DOM`, async () => {
    const b = p.create();
    const mode = addModeSwitch(b, { workLabel: p.work });
    const log = [];
    b.sendButton.onClick = () => { log.push('send'); b.setStop(true); b.addTurn({ userText: b.composerText, replyText: 'Finished the task' }); };
    const sent = b.api.send({ id: 'work-ok', prompt: 'do the work', mode: 'work' });
    await b.tick(200); await sent;
    assert.deepEqual(mode.status.clicks, ['work']);
    assert.deepEqual(log, ['send']);
    await b.tick(60000);
    assert.equal(eventsOf(b, 'done', 'work-ok').length, 0, 'a task is still running while its stop button shows');
    b.setStop(false);
    await b.tick(10000);
    assert.equal(eventsOf(b, 'done', 'work-ok').length, 0, 'a short pause between steps is not the end of a task');
    await b.tick(7000);
    const done = eventsOf(b, 'done', 'work-ok')[0];
    assert.ok(done, 'work completes once quiet after its indicator stops');
    assert.match(done.text, /Finished the task/);
  });

  test(`${p.id} a task with no running indicator isn't finished by a short silence`, async () => {
    const b = p.create();
    addModeSwitch(b, { workLabel: p.work });
    b.sendButton.onClick = () => b.addTurn({ userText: b.composerText, replyText: 'Working on step one' });
    const sent = b.api.send({ id: 'work-quiet', prompt: 'do the work', mode: 'work' });
    await b.tick(200); await sent;
    await b.tick(300000);
    assert.equal(eventsOf(b, 'done', 'work-quiet').length, 0);
    await b.tick(310000);
    assert.ok(eventsOf(b, 'done', 'work-quiet')[0], 'ten quiet minutes end the wait');
  });

  test(`${p.id} send without a mode clicks no mode control`, async () => {
    const b = p.create();
    const mode = addModeSwitch(b, { workLabel: p.work });
    let sends = 0;
    b.sendButton.onClick = () => { sends++; };
    const sent = b.api.send({ id: 'no-mode', prompt: 'ordinary chat' });
    await b.tick(300); await sent;
    assert.deepEqual(mode.status.clicks, []);
    assert.equal(sends, 1);
    b.api.stop(); await b.tick(200);
  });

  test(`${p.id} a work approval button fails with needs_attention and keeps partial text`, async () => {
    const b = p.create();
    addModeSwitch(b, { workLabel: p.work });
    b.sendButton.onClick = () => b.addTurn({ userText: b.composerText, replyText: 'Waiting for your approval', attention: 'Approve' });
    const sent = b.api.send({ id: 'attention', prompt: 'long task', mode: 'work' });
    await b.tick(500); await sent;
    const error = eventsOf(b, 'error', 'attention')[0];
    assert.equal(error.code, 'needs_attention');
    assert.equal(error.message, p.attention);
    const delta = eventsOf(b, 'delta', 'attention').at(-1);
    assert.ok(delta, 'partial text is delivered');
    assert.match(delta.text, /Waiting for your approval/);
    assert.equal(eventsOf(b, 'done', 'attention').length, 0);
  });

  test(`${p.id} a paused work task records its thread for the follow-up`, async () => {
    const b = p.create({ pathname: p.id === 'chatgpt' ? '/c/abcdefgh1234' : '/app/abcdefgh1234' });
    b.sendButton.onClick = () => b.addTurn({ userText: b.composerText, replyText: 'Waiting', attention: 'Approve' });
    const sent = b.api.send({ id: 'paused', prompt: 'long task', mode: 'work', conversationId: 'abcdefgh1234' });
    await b.tick(500); await sent;
    assert.equal(eventsOf(b, 'conversation', 'paused')[0].conversationId, 'abcdefgh1234');
    assert.equal(eventsOf(b, 'error', 'paused')[0].code, 'needs_attention');
  });

  test(`${p.id} approval buttons do not matter for an ordinary chat`, async () => {
    const b = p.create();
    b.sendButton.onClick = () => b.addTurn({ userText: b.composerText, replyText: 'Ordinary answer', attention: 'Approve' });
    const sent = b.api.send({ id: 'chat-attention', prompt: 'ordinary' });
    await b.tick(2500); await sent;
    assert.equal(eventsOf(b, 'error', 'chat-attention').length, 0);
    b.api.stop(); await b.tick(200);
  });

  test(`${p.id} a work job keeps running past five minutes`, async () => {
    const b = p.create();
    addModeSwitch(b, { workLabel: p.work });
    b.sendButton.onClick = () => b.addTurn({ userText: b.composerText });
    const sent = b.api.send({ id: 'long-work', prompt: 'a very long task', mode: 'work' });
    await b.tick(200); await sent;
    assert.equal(eventsOf(b, 'start', 'long-work').length, 1, 'a new user message starts a work job');
    await b.tick(301000);
    assert.deepEqual(plain(eventsOf(b, 'error', 'long-work')), []);
    assert.equal(eventsOf(b, 'done', 'long-work').length, 0);
    b.api.stop(); await b.tick(200);
  });
}

test('both bridges skip reasoning for work jobs', () => {
  const chatgpt = chatgptSource;
  assert.match(chatgpt, /reasoningEffort != null && !job\.work && !await selectReasoning/);
  assert.ok(chatgpt.indexOf('await ensureMode(job, mode)') < chatgpt.indexOf('await selectReasoning(job, composer, reasoningEffort)'));
  assert.match(geminiSource, /if \(mode != null && !await ensureMode\(job, mode\)\) return;/);
});

test('Rust validates and routes the mode through send, chat_modes and chat_mode_set', () => {
  assert.match(rust, /fn validate_mode\(value: Option<&str>\) -> Result<\(\), String>/);
  assert.match(rust, /None \| Some\("chat" \| "work"\) => Ok\(\(\)\)/);
  assert.match(rust, /mode: Option<String>/);
  const modeCheck = rust.indexOf('validate_mode(mode.as_deref())?;');
  assert.ok(modeCheck > 0 && modeCheck < rust.indexOf('chat_page(&app)?;'), 'mode is validated before the page is touched');
  assert.match(rust, /"mode":mode/);
  assert.match(rust, /fn chat_modes\(app: tauri::AppHandle\)[^\n]*window\.__qchat\.listModes\(\)/);
  assert.match(rust, /fn chat_mode_set\(app: tauri::AppHandle, mode: String\)[^\n]*\n\s*validate_mode\(Some\(&mode\)\)\?;/);
  assert.match(rust, /window\.__qchat\.setMode\(\{\}\)/);
  assert.match(rust, /chat_models,chat_modes,chat_mode_set,chat_model_choose/);
});

for (const { name, run } of tests) {
  await run();
  console.log('PASS ' + name);
}
console.log(`ALL PASS (${tests.length})`);
