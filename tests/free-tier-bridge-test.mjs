// Free-tier synthetic hazards. Harness copied from mode-bridge-test; fake clock follows auth-bridge-test.
// No network, app, saved profile, or OS input. DOM geometry/occlusion is not simulated.
// Synthetic DOM tests for the Chat/Work and Chat/Task mode contract in both
// provider bridges. No app, browser profile, credentials, network or real DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const chatgptSource = readFileSync(new URL('../src-tauri/bridge/chatgpt-bridge.js', import.meta.url), 'utf8');
const geminiSource = readFileSync(new URL('../src-tauri/bridge/gemini-bridge.js', import.meta.url), 'utf8');
const responseTags = readFileSync(new URL('../ui/response-tags.js', import.meta.url), 'utf8');

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
    fetch: async (...args) => window.fixtureFetch ? window.fixtureFetch(...args) : ({ ok: true, json: async () => ({}) })
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
    URL, AbortController, btoa, atob, console, TextDecoder,
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
    message: "Couldn't confirm Work mode in ChatGPT. Try again or open ChatGPT to check the switch.",
    attention: 'ChatGPT Work is waiting for your approval. Open the chat in ChatGPT to continue.',
    create: createChatgpt, source: chatgptSource
  },
  {
    id: 'gemini', work: 'Task', fallback: 'Task',
    message: "Couldn't confirm Task mode in Gemini. Try again or open Gemini to check the switch.",
    attention: 'Gemini Task is waiting for your approval. Open the chat in Gemini to continue.',
    create: createGemini, source: geminiSource
  }
];

const tests = [];
const test = (name, run) => tests.push({name, run});
const terminal = b => b.events.filter(e => e.id === 'free' && ['error','done'].includes(e.type));
function check(b, code) {
  const all = terminal(b);
  assert.equal(all.length, 1, `expected one terminal event; got ${JSON.stringify(all)}`);
  const e = all[0];
  if (e.type === 'error') { assert.ok(e.code && e.message?.trim(), 'useful error required'); if(code) assert.equal(e.code,code); }
  else { assert.ok(e.text?.trim(), 'done must contain text'); assert.ok(!code, `expected ${code}, got done`); }
  return e;
}
async function send(b, options = {}, ms = 31000) {
  let settled = false;
  const pending = b.api.send({id:'free',prompt:'Keep this prompt',...options}).then(()=>{settled=true;});
  await b.tick(ms);
  assert.ok(settled, 'send method must settle within fake-time budget');
  await pending;
}
// These strings are taken from current bridge regexes, not captures of current site UI.
// Fixtures assert contracts conditional on that markup/copy; they do not establish live coverage.
for (const p of PROVIDERS) {
  test(`${p.id}: absent composer terminates at 15 seconds`, async()=>{
    const b=p.create({ready:false}); await send(b,{},15100); check(b,'not_ready');
  });
  test(`${p.id}: disabled Send and ignored Enter terminate by 30 seconds`, async()=>{
    const b=p.create(); b.sendButton.disabled=true; await send(b); check(b,'send_failed');
    assert.equal(b.composerText,'Keep this prompt');
  });
  test(`${p.id}: click with no request or reply terminates by 20 seconds`, async()=>{
    const b=p.create(); await send(b,{},20100); check(b,'send_failed');
  });
  test(`${p.id}: empty DOM reply terminates within five-minute watchdog`, async()=>{
    const b=p.create(); b.sendButton.onClick=()=>b.addTurn({userText:b.composerText,replyText:''});
    await send(b,{},301000); check(b);
  });
  test(`${p.id}: missing free Work/Task control refuses before typing`, async()=>{
    const b=p.create(); await send(b,{mode:'work'},5000); check(b,'mode_unavailable');
    assert.equal(b.composerText,'');
  });
  test(`${p.id}: locked Work/Task refuses before sending`, async()=>{
    const b=p.create(); const m=addModeSwitch(b,{workLabel:p.work}); m.work.disabled=true; m.work.setAttribute('aria-disabled','true');
    let clicks=0;b.sendButton.onClick=()=>clicks++;await send(b,{mode:'work'},5000);check(b,'mode_unavailable');assert.equal(clicks,0);
  });
  test(`${p.id}: absent model reports unavailable`, async()=>{
    const b=p.create(); let settled=false;
    const pending=b.api.chooseModel('Absent free model').then(()=>{settled=true;});await b.tick(6000);
    assert.ok(settled);await pending;
    assert.ok(b.events.some(e=>e.error==='unavailable'||e.error==='not_found'||e.code==='model_unavailable'),JSON.stringify(b.events));
  });
  test(`${p.id}: recognized quota dialog terminates with rate_limited`, async()=>{
    const b=p.create();b.body.append(makeEl('div',{role:'dialog'},[makeText(p.id==='chatgpt'?"You've reached our limit":'usage limit')]));
    await send(b,{},1000);check(b,'rate_limited');
  });
  test(`${p.id}: login wall without composer terminates with auth`, async()=>{
    const b=p.create({ready:false});b.body.append(makeEl('div',{role:'dialog'},[makeText(p.id==='chatgpt'?'Log in':'Sign in to continue')]));
    await send(b,{},1000);check(b,'auth');
  });
  // Hypothetical blocking dialogs: labels describe the fixture, not alleged site text.
  // A visible composer remains in the DOM under the modal, as is common for modal UIs.
  for(const wall of ['upgrade/paywall','cookie consent','login']) {
    test(`${p.id}: ${wall} modal over existing composer gives an actionable error`,async()=>{
      const b=p.create();const text=wall==='login'?(p.id==='chatgpt'?'Log in':'Sign in to continue'):`Fixture ${wall} requires interaction`;
      b.body.append(makeEl('div',{role:'dialog','aria-modal':'true'},[makeText(text)]));
      // The site's modal intercepts the underlying Send; no request or reply follows.
      await send(b,{},20100);const e=check(b);
      assert.ok(['auth','needs_attention','rate_limited'].includes(e.code),`modal needs action, actual ${e.code}: ${e.message}`);
    });
  }
  test(`${p.id}: downgrade with usable reply still completes with text`,async()=>{
    const b=p.create();b.sendButton.onClick=()=>{
      // Synthetic model label change; no claim about real downgrade banner text.
      b.body.append(makeEl('div',{'data-model':'fallback'},[makeText('Fixture fallback model')]));
      b.addTurn({userText:b.composerText,replyText:'Fallback answer'});
    };await send(b,{},5000);assert.equal(check(b).text,'Fallback answer');
  });
  test(`${p.id}: guest attachment cannot silently send text alone`,async()=>{
    const b=p.create();let clicks=0;b.sendButton.onClick=()=>clicks++;
    await send(b,{attachmentCount:1},121000);check(b,p.id==='gemini'?'attachment_unavailable':'attachment_pending');assert.equal(clicks,0);
  });
}
// ChatGPT observes cloned fetch responses. All bytes below are local synthetic SSE.
function streamResponse(status, text='') {
  let read=false;
  return {ok:status===200,status,headers:{get:()=> 'text/event-stream'},text:async()=>`fixture HTTP ${status}`,
    body:{getReader:()=>({async read(){if(read)return {done:true};read=true;return {done:false,value:new TextEncoder().encode(text)};},async cancel(){}})},clone(){return this;}};
}
for(const status of [429,401,403]) test(`chatgpt: HTTP ${status} terminates with classified error`,async()=>{
  const b=createChatgpt();b.window.fixtureFetch=async()=>streamResponse(status);
  b.sendButton.onClick=()=>{void b.window.fetch('/backend-api/f/conversation',{method:'POST'});};
  await send(b,{},1000);check(b,status===429?'rate_limited':'auth');
});
// The UI turns this into a failed reply: see tests/page-reset-ui-test.mjs.
test('chatgpt: empty successful SSE stream ends with an empty done, never a hang',async()=>{
  const b=createChatgpt();b.window.fixtureFetch=async()=>streamResponse(200,'data: [DONE]\n\n');
  b.sendButton.onClick=()=>{void b.window.fetch('/backend-api/f/conversation',{method:'POST'});};
  await send(b,{},301000);
  const ends=terminal(b);assert.equal(ends.length,1,JSON.stringify(ends));assert.equal(ends[0].type,'done');assert.equal(ends[0].text,'');
});
// A user turn + stop indicates an active reply, then the stop disappears with no reply and no
// visible error. Gemini's transport is unknown here, so the failure can't be classified as a
// limit or an expired session, but it must end promptly rather than at the five-minute watchdog.
test('gemini: a reply that dies with no banner errors promptly',async()=>{
  const b=createGemini();b.sendButton.onClick=()=>{b.addTurn({userText:b.composerText});b.setStop(true);};
  await send(b,{},500);
  b.setStop(false);await b.tick(15000);
  check(b,'stream_failed');
});
for(const status of [401,403]) test(`chatgpt: HTTP ${status} mid-reply preserves partial text and errors`,async()=>{
  const b=createChatgpt();b.sendButton.onClick=()=>{b.addTurn({userText:b.composerText,replyText:'Partial answer'});b.setStop(true);};
  await send(b,{},500);b.window.fixtureFetch=async()=>streamResponse(status);
  await b.window.fetch('/backend-api/f/conversation',{method:'POST'});await b.tick(500);
  check(b,'auth');assert.ok(b.events.some(e=>e.type==='delta'&&e.text.includes('Partial answer')));
});
for(const p of PROVIDERS) test(`${p.id}: recognized quota banner terminates with rate_limited`,async()=>{
  const b=p.create();
  // Markup is explicitly one of blocking()'s selector contracts, not a live capture.
  const banner=p.id==='chatgpt'?makeEl('div',{class:'banner'},[makeText("You've reached our limit")]):makeEl('remy-access-restricted-banner',{},[makeText('usage limit')]);
  (p.id==='chatgpt'?b.composer.closest('form'):b.body).append(banner);
  await send(b,{},1000);check(b,'rate_limited');
});
let failed=0;
for(const {name,run} of tests){try{await run();console.log(`PASS ${name}`);}catch(e){failed++;console.error(`FAIL ${name}\n${e.stack}`);}}
console.log(`RESULT ${tests.length-failed} passed, ${failed} failed, ${tests.length} total`);
process.exitCode=failed?1:0;
