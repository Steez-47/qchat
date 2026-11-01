// Synthetic browser/stream fixtures only. No profile, network, native picker or window.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

const source = process.argv.includes('--baseline')
  ? execFileSync('git', ['show', 'HEAD:src-tauri/bridge/chatgpt-bridge.js'], { encoding: 'utf8' })
  : readFileSync(new URL('../src-tauri/bridge/chatgpt-bridge.js', import.meta.url), 'utf8');
const encoder = new TextEncoder();
const drain = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const message = (parts, extra = {}) => ({ message: { id: 'reply', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts }, ...extra } });
const sse = (...packets) => packets.map(packet => `data: ${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n\n`).join('');
function element(tag, attrs = {}, text = '') {
  return { tagName: tag.toUpperCase(), textContent: text, innerText: text, disabled: false,
    ...attrs, getClientRects: () => [{}], closest: () => null, focus() {},
    getAttribute(key) { return attrs[key] ?? null; }, hasAttribute(key) { return key in attrs; },
    setAttribute(key, value) { attrs[key] = value; }, querySelector: () => null, querySelectorAll: () => [] };
}
function semantic(tag, children = [], attrs = {}) {
  const nodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child, textContent: child } : child);
  const node = element(tag, attrs, nodes.map(child => child.textContent || '').join(''));
  node.childNodes = nodes;
  node.querySelector = selector => nodes.find(child => child.tagName?.toLowerCase() === selector) || nodes.map(child => child.querySelector?.(selector)).find(Boolean) || null;
  return node;
}
function browser({ data = '', chunks, readError, cloneError, cancelReject = false, hold = false, type = 'text/event-stream', networkError, httpError, emitHook, chunkDelays = [], responseOverride, netDisabled = false, requestIdentity = true } = {}) {
  let now = 0, serial = 0, reads = 0, cancels = 0, clicks = 0, stop = false, pending = false, pickerClicks = 0;
  let assistants = [], users = [], composerText = '', submitted = false, inputs = [], attachmentButton, heldRead, originalPart = 0, removeButtons = [], newChats = 0, previewButtons = [];
  const ordered = (node, order) => { node.order = order; node.compareDocumentPosition = other => node.order < other.order ? 4 : 2; return node; };
  const timers = new Map(), events = [], requests = [];
  chunks ||= [encoder.encode(data)];
  const body = element('div');
  const area = element('form');
  area.querySelector = selector => pending && selector.includes('progressbar') ? {} : null;
  area.querySelectorAll = selector => selector === 'button' ? [...removeButtons, ...(attachmentButton ? [attachmentButton] : [])] : [];
  const makeComposer = () => {
    const node = element('div'); node.closest = selector => selector === 'form' ? area : null;
    for (const key of ['innerText', 'textContent']) Object.defineProperty(node, key, { get: () => composerText });
    return node;
  };
  let composer = makeComposer(); const submissions = [];
  const reader = {
    async read() {
      if (reads < chunks.length) {
        const part = reads++;
        if (chunkDelays[part]) await new Promise(resolve => schedule(resolve, chunkDelays[part]));
        return { value: chunks[part], done: false };
      }
      if (readError) throw new Error('observer read failure');
      if (hold) return new Promise(resolve => { heldRead = resolve; });
      return { done: true };
    },
    cancel() { cancels++; return cancelReject ? Promise.reject(new Error('clone cancellation failed')) : new Promise(() => {}); }
  };
  const cloned = { ok: !httpError, status: httpError || 200, text: async () => 'site request failed',
    headers: { get: () => type }, body: { getReader: () => reader },
  };
  const primaryReader = { async read() { return originalPart < chunks.length ? { value: chunks[originalPart++], done: false } : { done: true }; } };
  const stream = responseOverride || { ...cloned, body: { getReader: () => primaryReader },
    clone() { if (cloneError) throw new Error('cannot clone'); return cloned; } };
  const sendButton = element('button');
  sendButton.click = () => {
    clicks++; submitted = true; submissions.push({ text: composerText, attachments: removeButtons.length });
    users.push(ordered(element('div', { 'data-message-author-role': 'user', 'data-message-id': 'current-user' }, composerText), 100));
    window.fetch('/backend-api/f/conversation', { method: 'POST', ...(requestIdentity ? { body: JSON.stringify({ messages: [{ id: 'historical-user', author: { role: 'user' } }, { id: 'current-user', author: { role: 'user' } }] }) } : {}) });
  };
  const stopButton = element('button'); stopButton.click = () => { stop = false; };
  const freshButton = element('button'); freshButton.click = () => { newChats++; assistants = []; inputs = []; removeButtons = []; pending = false; stop = false; };
  const document = {
    title: 'ChatGPT', body, visibilityState: 'visible', hasFocus: () => true,
    execCommand: (command, _, text) => { if (command === 'insertText') composerText = text; return true; },
    querySelector(selector) {
      if (selector === '#prompt-textarea') return composer;
      if (selector === '[data-testid="send-button"]') return sendButton;
      if (selector === '[data-testid="stop-button"]') return stop ? stopButton : null;
      if (selector === '[data-testid="create-new-chat-button"]') return freshButton;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea') return [composer];
      if (selector === 'input[type="file"]') return inputs;
      if (selector.startsWith('[data-message-author-role="user"]')) return users;
      if (selector === 'button[aria-label="Download file"]') return previewButtons.filter(node => node.getAttribute('aria-label') === 'Download file');
      if (selector.startsWith('[data-message-author-role="assistant"]')) return assistants.filter(node => (!node.dilOnly || selector.includes('[data-dil-source-message-id][data-markdown-copy]')) && (!node.searchOnly || selector.includes('[data-chatgpt-search-message-ids]')));
      return [];
    }
  };
  const schedule = (fn, delay, interval = 0) => { const id = ++serial; timers.set(id, { fn, at: now + delay, interval }); return id; };
  const window = {
    __QCHAT_DISABLE_NET__: netDisabled,
    innerWidth: 1280, innerHeight: 720,
    __QCHAT_EMIT__: event => { events.push(event); return emitHook?.(event); },
    fetch(url, options) {
      requests.push({ url, options });
      if (url === '/api/auth/session') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url === '/backend-api/f/conversation') return networkError ? Promise.reject(new Error('site network failed')) : Promise.resolve(stream);
      if (/\/files\//.test(url)) return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ download_url: 'https://files.oaiusercontent.com/result.pdf?secret=download' }) });
      throw new Error(`Unexpected request ${url}`);
    }
  }; window.top = window;
  vm.runInContext(readFileSync(new URL('../ui/response-tags.js', import.meta.url), 'utf8') + '\n' + source, vm.createContext({ window, document, location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/', pathname: '/', origin: 'https://chatgpt.com' },
    URL, TextDecoder, AbortController, console, MutationObserver: class { observe() {} disconnect() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: id => timers.delete(id)
  }));
  return {
    events, requests, api: window.__qchat,
    upload: () => window.fetch('/backend-api/files/fixture', { method: 'POST' }),
    send: (args = {}) => window.__qchat.send({ id: 'job', prompt: 'hello', ...args }),
    get clicks() { return clicks; }, get submissions() { return submissions; }, get composerText() { return composerText; },
    resetComposer() { composerText = ''; }, remountComposer() { composer = makeComposer(); composerText = ''; },
    sendDisabled(value) { sendButton.disabled = value; }, get cancels() { return cancels; }, get pickerClicks() { return pickerClicks; },
    get newChats() { return newChats; },
    get now() { return now; },
    get attachmentCount() { return removeButtons.length; },
    title(value) { document.title = value; },
    later(callback, delay) { return schedule(callback, delay); },
    stop(value) { stop = value; }, pending(value) { pending = value; },
    input(accept = '') { const input = element('input', { accept }); input.accept = accept; input.click = () => { pickerClicks++; }; inputs.push(input); return input; },
    openAttachments() { attachmentButton = element('button', { 'aria-label': 'Attach files' }); attachmentButton.click = () => this.input(); },
    pendingAttachment(name = 'test.txt') {
      const button = element('button', { 'aria-label': `Remove file ${name}` });
      button.click = () => { removeButtons = removeButtons.filter(item => item !== button); pending = false; };
      removeButtons.push(button); pending = true;
      return button;
    },
    previewDownload(name, label = 'Download file') {
      const button = element('button', { 'aria-label': label });
      button.parentElement = element('div', {}, name); button.parentElement.parentElement = body;
      button.scrollIntoView = () => {}; button.getBoundingClientRect = () => ({ left: 500, top: 100, width: 80, height: 40 });
      button.click = () => assert.fail('preview API must return coordinates without clicking');
      previewButtons.push(button); return button;
    },
    dom(text = '', nodes = []) {
      const node = ordered(element('div', {}, text), submitted ? 200 : 0); node.querySelectorAll = () => nodes;
      assistants = [node]; return node;
    },
    gallery(text = '', nodes = []) {
      const node = this.dom(text, nodes); node.searchOnly = true; return node;
    },
    dil(text = '', nodes = []) {
      const body = element('div', { 'data-dil-message-id': 'dil-reply' }, text); body.querySelectorAll = () => nodes;
      const turn = element('div', { 'data-dil-source-message-id': 'source-reply', 'data-markdown-copy': '' }, text);
      turn.dilOnly = true; turn.querySelector = selector => selector === '[data-dil-message-id]' ? body : null;
      turn.querySelectorAll = () => nodes; ordered(turn, submitted ? 200 : 0); assistants = [turn]; return turn;
    },
    history(...nodes) { assistants = nodes; },
    user(text, id, order = 100) { const node = ordered(element('div', { 'data-message-id': id }, text), order); users = [node]; return node; },
    resume() { heldRead?.({ done: true }); },
    async consumeOriginal() {
      const original = stream.body.getReader();
      const parts = []; for (;;) { const { value, done } = await original.read(); if (done) break; parts.push(value); }
      return Buffer.concat(parts).toString('utf8');
    },
    async tick(ms) {
      await drain(); const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due; now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.fn(); await drain();
      }
      now = end; await drain();
    }
  };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
const terminal = b => b.events.filter(event => ['done', 'error'].includes(event.type));
const done = b => b.events.find(event => event.type === 'done');

test('UTF-8 emoji, ZWJ, skin tones, flags and non-Latin survive every split byte', async () => {
  const text = 'A😀 👩🏽‍🚀 🇳🇿 café e\u0301 中文 日本語 العربية हिन्दी Z';
  const bytes = encoder.encode(sse(message([text]), '[DONE]'));
  for (let split = 1; split < bytes.length; split++) {
    const b = browser({ chunks: [bytes.slice(0, split), bytes.slice(split)] });
    await b.send(); await b.tick(200);
    assert.equal(done(b)?.text, text, `split ${split}`);
    assert.equal(terminal(b).length, 1);
  }
});
test('existing NDJSON Unicode decoder also preserves one-byte chunks', async () => {
  const text = '😀 👩🏽‍🚀 🇳🇿 café e\u0301 中文 日本語 العربية हिन्दी';
  const bytes = encoder.encode(JSON.stringify({ type: 'content', messageId: 'a', revision: 1, markdown: text }) + '\n' + JSON.stringify({ type: 'done' }));
  const b = browser({ type: 'application/x-ndjson', chunks: Array.from(bytes, byte => new Uint8Array([byte])) });
  await b.send(); await b.tick(1000); assert.equal(done(b)?.text, text);
});
test('parsed high/low surrogate patches never send invalid Unicode to the native emitter', async () => {
  let rejected = 0;
  const b = browser({
    chunks: [sse(message(['line \uD83D'])), sse({ p: '/message/content/parts/0', o: 'append', v: '\uDE0A complete' }), sse('[DONE]')].map(text => encoder.encode(text)),
    chunkDelays: [0, 150, 100],
    emitHook(event) {
      if (typeof event.text === 'string' && /\p{Surrogate}/u.test(event.text)) {
        rejected++; return Promise.reject(new Error('native JSON rejected lone surrogate'));
      }
    }
  });
  await b.send(); await b.tick(100);
  assert.equal(b.events.find(event => event.type === 'delta')?.text, 'line ');
  assert.equal(terminal(b).length, 0);
  await b.tick(500);
  assert.equal(rejected, 0); assert.equal(done(b)?.text, 'line 😊 complete');
});
test('twelve emoji lines plus final marker survive patches split at every UTF-16 code unit', async () => {
  const text = Array.from({ length: 12 }, (_, i) => `${i + 1}. 😊 👨‍👩‍👧‍👦 👍🏽 🇳🇿 ${i + 1}`).join('\n') + '\nFINAL_MARKER';
  let invalid = 0;
  const packets = [sse(message([''])), ...text.split('').map(unit => sse({ p: '/message/content/parts/0', o: 'append', v: unit })), sse('[DONE]')];
  const b = browser({ chunks: packets.map(packet => encoder.encode(packet)), chunkDelays: packets.map((_, i) => i ? 60 : 0),
    emitHook(event) {
      if (typeof event.text === 'string' && /\p{Surrogate}/u.test(event.text)) {
        invalid++; return Promise.reject(new Error('native rejected invalid Unicode'));
      }
    }
  });
  await b.send(); await b.tick(packets.length * 60 + 200);
  assert.equal(invalid, 0); assert.equal(done(b)?.text, text); assert.match(done(b)?.text, /FINAL_MARKER$/);
});
test('emitter promise rejection is handled and later cumulative snapshots resync', async () => {
  const unhandled = []; const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  let rejected = false; const accepted = [];
  try {
    const b = browser({
      chunks: [sse(message(['first'])), sse({ p: '/message/content/parts/0', o: 'append', v: ' 😀 later' }), sse('[DONE]')].map(text => encoder.encode(text)),
      chunkDelays: [0, 150, 100],
      emitHook(event) {
        if (event.type === 'delta' && !rejected) { rejected = true; return Promise.reject(new Error('temporary native rejection')); }
        accepted.push(event); return Promise.resolve();
      }
    });
    await b.send(); await b.tick(500); await new Promise(resolve => setImmediate(resolve));
    assert.equal(rejected, true); assert.equal(unhandled.length, 0);
    assert.equal(accepted.filter(event => event.type === 'delta').at(-1)?.text, 'first 😀 later');
    assert.equal(done(b)?.text, 'first 😀 later'); assert.equal(terminal(b).length, 1);
  } finally { process.removeListener('unhandledRejection', listener); }
});
test('terminal snapshots repair truly unpaired surrogates safely', async () => {
  const b = browser({ data: sse(message(['bad \uDC00 end \uD83D']), '[DONE]') });
  await b.send(); await b.tick(200);
  assert.equal(done(b)?.text, 'bad � end �');
  for (const event of b.events) if (typeof event.text === 'string') assert.doesNotMatch(event.text, /\p{Surrogate}/u);
});
test('terminal observer packet does not finish while the site still shows Stop', async () => {
  const b = browser({ data: sse(message(['partial']), '[DONE]') });
  b.stop(true); await b.send(); await b.tick(500); assert.equal(terminal(b).length, 0);
  b.dom('complete from site 😀'); await b.tick(300); b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'complete from site 😀'); assert.equal(terminal(b).length, 1);
});

test('restored legacy and DIL history cannot restream text, images or progress during the new turn', async () => {
  for (const dil of [false, true]) {
    const b = browser({ cloneError: true });
    const prior = dil ? b.dil('Old reply') : b.dom('Old reply');
    prior.setAttribute(dil ? 'data-dil-source-message-id' : 'data-message-id', 'old-reply');
    if (dil) prior.querySelector('[data-dil-message-id]').setAttribute('data-dil-message-id', 'old-dil');
    await b.send(); b.stop(true);
    const oldImage = element('img', { alt: 'Old car' }); oldImage.src = 'blob:https://chatgpt.com/old-car'; oldImage.naturalWidth = 1024;
    const restored = dil ? b.dil('Creating image 37%', [oldImage]) : b.dom('Creating image 37%', [oldImage]);
    restored.order = 20;
    restored.setAttribute(dil ? 'data-dil-source-message-id' : 'data-message-id', 'old-reply');
    const late = dil ? b.dil('Old reply hydrated late') : b.dom('Old reply hydrated late');
    late.order = 30;
    late.setAttribute(dil ? 'data-dil-source-message-id' : 'data-message-id', 'late-history');
    b.history(restored, late); await b.tick(300);
    assert.equal(b.events.filter(event => ['delta', 'media', 'image_progress'].includes(event.type)).length, 0);
    const freshImage = element('img', { alt: 'New scene' }); freshImage.src = 'blob:https://chatgpt.com/new-scene';
    const fresh = dil ? b.dil('New story 😀', [freshImage]) : b.dom('New story 😀', [freshImage]);
    fresh.setAttribute(dil ? 'data-dil-source-message-id' : 'data-message-id', 'new-reply');
    b.history(restored, late, fresh); await b.tick(300);
    // React can replace a historical message while the current reply streams.
    const replacement = dil ? b.dil('Creating image 73%', [oldImage]) : b.dom('Creating image 73%', [oldImage]);
    replacement.order = 20; replacement.setAttribute(dil ? 'data-dil-source-message-id' : 'data-message-id', 'old-reply');
    b.history(replacement, late, fresh); await b.tick(300); b.stop(false); await b.tick(1500);
    assert.equal(done(b)?.text, 'New story 😀');
    assert.equal(terminal(b).length, 1);
    assert.ok(!b.events.some(event => event.type === 'image_progress'));
    assert.ok(b.events.filter(event => event.type === 'delta').every(event => event.text === 'New story 😀'));
    const items = b.events.filter(event => event.type === 'media').at(-1).items;
    assert.equal(items.length, 1); assert.equal(items[0].name, 'New scene');
    assert.equal((await b.api.resolveMedia(items[0].id)).url, freshImage.src);
  }
});

test('request user identity rejects restored same-prompt history until the real user turn mounts', async () => {
  const b = browser({ cloneError: true }); await b.send(); b.stop(true);
  b.user('hello', 'historical-user', 10);
  const old = b.dom('Creating image 50%'); old.order = 20;
  await b.tick(300);
  assert.ok(!b.events.some(event => ['delta', 'media', 'image_progress'].includes(event.type)));
  b.user('hello', 'current-user', 100);
  b.dom('Fresh reply'); await b.tick(200); b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'Fresh reply');
});

test('response message identity permits DOM recovery before the user boundary hydrates', async () => {
  const b = browser({ data: sse(message(['prefix'])), readError: true }); await b.send(); b.stop(true);
  b.user('older question', 'historical-user', 10);
  const old = b.dom('Old historical text'); old.setAttribute('data-message-id', 'old-reply');
  await b.tick(300);
  assert.ok(b.events.filter(event => event.type === 'delta').every(event => event.text === 'prefix'));
  const fresh = b.dom('prefix complete 😀'); fresh.setAttribute('data-message-id', 'reply');
  b.history(old, fresh); await b.tick(300); b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'prefix complete 😀');
});

test('nested current user bubbles inherit identity from their search unit before streaming DOM replies', async () => {
  const b = browser({ cloneError: true }); await b.send(); b.stop(true);
  const parent = element('div', { 'data-chatgpt-search-message-ids': 'current-user' });
  const bubble = b.user('hello', undefined);
  bubble.closest = selector => selector.includes('[data-chatgpt-search-message-ids]') ? parent : null;
  const old = b.dom('Old historical response'); old.order = 20;
  const fresh = b.dil('First streamed words');
  b.history(old, fresh);
  await b.tick(300);
  assert.ok(b.events.some(event => event.type === 'delta' && event.text === 'First streamed words'));
  assert.ok(!b.events.some(event => event.text?.includes('Old historical')));
  const complete = b.dil('First streamed words followed by the completed answer');
  b.history(old, complete);
  await b.tick(300); b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'First streamed words followed by the completed answer');
  assert.equal(terminal(b).length, 1);
});

test('DOM-only fallback uses the submitted prompt boundary without network identity', async () => {
  const b = browser({ netDisabled: true, requestIdentity: false });
  b.user('earlier question', 'historical-user', 10);
  await b.send(); b.stop(true);
  const old = b.dom('Creating image 20%'); old.order = 20;
  await b.tick(300);
  assert.ok(!b.events.some(event => ['delta', 'media', 'image_progress'].includes(event.type)));
  const fresh = b.dom('New DOM-only reply 👩🏽‍🚀'); b.history(old, fresh);
  await b.tick(300); b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'New DOM-only reply 👩🏽‍🚀');
  assert.ok(!b.events.some(event => event.type === 'image_progress'));
});

test('known historical message snapshots in SSE and NDJSON cannot register text or media', async () => {
  for (const ndjson of [false, true]) {
    const old = message(['Old story', { type: 'image', url: 'https://chatgpt.com/old-car.png' }], { id: 'historical-reply' });
    const packets = ndjson ? [
      { type: 'content', messageId: 'historical-reply', revision: 1, markdown: 'Old story', parts: old.message.content.parts },
      { type: 'content', messageId: 'new-reply', revision: 1, markdown: 'Fresh story 😀' }, { type: 'done' }
    ] : [old, message(['Fresh story 😀'], { id: 'new-reply' }), '[DONE]'];
    const b = browser({ type: ndjson ? 'application/x-ndjson' : 'text/event-stream', data: ndjson ? packets.map(packet => JSON.stringify(packet)).join('\n') : sse(...packets) });
    b.dom('Old story').setAttribute('data-message-id', 'historical-reply');
    await b.send(); await b.tick(1000);
    assert.equal(done(b)?.text, 'Fresh story 😀');
    assert.ok(!b.events.some(event => event.type === 'media'));
    assert.ok(b.events.filter(event => event.type === 'delta').every(event => !event.text.includes('Old')));
  }
});

test('a positively scoped DOM download remains usable after a later user turn', async () => {
  const b = browser({ cloneError: true }); await b.send(); b.stop(true);
  let clicks = 0;
  const link = element('a', {}, 'report.csv'); link.href = 'sandbox:/mnt/data/report.csv'; link.click = () => { clicks++; };
  const reply = b.dil('Download report.csv', [link]);
  await b.tick(300); b.stop(false); await b.tick(1500);
  assert.ok(done(b));
  const id = b.events.find(event => event.type === 'media').items[0].id;
  b.user('a later question', 'later-user', 300);
  const remounted = b.dil('Download report.csv', [link]); remounted.order = 200;
  assert.notEqual(remounted, reply);
  await b.api.activateMedia(id); assert.equal(clicks, 1);
});
test('completed signed-in DIL DOM replaces a stale parsed prefix and scopes media lookup', async () => {
  const full = Array.from({ length: 12 }, (_, i) => `${i + 1}. 😊 👨‍👩‍👧‍👦 👍🏽 🇳🇿`).join('\n') + '\nQCHAT_UNICODE_DONE';
  const b = browser({ chunks: [sse(message([full.slice(0, 57), { type: 'file', name: 'report.csv', url: 'sandbox:/mnt/data/report.csv' }])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100);
  const file = element('a', {}, 'report.csv'); file.href = 'sandbox:/mnt/data/report.csv'; let clicks = 0; file.click = () => { clicks++; };
  b.dil(full, [file]); await b.tick(500); assert.equal(terminal(b).length, 0);
  await b.tick(1000);
  assert.equal(done(b)?.text, full); assert.match(done(b)?.text, /QCHAT_UNICODE_DONE$/);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  await b.api.activateMedia(id); assert.equal(clicks, 1);
});
test('DIL text mounting after the terminal packet is allowed to settle fully', async () => {
  const b = browser({ chunks: [sse(message(['prefix'])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100); b.dil('prefix still rendering');
  await b.tick(500); assert.equal(terminal(b).length, 0);
  b.dil('prefix still rendering and now complete QCHAT_UNICODE_DONE');
  await b.tick(500); assert.equal(terminal(b).length, 0);
  await b.tick(700); assert.equal(done(b)?.text, 'prefix still rendering and now complete QCHAT_UNICODE_DONE');
});
test('media-only DIL completion has a bounded settle wait without text', async () => {
  const b = browser({ chunks: [sse(message([{ type: 'image', url: 'https://chatgpt.com/generated.png' }])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100); b.dil(''); await b.tick(1500);
  assert.ok(done(b)); assert.equal(terminal(b).length, 1);
});
test('completed DIL fallback preserves semantic code fences, inline formatting and lists', async () => {
  const code = 'const face = "😀";\n\n\nconsole.log(face);\n';
  const paragraph = semantic('p', ['Use ', semantic('strong', ['bold']), ' and ', semantic('em', ['care']), ' with ', semantic('code', ['face']), '.']);
  const block = semantic('pre', [semantic('code', [code], { className: 'language-js' })]);
  const list = semantic('ul', [semantic('li', ['First 😀']), semantic('li', ['Second'])]);
  const b = browser({ chunks: [sse(message(['Use'])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100);
  const turn = b.dil('Use bold and care with face.\n' + code + '\nFirst 😀\nSecond');
  turn.querySelector('[data-dil-message-id]').childNodes = [semantic('h2', ['Example']), paragraph, block, list];
  await b.tick(1500);
  assert.match(done(b)?.text, /^## Example/);
  assert.match(done(b)?.text, /Use \*\*bold\*\* and \*care\* with `face`\./);
  assert.ok(done(b)?.text.includes('```js\n' + code + '```'));
  assert.match(done(b)?.text, /- First 😀\n- Second/);
  assert.doesNotMatch(done(b)?.text, /<pre|<strong/);
});
test('DIL markdown links use opaque registered media and safe normal HTTPS links', async () => {
  const file = semantic('a', ['Download CSV'], { href: 'sandbox:/mnt/data/report.csv' }); file.href = 'sandbox:/mnt/data/report.csv';
  const normal = semantic('a', ['Reference'], { href: 'https://example.com/reference' }); normal.href = 'https://example.com/reference';
  const unsafe = semantic('a', ['Unsafe'], { href: 'javascript:alert(1)' }); unsafe.href = 'javascript:alert(1)';
  const b = browser({ chunks: [sse(message(['Files'])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100);
  const turn = b.dil('Files Download CSV Reference Unsafe', [file, normal, unsafe]);
  turn.querySelector('[data-dil-message-id]').childNodes = [semantic('p', ['Files ', file, ' ', normal, ' ', unsafe])];
  await b.tick(1500);
  assert.match(done(b)?.text, /\[Download CSV\]\(qchat-media:/);
  assert.match(done(b)?.text, /\[Reference\]\(https:\/\/example\.com\/reference\)/);
  assert.doesNotMatch(done(b)?.text, /sandbox:|javascript:/);
});
test('custom patch arrays and JSON Patch additions preserve mixed parts', async () => {
  const b = browser({ data: sse({ v: message(['Hello']) },
    { o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: ' 😀' }] },
    { op: 'add', path: '/message/content/parts/-', value: { type: 'text', text: ' world' } },
    { op: 'add', path: '/message/content/parts/-', value: { type: 'image', url: 'https://chatgpt.com/image.png' } }, '[DONE]') });
  await b.send(); await b.tick(200);
  assert.equal(done(b)?.text, 'Hello 😀 world');
  assert.equal(b.events.filter(event => event.type === 'media').at(-1)?.items.length, 1);
});
test('standard messages, append patches, malformed packets and terminal SSE without newline', async () => {
  const b = browser({ data: sse(message(['one']), '{malformed', { p: '/message/content/parts/0', o: 'append', v: ' 😀' }) + 'data: [DONE]' });
  await b.send(); await b.tick(200);
  assert.equal(done(b)?.text, 'one 😀'); assert.equal(terminal(b).length, 1);
});
test('NDJSON final packet without trailing newline and revision snapshots', async () => {
  const b = browser({ type: 'application/x-ndjson', data: [
    { type: 'content', messageId: 'a', revision: 1, markdown: 'Hello ' },
    { type: 'content', messageId: 'a', revision: 2, baseRevision: 1, mode: 'append', markdown: '😀' },
    { type: 'done' }
  ].map(JSON.stringify).join('\n') });
  await b.send(); await b.tick(200); assert.equal(done(b)?.text, 'Hello 😀');
});
test('DIL fallback snapshots replace layout deltas and corrected prose without duplication', async () => {
  const heading = '## GTA VI: Interpreting the Edge Magazine exclusive';
  const first = heading + '\n\nI have gone through the original article. And how his';
  const final = heading + '\n\nI have gone through the original article. And honestly, there is more to unpack.\n\n[Read the full feature](https://example.com/edge)';
  const packets = [
    { type: 'content', messageId: 'a', revision: 1, markdown: '<row align="center" gap={3}><AsyncImage query="Edge"/><text weight="medium">Edge #430</text></row>', dil: { fallbackMarkdown: first } },
    { type: 'content', messageId: 'a', revision: 2, baseRevision: 1, mode: 'append', markdown: '<box flex="1">stale layout</box>', dil: { fallbackMarkdown: final } },
    { type: 'content', messageId: 'a', revision: 3, baseRevision: 2, mode: 'append', markdown: '<text size="xs">still layout</text>' },
    { type: 'done' }
  ];
  const b = browser({ type: 'application/x-ndjson', chunks: packets.map(packet => encoder.encode(JSON.stringify(packet) + '\n')), chunkDelays: [0, 120, 120, 120] });
  await b.send(); await b.tick(1000);
  assert.equal(done(b)?.text, final);
  const replies = b.events.filter(event => ['delta', 'done'].includes(event.type));
  for (const event of replies) {
    assert.doesNotMatch(event.text, /<row|<box|<text|AsyncImage|stale layout/);
    assert.equal((event.text.match(/Interpreting the Edge/g) || []).length, 1);
  }
  if (process.env.QCHAT_RICH_REPLAY) writeFileSync(process.env.QCHAT_RICH_REPLAY, JSON.stringify(replies));
});
test('raw rich layout uses the scoped rendered reply even when the corrected reply is shorter', async () => {
  const raw = '## GTA VI\n\n<row align="center" gap={3}><AsyncImage query="secret image query"/><text weight="medium">Edge #430</text></row>\n' + 'stale draft '.repeat(100);
  const b = browser({ data: sse(message([raw])), hold: true });
  b.stop(true); await b.send(); await b.tick(150);
  const turn = b.dil('GTA VI\nEdge #430\nCorrected paragraph.\nRead the feature');
  const link = semantic('a', ['Read the feature'], { href: 'https://example.com/edge' }); link.href = 'https://example.com/edge';
  turn.querySelector('[data-dil-message-id]').childNodes = [semantic('h2', ['GTA VI']), semantic('p', ['Edge #430']), semantic('p', ['Corrected paragraph.']), link];
  await b.tick(300);
  const delta = b.events.filter(event => event.type === 'delta').at(-1);
  assert.match(delta?.text, /## GTA VI/); assert.match(delta?.text, /\[Read the feature\]\(https:\/\/example.com\/edge\)/);
  b.stop(false); b.resume(); await b.tick(2000);
  assert.match(done(b)?.text, /Corrected paragraph/);
  assert.doesNotMatch(JSON.stringify(b.events), /<row|<text|AsyncImage|secret image query|stale draft/);
});
test('empty DIL snapshot clears earlier prose and literal layout code examples stay intact', async () => {
  const b = browser({ type: 'application/x-ndjson', data: [
    { type: 'content', messageId: 'a', revision: 1, markdown: 'old', dil: { fallbackMarkdown: 'old' } },
    { type: 'content', messageId: 'a', revision: 2, markdown: 'stale raw', dil: { fallbackMarkdown: '' } }, { type: 'done' }
  ].map(JSON.stringify).join('\n') });
  await b.send(); await b.tick(1000); assert.equal(done(b)?.text, '');
  const code = 'Example:\n```jsx\n<row align="center" gap={3}>hello</row>\n```\nUse ` <AsyncImage query="test"/> ` in code.';
  const c = browser({ data: sse(message([code]), '[DONE]') });
  await c.send(); await c.tick(200); assert.equal(done(c)?.text, code);
});
test('shorter canonical DIL correction wins over a longer stale rendered draft at completion', async () => {
  const packets = [
    { type: 'content', messageId: 'a', revision: 1, markdown: '<row>layout</row>', dil: { fallbackMarkdown: 'A stale draft paragraph that is much too long.' } },
    { type: 'content', messageId: 'a', revision: 2, markdown: '<row>layout</row>', dil: { fallbackMarkdown: 'Corrected.' } }, { type: 'done' }
  ];
  const b = browser({ type: 'application/x-ndjson', chunks: packets.map(packet => encoder.encode(JSON.stringify(packet) + '\n')), chunkDelays: [0, 200, 200] });
  b.stop(true); await b.send(); await b.tick(100);
  b.dil('A stale draft paragraph that is much too long.');
  await b.tick(600); b.stop(false); await b.tick(2000);
  assert.equal(done(b)?.text, 'Corrected.');
});
test('clone cancellation cannot hang or reject a completed stream', async () => {
  for (const cancelReject of [false, true]) {
    const b = browser({ data: sse(message(['complete']), '[DONE]'), cancelReject });
    await b.send(); await b.tick(200);
    assert.equal(done(b)?.text, 'complete'); assert.equal(b.cancels, 1);
    assert.equal(await b.consumeOriginal(), sse(message(['complete']), '[DONE]'));
  }
});
test('real Response.clone cancellation leaves the original fetch body intact', async () => {
  const text = sse(message(['real tee 😀']), '[DONE]') + ': original branch still owns this tail\n';
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });
  let cancellations = 0;
  const clone = response.clone.bind(response);
  response.clone = () => {
    const observer = clone(); const reader = observer.body.getReader();
    return { ok: observer.ok, headers: observer.headers, body: { getReader: () => ({
      read: () => reader.read(), cancel: () => { cancellations++; return reader.cancel(); }
    }) } };
  };
  const b = browser({ responseOverride: response });
  await b.send(); await new Promise(resolve => setImmediate(resolve)); await b.tick(200);
  assert.equal(done(b)?.text, 'real tee 😀'); assert.equal(cancellations, 1);
  assert.equal(await b.consumeOriginal(), text);
});
test('reader rejection preserves partial text and recovers via DOM, with no early done', async () => {
  const b = browser({ data: sse(message(['partial'])), readError: true });
  b.stop(true); await b.send(); await b.tick(100);
  assert.equal(terminal(b).length, 0); assert.equal(b.events.find(event => event.type === 'delta')?.text, 'partial');
  b.dom('partial plus DOM'); b.stop(false); await b.tick(400); assert.equal(terminal(b).length, 0);
  b.stop(true); await b.tick(100); assert.equal(terminal(b).length, 0);
  b.stop(false); await b.tick(1500);
  assert.equal(done(b)?.text, 'partial plus DOM'); assert.equal(terminal(b).length, 1); assert.equal(b.cancels, 1);
});
test('clone failure and premature EOF detach, then timeout instead of an infinite wait', async () => {
  for (const options of [{ cloneError: true }, { data: sse(message(['partial'])) }]) {
    const b = browser(options); await b.send(); await b.tick(200);
    assert.equal(terminal(b).length, 0);
    await b.tick(301000); assert.equal(terminal(b).length, 1); assert.equal(terminal(b)[0].code, 'timeout');
    if (!options.cloneError) assert.equal(b.events.find(event => event.type === 'delta')?.text, 'partial');
  }
});
test('Stop finishes promptly exactly once and late observer reads cannot emit', async () => {
  const b = browser({ data: sse(message(['partial'])), hold: true });
  b.stop(true); await b.send(); await b.tick(100); b.api.stop(); await b.tick(100);
  assert.equal(done(b)?.text, 'partial'); assert.equal(b.cancels, 1);
  const count = b.events.filter(event => event.type !== 'status').length; b.resume(); await b.tick(1000);
  assert.equal(b.events.filter(event => event.type !== 'status').length, count); assert.equal(terminal(b).length, 1);
});
test('genuine network and HTTP errors terminate once', async () => {
  for (const options of [{ networkError: true }, { httpError: 429 }]) {
    const b = browser(options); await b.send(); await b.tick(200);
    assert.equal(terminal(b).length, 1); assert.equal(terminal(b)[0].type, 'error');
  }
});
test('mixed structured parts emit safe opaque metadata and exclude analysis/tools', async () => {
  const b = browser({ data: sse(
    message(['SECRET ANALYSIS'], { channel: 'analysis' }),
    message(['SECRET TOOL'], { author: { role: 'tool' } }),
    message(['Visible 😀', { content_type: 'image_asset_pointer', asset_pointer: 'https://files.oaiusercontent.com/image.png?secret=signed' },
      { type: 'audio', url: 'blob:https://chatgpt.com/audio' }, { type: 'video', url: 'https://chatgpt.com/video.mp4' },
      { type: 'file', filename: 'report.pdf', url: 'sandbox:/mnt/data/report.pdf' }, { type: 'document', format: 'unhandled_rich_content' }]), '[DONE]') });
  await b.send(); await b.tick(200);
  assert.equal(done(b)?.text, 'Visible 😀');
  const items = b.events.filter(event => event.type === 'media').at(-1).items;
  assert.deepEqual(Array.from(items, item => item.kind), ['image', 'audio', 'video', 'file', 'file']);
  assert.doesNotMatch(JSON.stringify(b.events), /secret|sandbox:|blob:|SECRET|oaiusercontent/);
  assert.equal(b.events.filter(event => event.type === 'media' && event.final).length, 1);
  assert.match((await b.api.resolveMedia(items[0].id)).url, /secret=signed/);
  await assert.rejects(b.api.resolveMedia(items[3].id), /View it in ChatGPT/);
});
test('internal thoughts and non-media metadata never produce placeholder attachment cards', async () => {
  const b = browser({ data: sse(message(['Visible 😀', {}, { type: 'unhandled_rich_content' },
    { type: 'thoughts', filename: 'secret.txt', url: 'https://chatgpt.com/secret.txt' },
    { type: 'metadata', assets: [{ type: 'image', url: 'https://chatgpt.com/internal.png' }] },
    { content_type: 'status', name: 'Working' }, { title: 'Ordinary metadata' }]),
    message(['SECRET THOUGHT'], { content: { content_type: 'thoughts', parts: ['SECRET THOUGHT'] } }),
    message([], { content: { content_type: 'metadata', debug: true } }), '[DONE]') });
  await b.send(); await b.tick(200);
  assert.equal(done(b)?.text, 'Visible 😀');
  assert.equal(b.events.filter(event => event.type === 'media').length, 0);
  assert.doesNotMatch(JSON.stringify(b.events), /SECRET|secret\.txt|internal\.png|Attachment/);
});
test('web sources resolve citations without turning search thumbnails into generated media', async () => {
  const text = 'See <Cite ref="turn0search0"/> and \uE200cite\uE202turn0search1\uE201. ![Thumbnail](https://example.com/photo.jpg) [Image](https://example.com/image.png)';
  const b = browser({ data: sse(message([text,
    { type: 'image_search', images: [{ type: 'image', url: 'https://example.com/search.jpg' }] },
    { type: 'webpage', url: 'https://example.com/page', images: [{ type: 'image', url: 'https://example.com/thumb.jpg' }] },
    { title: 'Search thumbnail', url: 'https://example.com/other.jpg' }
  ], { metadata: { content_references: [
    { ref_id: 'turn0search0', webpage: { url: 'https://example.com/article', title: 'First article' } },
    { items: [{ ref_id: 'turn0search1', type: 'webpage', url: 'https://example.org/story', title: 'Second article' }] }
  ] } }), '[DONE]') });
  await b.send(); await b.tick(200);
  const sources = b.events.find(event => event.type === 'sources');
  assert.equal(sources.id, 'job');
  assert.deepEqual(Array.from(sources.items, item => ({ ...item })), [
    { id: 'turn0search0', url: 'https://example.com/article', title: 'First article' },
    { id: 'turn0search1', url: 'https://example.org/story', title: 'Second article' }
  ]);
  assert.match(done(b)?.text, /See \[First article\]\(https:\/\/example.com\/article\) and \[Second article\]\(https:\/\/example.org\/story\)/);
  assert.doesNotMatch(JSON.stringify(b.events.filter(event => ['done', 'delta'].includes(event.type))), /<Cite|turn0search|[\uE200-\uE202]/);
  assert.equal(b.events.filter(event => ['media', 'image_progress'].includes(event.type)).length, 0);
});

test('structured web reference indices and nested webpage items resolve ordinary citation links', async () => {
  const b = browser({ data: sse(message(['News <Cite ref="turn761040news16"/>.'], {
    metadata: { content_references: [{ items: [
      { refs: [{ turn_index: 761040, ref_type: 'news', ref_index: 16 }], webpage: { url: 'https://example.com/news', title: 'News article' } },
      { webpage: { url: 'https://example.com/other', title: 'Other source' } },
      { ref_id: 'unsafe', webpage: { url: 'javascript:alert(1)', title: 'Unsafe' } }
    ] }] }
  }), '[DONE]') });
  await b.send(); await b.tick(200);
  const sources = b.events.find(event => event.type === 'sources');
  assert.equal(sources.items.length, 2);
  assert.equal(sources.items[0].id, 'turn761040news16');
  assert.equal(done(b)?.text, 'News [News article](https://example.com/news).');
  assert.equal(b.events.filter(event => event.type === 'media').length, 0);
});

test('late citation metadata refreshes text and unresolved or partial tokens stay hidden', async () => {
  const b = browser({ data: sse(message(['Read <Cite ref="turn1search0"/> \uE200cite\uE202missing\uE201 <Cite ref="partial']),
    { op: 'add', path: '/message/metadata', value: { content_references: [{ ref_id: 'turn1search0', url: 'https://example.com/source', title: 'Source' }] } }, '[DONE]') });
  await b.send(); await b.tick(200);
  assert.match(done(b)?.text, /\[Source\]\(https:\/\/example.com\/source\)/);
  assert.doesNotMatch(JSON.stringify(b.events.filter(event => ['done', 'delta'].includes(event.type))), /<Cite|turn1search|missing|partial|[\uE200-\uE202]/);
});

test('linked web thumbnails and image anchors in DOM do not create media or generation progress', async () => {
  const b = browser({ cloneError: true }); b.stop(true); await b.send(); await b.tick(100);
  const thumbnail = element('img', { alt: 'Search result' }); thumbnail.src = 'https://example.com/thumb.jpg';
  thumbnail.closest = selector => selector === 'a[href]' ? {} : null;
  const hostedThumbnail = element('img', { alt: 'Linked preview' }); hostedThumbnail.src = 'https://files.oaiusercontent.com/thumb.png';
  hostedThumbnail.closest = thumbnail.closest;
  const anchor = element('a'); anchor.href = 'https://example.com/photo.jpg';
  b.dom('Search results', [thumbnail, hostedThumbnail, anchor]); await b.tick(200); b.stop(false); await b.tick(1500);
  assert.ok(done(b));
  assert.equal(b.events.filter(event => ['media', 'image_progress'].includes(event.type)).length, 0);
});

test('markdown downloads are registered, deduplicated and do not leak URLs', async () => {
  const text = 'Look 😀 ![cat](https://files.oaiusercontent.com/cat.png?secret=token) [report.pdf](sandbox:/mnt/data/report.pdf)';
  const b = browser({ data: sse(message([text]), message([text]), '[DONE]') });
  await b.send(); await b.tick(200);
  assert.match(done(b)?.text, /Look 😀 !\[cat\]\(qchat-media:/);
  assert.equal(b.events.filter(event => event.type === 'media').at(-1).items.length, 2);
  assert.doesNotMatch(JSON.stringify(b.events), /secret|sandbox:|oaiusercontent/);
});
test('media-only DOM fallback uses actual sources and resolves sandbox anchor filenames', async () => {
  const b = browser({ cloneError: true }); b.stop(true); await b.send(); await b.tick(100);
  const image = element('img', { src: 'https://files.oaiusercontent.com/live.png', alt: 'Picture' });
  image.src = image.currentSrc = 'blob:https://chatgpt.com/current-image';
  const audio = element('audio'); audio.src = 'https://chatgpt.com/speech.mp3';
  const video = element('video'); video.src = 'https://chatgpt.com/movie.mp4';
  const file = element('a', { download: 'report.pdf' }); file.href = 'https://chatgpt.com/backend-api/files/report/download';
  b.dom('', [image, audio, video, file]); await b.tick(200); b.stop(false); await b.tick(1500);
  const items = b.events.filter(event => event.type === 'media').at(-1).items;
  assert.equal(items.length, 4); assert.ok(done(b));
  assert.equal((await b.api.resolveMedia(items[0].id)).url, image.currentSrc);
  const resolved = await b.api.resolveMedia(items[3].id); assert.match(resolved.url, /secret=download/);
  const request = b.requests.find(request => request.url.includes('/files/'));
  assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.credentials, 'same-origin');
  assert.doesNotMatch(JSON.stringify(b.events.filter(event => event.type !== 'status')), /secret|blob:|https:/);
});
test('sandbox metadata resolves by actual DOM download anchor and keeps its opaque ID', async () => {
  const b = browser({ data: sse(message(['[report.pdf](sandbox:/mnt/data/report.pdf)'])), readError: true });
  b.stop(true); await b.send(); await b.tick(200);
  const original = b.events.find(event => event.type === 'media').items[0].id;
  const file = element('a', { download: 'report.pdf' }); file.href = 'https://chatgpt.com/backend-api/files/report/download';
  b.dom('report.pdf', [file]); await b.tick(200);
  const resolved = await b.api.resolveMedia(original); assert.match(resolved.url, /secret=download/);
  b.stop(false); await b.tick(1500);
  assert.equal(b.events.filter(event => event.type === 'media').at(-1).items.length, 1);
});
test('safe bounded raster data and same-page blob URLs resolve only through opaque IDs', async () => {
  for (const url of ['data:image/png;base64,aGVsbG8=', 'blob:https://chatgpt.com/local-image']) {
    const b = browser({ data: sse(message([{ type: 'image', name: 'Picture', url }]), '[DONE]') });
    await b.send(); await b.tick(200);
    const item = b.events.find(event => event.type === 'media').items[0];
    assert.equal((await b.api.resolveMedia(item.id)).url, url);
    assert.doesNotMatch(JSON.stringify(b.events), /base64|blob:/);
  }
});
test('sandbox anchors mounted after protocol completion still resolve by filename', async () => {
  const b = browser({ data: sse(message(['[late.pdf](sandbox:/mnt/data/late.pdf)']), '[DONE]') });
  await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const file = element('a', { download: 'late.pdf' }); file.href = 'https://files.oaiusercontent.com/late.pdf';
  b.dom('late.pdf', [file]);
  assert.equal((await b.api.resolveMedia(id)).url, file.href);
});
test('manual media activation clicks the scoped site sandbox link and returns metadata only', async () => {
  const b = browser({ data: sse(message(['[Download CSV](sandbox:/mnt/data/report.csv)']), '[DONE]') });
  await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const file = element('a', {}, 'Download CSV'); file.href = 'sandbox:/mnt/data/report.csv';
  let activated = 0; file.click = () => { activated++; };
  b.dom('Download CSV', [file]);
  await assert.rejects(b.api.resolveMedia(id), /View it in ChatGPT/);
  assert.equal(b.api.mediaInfo(id).name, 'Download CSV');
  assert.equal((await b.api.activateMedia(id)).kind, 'file'); assert.equal(activated, 1);
  assert.doesNotMatch(JSON.stringify(b.api.mediaInfo(id)), /url|sandbox:/);
  assert.doesNotMatch(JSON.stringify(b.events), /sandbox:/);
});
test('manual activation supports real download buttons and rejects unrelated controls', async () => {
  for (const allowed of [true, false]) {
    const b = browser({ data: sse(message([{ type: 'file', filename: 'report.csv', url: 'sandbox:/mnt/data/report.csv' }]), '[DONE]') });
    await b.send(); await b.tick(200);
    const id = b.events.find(event => event.type === 'media').items[0].id;
    const button = element('button', {}, `${allowed ? 'Download' : 'Delete'} report.csv`);
    let activated = 0; button.click = () => { activated++; };
    b.dom('report.csv', [button]);
    if (allowed) { await b.api.activateMedia(id); assert.equal(activated, 1); }
    else { await assert.rejects(b.api.activateMedia(id), /View it in ChatGPT/); assert.equal(activated, 0); }
  }
});
test('actual signed-in DIL pressable role-link activates only the matching download filename', async () => {
  const b = browser({ data: sse(message(['[Download report.csv](sandbox:/mnt/data/report.csv)']), '[DONE]') });
  await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const link = element('span', { 'data-d-component': 'pressable', role: 'link', 'aria-label': 'Open Download report.csv' }, 'Download report.csv');
  let clicks = 0; link.click = () => { clicks++; };
  b.dil('Download report.csv', [link]); await b.api.activateMedia(id); assert.equal(clicks, 1);
});
test('media coordinates mode returns a visible control center without clicking', async () => {
  const b = browser({ data: sse(message(['[Download report.csv](sandbox:/mnt/data/report.csv)']), '[DONE]') });
  await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const link = element('span', { 'data-d-component': 'pressable', role: 'link', 'aria-label': 'Open Download report.csv' }, 'Download report.csv');
  let clicks = 0, scrolls = 0;
  link.click = () => { clicks++; }; link.scrollIntoView = () => { scrolls++; };
  link.getBoundingClientRect = () => ({ left: 100, top: 200, width: 200, height: 40 });
  b.dil('Download report.csv', [link]);
  const result = await b.api.activateMedia(id, { coordinates: true });
  assert.equal(result.point.x, 200); assert.equal(result.point.y, 220); assert.equal(result.kind, 'file');
  assert.equal(clicks, 0); assert.equal(scrolls, 1);
  for (const rect of [{ left: 0, top: 0, width: 0, height: 20 }, { left: NaN, top: 0, width: 20, height: 20 }, { left: 1300, top: 0, width: 20, height: 20 }]) {
    link.getBoundingClientRect = () => rect;
    await assert.rejects(b.api.activateMedia(id, { coordinates: true }), /not visible/);
  }
  assert.equal(clicks, 0);
});
test('DOM-only DIL download pressables register generated files missed by the parsed prefix', async () => {
  for (const [name, kind] of [['report.csv', 'file'], ['picture.png', 'image'], ['speech.mp3', 'audio'], ['clip.mp4', 'video']]) {
    const b = browser({ chunks: [sse(message(['Created'])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
    await b.send(); await b.tick(100);
    const link = element('span', { 'data-d-component': 'pressable', role: 'link', 'aria-label': `Open Download ${name}` }, `Download ${name}`);
    let clicks = 0; link.click = () => { clicks++; };
    link.scrollIntoView = () => {}; link.getBoundingClientRect = () => ({ left: 100, top: 200, width: 200, height: 40 });
    b.dil(`Created Download ${name}`, [link]); await b.tick(1500);
    const items = b.events.filter(event => event.type === 'media').at(-1)?.items;
    assert.equal(items?.length, 1); assert.equal(items[0].name, name); assert.equal(items[0].kind, kind);
    const result = await b.api.activateMedia(items[0].id, { coordinates: true });
    assert.equal(result.point.x, 200); assert.equal(result.point.y, 220); assert.equal(clicks, 0);
    assert.equal(b.events.filter(event => event.type === 'media' && event.final).length, 1);
    assert.doesNotMatch(JSON.stringify(b.events.filter(event => event.type !== 'status')), /https:|sandbox:/);
  }
});
test('ordinary DIL pressable links never register attachment cards', async () => {
  const b = browser({ chunks: [sse(message(['Answer'])), sse('[DONE]')].map(text => encoder.encode(text)), chunkDelays: [0, 200] });
  await b.send(); await b.tick(100);
  const links = ['Open Reference', 'Open Download', 'Download', 'Open Downloading report.csv'].map(label =>
    element('span', { 'data-d-component': 'pressable', role: 'link', 'aria-label': label }, label));
  b.dil('Answer with references', links); await b.tick(1500);
  assert.equal(b.events.filter(event => event.type === 'media').length, 0);
});
async function downloadPreviewFixture() {
  const b = browser({ data: sse(message(['[Download report.csv](sandbox:/mnt/data/report.csv)']), '[DONE]') });
  await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const source = element('span', { 'data-d-component': 'pressable', role: 'link', 'aria-label': 'Open Download report.csv' }, 'Download report.csv');
  source.click = () => assert.fail('coordinates mode must not click source'); source.scrollIntoView = () => {};
  source.getBoundingClientRect = () => ({ left: 100, top: 200, width: 200, height: 40 });
  b.dil('Download report.csv', [source]); return { b, id };
}
test('source activation associates only the newly mounted exact file-preview download action', async () => {
  const { b, id } = await downloadPreviewFixture();
  b.previewDownload('unrelated-old.csv');
  assert.equal(b.api.mediaDownloadAction(id), null);
  await b.api.activateMedia(id, { coordinates: true });
  assert.equal(b.api.mediaDownloadAction(id), null, 'preview has not mounted');
  b.previewDownload('unrelated generic', 'Download');
  assert.equal(b.api.mediaDownloadAction(id), null, 'generic Download is never selected');
  b.previewDownload('report.csv');
  const action = b.api.mediaDownloadAction(id);
  assert.equal(action.name, 'Download report.csv'); assert.equal(action.point.x, 540); assert.equal(action.point.y, 120);
  assert.equal(b.api.mediaDownloadAction('unknown'), null);
});
test('reused preview download requires nearby matching filename and ambiguous new previews reject', async () => {
  const { b, id } = await downloadPreviewFixture();
  const reused = b.previewDownload('old.csv');
  await b.api.activateMedia(id, { coordinates: true });
  assert.equal(b.api.mediaDownloadAction(id), null);
  reused.parentElement.innerText = 'Preview report.csv';
  assert.equal(b.api.mediaDownloadAction(id).point.x, 540);
  b.previewDownload('one.csv'); b.previewDownload('two.csv');
  assert.throws(() => b.api.mediaDownloadAction(id), /More than one/);
  await b.tick(30100); assert.equal(b.api.mediaDownloadAction(id), null, 'stale activation cannot select a later preview');
});
test('manual activation excludes previous turns and unsafe links even with matching filenames', async () => {
  const b = browser({ data: sse(message([{ type: 'file', filename: 'report.csv', url: 'sandbox:/mnt/data/report.csv' }]), '[DONE]') });
  const prior = element('a', {}, 'report.csv'); prior.href = 'sandbox:/mnt/data/report.csv'; prior.click = () => assert.fail('must not click previous turn');
  b.dom('previous', [prior]); await b.send(); await b.tick(200);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  await assert.rejects(b.api.activateMedia(id), /View it in ChatGPT/);
  const unsafe = element('a', {}, 'report.csv'); unsafe.href = 'javascript:alert(1)'; unsafe.click = () => assert.fail('must not click unsafe URL');
  b.dom('report.csv', [unsafe]); await assert.rejects(b.api.activateMedia(id), /View it in ChatGPT/);
});
test('unsafe protocols, hosts and non-raster data are visible fallback files with rejected resolution', async () => {
  for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'https://127.0.0.1/a.png', 'https://evil.example/a.png', 'blob:https://evil.example/id', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const b = browser({ data: sse(message([{ type: 'file', filename: 'unsafe.svg', url }]), '[DONE]') });
    await b.send(); await b.tick(200);
    const item = b.events.find(event => event.type === 'media').items[0];
    assert.equal(item.kind, 'file'); await assert.rejects(b.api.resolveMedia(item.id), /View it in ChatGPT/);
    assert.doesNotMatch(JSON.stringify(b.events), /javascript:|file:|evil\.example|127\.0\.0\.1|base64/);
  }
});
test('attachmentInput prefers generic file input and never clicks a native picker', async () => {
  const b = browser(); b.input('image/*'); const generic = b.input();
  const selector = await b.api.attachmentInput();
  assert.match(selector, /^input\[type="file"\]\[data-qchat-file-input="qchat-file-input-/);
  assert.ok(generic.getAttribute('data-qchat-file-input')); assert.equal(b.pickerClicks, 0);
  const menu = browser(); menu.openAttachments(); assert.match(await menu.api.attachmentInput(), /qchat-file-input/); assert.equal(menu.pickerClicks, 0);
});

test('generated image galleries outside markdown expose progress and retain decorative aria-hidden preview images', async () => {
  const b = browser({data:sse(message(['Loading images...']), '[DONE]')}); b.stop(true); await b.send();
  b.gallery('Creating image 37%', [element('span',{},'Creating image 37%')]); await b.tick(300);
  assert.ok(b.events.some(e=>e.type==='image_progress'&&e.state==='generating'&&e.percentage===37));
  assert.equal(terminal(b).length,0);
  const image=element('img',{alt:'Generated image 1'}); image.src='blob:https://chatgpt.com/generated-final'; image.naturalWidth=1024;
  image.closest=selector=>selector.includes('generated-image-gallery')?{}:selector==='[aria-hidden="true"]'?{}:null;
  b.gallery('',[image]); b.stop(false); await b.tick(1500);
  const media=b.events.filter(e=>e.type==='media').at(-1);
  assert.equal(media.items.length,1);assert.equal(media.items[0].kind,'image');
  assert.equal((await b.api.resolveMedia(media.items[0].id)).url,image.src);
  assert.ok(b.events.some(e=>e.type==='image_progress'&&e.state==='complete'));
  assert.equal(terminal(b).length,1);assert.equal(terminal(b)[0].type,'done');assert.equal(terminal(b)[0].text,'');
});

test('progressive image sources update one opaque card and increment its cache revision', async () => {
  const b=browser({data:sse(message(['']), '[DONE]')}); b.stop(true); await b.send();
  const image=element('img',{alt:'Generated image'}); image.src='blob:https://chatgpt.com/preview'; image.naturalWidth=256;
  b.gallery('',[image]); await b.tick(200);
  const first=b.events.filter(e=>e.type==='media').at(-1).items[0];
  image.src='blob:https://chatgpt.com/full-resolution'; image.naturalWidth=1536; await b.tick(200);
  const final=b.events.filter(e=>e.type==='media').at(-1).items;
  assert.equal(final.length,1);assert.equal(final[0].id,first.id);assert.ok(final[0].revision>first.revision);
  assert.doesNotMatch(JSON.stringify(b.events),/blob:https/);
  b.stop(false); await b.tick(1200);
});
test('unsent failed upload blocks reuse when cleanup is unknown', async () => {
  const b = browser(); b.pending(true);
  const sent = b.send({ attachmentCount: 1 }); await b.tick(121000); await sent;
  assert.equal(terminal(b)[0]?.code, 'attachment_pending');
  await b.send({ id: 'retry' });
  assert.equal(terminal(b).at(-1)?.code, 'attachment_pending');
});
test('quiet stream emits throttled progress from incoming chunks', async () => {
  const stamps=[];
  const packets=[...Array(22).fill(': quiet\n\n'),sse(message(['final reply']), '[DONE]')];
  const b = browser({ chunks:packets.map(packet=>encoder.encode(packet)),chunkDelays:packets.map(()=>30000),emitHook:event=>{if(event.type==='progress')stamps.push({id:event.id,at:b.now})} });
  await b.send(); await b.tick(661000);
  assert.ok(stamps.length>=11&&stamps.length<=12);
  for(let i=1;i<stamps.length;i++){assert.ok(stamps[i].at-stamps[i-1].at>=60000);assert.ok(stamps[i].at-stamps[i-1].at<600000,'native liveness deadline cannot expire between genuine progress events')}
  assert.ok(b.now-stamps.at(-1).at<600000);
  assert.equal(terminal(b).length, 0);
  assert.equal(b.events.filter(event=>event.type==='delta').length,0);
  await b.tick(30000);assert.equal(done(b)?.text,'final reply');
  const count=stamps.length;await b.tick(600000);assert.equal(stamps.length,count);
  const silent=browser({hold:true});silent.stop(true);await silent.send();await silent.tick(301000);assert.equal(terminal(silent)[0]?.code,'timeout');
});
test('failed unsent uploads are removed before Retry, including delayed controls', async () => {
  for(const delay of [0,100]){
    const b=browser({data:sse(message(['once']), '[DONE]')});const input=b.input();input.files=[{name:'once.txt'}];
    const control=b.pendingAttachment('once.txt'),remove=control.click;control.click=()=>delay?b.later(remove,delay):remove();
    b.title('Just a moment');await b.send({attachmentCount:1});await b.tick(200);
    assert.equal(terminal(b)[0]?.code,'not_ready');assert.equal(b.attachmentCount,0);
    b.title('ChatGPT');assert.match(await b.api.attachmentInput(),/qchat-file-input/);
    b.pendingAttachment('once.txt');b.pending(false);const retry=b.send({id:'retry',attachmentCount:1});await b.tick(1200);await retry;
    assert.equal(b.attachmentCount,1);assert.equal(b.clicks,1);assert.equal(done(b)?.text,'once');
  }
});
test('partial or throwing cleanup refuses another upload without a retry promise', async () => {
  for(const partial of [true,false]){
    const b=browser();b.input().files=[{name:'one.txt'},{name:'two.txt'}];const control=b.pendingAttachment('one.txt');
    if(!partial)control.click=()=>{throw Error('blocked')};
    b.title('Just a moment');await b.send({attachmentCount:partial?2:1});await b.tick(200);
    assert.equal(terminal(b)[0]?.code,'attachment_pending');await assert.rejects(b.api.attachmentInput(),/attachment_pending:/);
    b.title('ChatGPT');await b.send({id:'retry'});assert.equal(b.clicks,0);assert.equal(terminal(b).at(-1)?.code,'attachment_pending');
  }
});
test('failure after request start does not remove submitted attachments',async()=>{
  const b=browser({httpError:500});b.input().files=[{name:'sent.txt'}];b.pendingAttachment('sent.txt');b.pending(false);
  const sent=b.send({attachmentCount:1});await b.tick(1200);await sent;
  assert.equal(b.clicks,1);assert.equal(b.attachmentCount,1);assert.equal(terminal(b)[0]?.type,'error');
});

test('attachment-only Send waits for processing and a quiet upload window', async () => {
  const b = browser({ data: sse(message(['uploaded']), '[DONE]') });
  b.pendingAttachment('shot.png'); const sent = b.send({ prompt: '', attachmentCount: 1 });
  await b.tick(2000); assert.equal(b.clicks, 0);
  b.pending(false); await b.tick(500); assert.equal(b.clicks, 0);
  await b.tick(600); await sent; assert.equal(b.clicks, 1); assert.equal(done(b)?.text, 'uploaded');
});

const PROMPT = 'Line one\n\n  indented “quotes” <b>&amp;</b> héllo 🌸 日本語\nlast';
const land = (b, at, { name = 'shot.png', reset = false, remount = false, settleAfter = 0 } = {}) => b.later(() => {
  b.pendingAttachment(name); if (reset) b.resetComposer(); if (remount) b.remountComposer();
  b.later(() => b.pending(false), settleAfter);
}, at);
test('delayed attachment registration never submits text alone and sends one message with the exact prompt', async () => {
  const b = browser({ data: sse(message(['ok']), '[DONE]') });
  land(b, 3000, { settleAfter: 400 });
  const sent = b.send({ prompt: PROMPT, attachmentCount: 1 });
  await b.tick(2900); assert.equal(b.clicks, 0); assert.equal(b.composerText, '');
  await b.tick(2000); await sent;
  assert.equal(b.clicks, 1); assert.deepEqual(b.submissions, [{ text: PROMPT, attachments: 1 }]); assert.equal(done(b)?.text, 'ok');
});
test('upload completion that resets or remounts the composer cannot lose the prompt', async () => {
  for (const options of [{ reset: true }, { remount: true }, { reset: true, remount: true }]) {
    const b = browser({ data: sse(message(['ok']), '[DONE]') });
    land(b, 1500, { ...options, settleAfter: 1200 });
    const sent = b.send({ prompt: PROMPT, attachmentCount: 1 });
    await b.tick(6000); await sent;
    assert.deepEqual(b.submissions, [{ text: PROMPT, attachments: 1 }], JSON.stringify(options));
  }
});
test('a composer remounted after the prompt was typed is refilled once and never submitted empty', async () => {
  const b = browser({ data: sse(message(['ok']), '[DONE]') });
  b.pendingAttachment('shot.png'); b.pending(false); b.sendDisabled(true);
  b.later(() => b.remountComposer(), 1500); b.later(() => b.sendDisabled(false), 2500);
  const sent = b.send({ prompt: PROMPT, attachmentCount: 1 });
  await b.tick(5000); await sent;
  assert.deepEqual(b.submissions, [{ text: PROMPT, attachments: 1 }]);
});
test('screenshot-only Send waits for the delayed attachment and submits once', async () => {
  const b = browser({ data: sse(message(['seen']), '[DONE]') });
  land(b, 2500, { settleAfter: 300 });
  const sent = b.send({ prompt: '', attachmentCount: 1 });
  await b.tick(2400); assert.equal(b.clicks, 0);
  await b.tick(2500); await sent;
  assert.deepEqual(b.submissions, [{ text: '', attachments: 1 }]); assert.equal(done(b)?.text, 'seen');
});
test('an attachment that never registers fails without submitting text alone', async () => {
  const b = browser();
  const sent = b.send({ prompt: PROMPT, attachmentCount: 1 }); await b.tick(121000); await sent;
  assert.equal(b.clicks, 0); assert.equal(terminal(b)[0]?.code, 'attachment_pending');
});

test('one completed upload cannot stand in for the rest of the selected files', async () => {
  const b = browser({ data: sse(message(['both']), '[DONE]') });
  b.input().files = [{ name: 'first.png' }, { name: 'second.png' }];
  await b.api.attachmentInput();
  b.pendingAttachment('first.png'); b.pending(false); await b.upload();
  land(b, 3500, { name: 'second.png', settleAfter: 300 });
  const sent = b.send({ prompt: PROMPT, attachmentCount: 2 });
  await b.tick(3000); assert.equal(b.clicks, 0); assert.equal(b.composerText, '');
  await b.tick(2500); await sent;
  assert.deepEqual(b.submissions, [{ text: PROMPT, attachments: 2 }]);
});

test('upload activity resuming while Send is disabled delays submission again', async () => {
  const b = browser({ data: sse(message(['ok']), '[DONE]') });
  b.pendingAttachment('shot.png'); b.pending(false); b.sendDisabled(true);
  b.later(() => { b.pending(true); b.resetComposer(); }, 1500);
  b.later(() => b.sendDisabled(false), 1700);
  b.later(() => b.pending(false), 3000);
  const sent = b.send({ prompt: PROMPT, attachmentCount: 1 });
  await b.tick(2900); assert.equal(b.clicks, 0);
  await b.tick(1500); await sent;
  assert.deepEqual(b.submissions, [{ text: PROMPT, attachments: 1 }]);
});

test('native pre-send cancellation removes selected files before another attachment selection', async () => {
  const b = browser(); const input = b.input(); input.files = [{ name: 'cancelled.txt' }];
  b.pendingAttachment('cancelled.txt');
  b.api.cancelAttachmentSelection(1);
  assert.match(await b.api.attachmentInput(), /qchat-file-input/);
  assert.equal(b.clicks, 0);
});

test('native pre-send cancellation blocks reuse when remove controls have not appeared', async () => {
  const b = browser(); const input = b.input(); input.files = [{ name: 'pending.txt' }];
  b.api.cancelAttachmentSelection(1);
  await assert.rejects(b.api.attachmentInput(), /cancelled attachments/);
  await b.send();
  assert.equal(b.clicks, 0); assert.equal(terminal(b).at(-1).code, 'attachment_pending');
});
test('Stop before sending removes only scoped attachment controls and prevents late Send', async () => {
  const b = browser({ data: sse(message(['next text']), '[DONE]') });
  b.pendingAttachment(); const sent = b.send({ attachmentCount: 1 });
  await b.tick(100); b.api.stop(); await b.tick(500); await sent;
  assert.equal(b.clicks, 0); assert.equal(terminal(b).length, 1);
  await b.send({ id: 'next', prompt: 'text only' }); await b.tick(200);
  assert.equal(b.clicks, 1); assert.equal(b.events.filter(event => event.type === 'done').at(-1).text, 'next text');
});
test('unrecognized attachment cleanup blocks a later text-only Send with a clear fallback', async () => {
  const b = browser(); b.pending(true); const sent = b.send({ attachmentCount: 1 });
  await b.tick(100); b.api.stop(); await b.tick(500); await sent;
  assert.equal(b.clicks, 0); assert.equal(terminal(b)[0].code, 'attachment_cancelled');
  await b.send({ id: 'next', prompt: 'text only' }); await b.tick(200);
  assert.equal(b.clicks, 0); assert.equal(terminal(b).at(-1).code, 'attachment_pending');
});
test('New chat awaits active stream cancellation and clears the media registry', async () => {
  const b = browser({ data: sse(message(['partial', { type: 'file', filename: 'old.csv', url: 'sandbox:/mnt/data/old.csv' }])), hold: true });
  b.stop(true); await b.send(); await b.tick(100);
  const id = b.events.find(event => event.type === 'media').items[0].id;
  const reset = b.api.newChat(); assert.equal(b.newChats, 0);
  await b.tick(500); await reset;
  assert.equal(b.newChats, 1); assert.equal(terminal(b).length, 1);
  assert.throws(() => b.api.mediaInfo(id), /unavailable/); assert.equal(b.cancels, 1);
  const count = b.events.filter(event => event.type !== 'status').length; b.resume(); await b.tick(300);
  assert.equal(b.events.filter(event => event.type !== 'status').length, count);
});
test('New chat during pending upload prevents submission and clears blocked attachment state', async () => {
  const b = browser({ data: sse(message(['fresh text']), '[DONE]') });
  b.pending(true); const sent = b.send({ attachmentCount: 1 }); await b.tick(100);
  const reset = b.api.newChat(); await b.tick(500); await reset; await sent;
  assert.equal(b.clicks, 0); assert.equal(b.newChats, 1);
  await b.send({ id: 'fresh', prompt: 'text only' }); await b.tick(200);
  assert.equal(b.clicks, 1); assert.equal(b.events.filter(event => event.type === 'done').at(-1).text, 'fresh text');
});
test('unavailable attachment input rejects in a bounded wait and pending uploads time out', async () => {
  const b = browser(); const selection = assert.rejects(b.api.attachmentInput(), /unavailable/); await b.tick(3200); await selection;
  b.pending(true); const sent = b.send({ attachmentCount: 1 }); await b.tick(121000); await sent;
  assert.equal(b.clicks, 0); assert.equal(terminal(b)[0]?.code, 'attachment_pending');
});

const activities = b => b.events.filter(event => event.type === 'activity');
test('SSE actual tool calls deduplicate, survive hidden reasoning, and complete on tool output', async () => {
  const call = message(['SECRET QUERY'], { id: 'search-call', channel: 'analysis', recipient: 'web.run' });
  const b = browser({ chunks: [encoder.encode(sse(call, call, message(['SECRET REASONING'], { channel: 'analysis' }))),
    encoder.encode(sse(message(['SECRET RESULTS'], { id: 'tool-result', author: { role: 'tool', name: 'web' } }), call, message(['Answer']), '[DONE]'))], chunkDelays: [0, 500] });
  await b.send(); await b.tick(200);
  assert.deepEqual(activities(b).map(event => ({ ...event })), [{ type: 'activity', id: 'job', kind: 'search', state: 'running', label: 'Searching the web' }]);
  await b.tick(600);
  assert.deepEqual(activities(b).map(event => event.state), ['running', 'complete']);
  assert.equal(done(b)?.text, 'Answer'); assert.doesNotMatch(JSON.stringify(b.events), /SECRET/);
});
test('final assistant output and terminal packets clear code activity without exposing arguments', async () => {
  for (const final of [message(['Answer']), '[DONE]']) {
    const b = browser({ data: sse(message(['SECRET CODE'], { channel: 'analysis', recipient: 'python', id: 'code-call' }), final, '[DONE]') });
    await b.send(); await b.tick(1000);
    assert.deepEqual(activities(b).map(event => [event.kind, event.state, event.label]), [['code', 'running', 'Running code'], ['code', 'complete', 'Running code']]);
    assert.doesNotMatch(JSON.stringify(b.events), /SECRET/);
    assert.ok(done(b));
  }
});
test('NDJSON supported message envelopes carry tool lifecycle and ordinary content clears activity', async () => {
  const packets = [message(['SECRET'], { id: 'browse-call', channel: 'analysis', recipient: 'web.open' }),
    message(['HIDDEN'], { id: 'reason', channel: 'analysis' }), { type: 'content', messageId: 'answer', revision: 1, markdown: 'Answer' }, { type: 'done' }];
  const b = browser({ type: 'application/x-ndjson', data: packets.map(packet => JSON.stringify(packet)).join('\n') });
  await b.send(); await b.tick(1000);
  assert.deepEqual(activities(b).map(event => [event.kind, event.state]), [['browse', 'running'], ['browse', 'complete']]);
  assert.equal(done(b)?.text, 'Answer'); assert.doesNotMatch(JSON.stringify(b.events), /SECRET|HIDDEN/);
});
test('ordinary analysis and final prose or source references never fabricate tool activity', async () => {
  const b = browser({ data: sse(message(['SECRET'], { channel: 'analysis' }), message(['Searching the web. Reading sources. Running code.'], { metadata: { content_references: [{ type: 'webpage', url: 'https://example.com', title: 'Source' }] } }), '[DONE]') });
  await b.send(); await b.tick(1000); assert.deepEqual(activities(b), []);
});
test('DOM fallback accepts exact visible current-turn statuses and ignores historical or prose nodes', async () => {
  const b = browser({ cloneError: true });
  const oldStatus = element('span', { role: 'status' }, 'Searching the web');
  const old = b.dom('', [oldStatus]); await b.send(); b.stop(true);
  await b.tick(200); assert.deepEqual(activities(b), []);
  const status = element('span', { role: 'status' }, 'Searching the web');
  b.dom('', [status]); await b.tick(300); await b.tick(200);
  assert.deepEqual(activities(b).map(event => event.state), ['running']);
  status.innerText = 'Reading sources'; await b.tick(200);
  assert.deepEqual(activities(b).map(event => [event.kind, event.state]), [['search', 'running'], ['search', 'complete'], ['browse', 'running']]);
  b.history(old); await b.tick(200);
  assert.equal(activities(b).at(-1).state, 'complete');
  b.dom('Searching the web', [element('span', {}, 'Searching the web')]); await b.tick(200);
  assert.equal(activities(b).length, 4);
  b.dom('Answer'); b.stop(false); await b.tick(1500); assert.equal(done(b)?.text, 'Answer');
});
test('known historical tool snapshots cannot start activity', async () => {
  const b = browser({ data: sse(message(['SECRET'], { id: 'old', channel: 'analysis', recipient: 'web.run' }), message(['Answer']), '[DONE]') });
  const old = b.dom('Earlier'); old.setAttribute('data-message-id', 'old');
  await b.send(); await b.tick(1000); assert.deepEqual(activities(b), []); assert.equal(done(b)?.text, 'Answer');
});
test('Stop and errors complete activity and delayed reads cannot restart it', async () => {
  for (const failure of [false, true]) {
    const b = browser({ chunks: [encoder.encode(sse(message(['SECRET'], { id: 'call', channel: 'analysis', recipient: 'web.run' }))),
      encoder.encode(sse(failure ? { error: true } : message(['LATE SECRET'], { id: 'late', channel: 'analysis', recipient: 'python' })))], chunkDelays: [0, 500], hold: true });
    await b.send(); b.stop(true); await b.tick(200);
    if (!failure) b.api.stop();
    await b.tick(1000);
    assert.deepEqual(activities(b).map(event => event.state), ['running', 'complete']);
    assert.equal(terminal(b).length, 1); assert.doesNotMatch(JSON.stringify(b.events), /SECRET/);
  }
});

test('literal tag and citation examples survive native streaming inside variable fences and inline runs', async () => {
  const text = 'Examples: ``<Entity value="literal"/> <Cite ref="unknown"/>``\n\n~~~~\n<Future-widget query={{"x":1}}/>\n~~~~';
  const b = browser({chunks:[encoder.encode(sse(message([text]), '[DONE]'))]});
  await b.send(); await b.tick(2000);
  assert.equal(terminal(b).at(-1).text, text);
});

test('citation prefixes, math, quoted code and source titles remain safe through native snapshots', async () => {
  const raw = '$x < y$ and \\(a <b\\)\n\n> ~~~\n> <Entity value="literal"/> <Cite ref="literal"/>\n> ~~~\n\nRead <Cite ref="turn1search0"/>';
  const b = browser({ data: sse(message([raw], {metadata:{content_references:[{ref_id:'turn1search0',url:'https://example.com/source',title:'A <div> title\nwith words'}]}}),'[DONE]') });
  await b.send(); await b.tick(2000);
  assert.ok(done(b)?.text.includes('$x < y$ and \\(a <b\\)'));
  assert.ok(done(b)?.text.includes('> <Entity value="literal"/> <Cite ref="literal"/>'));
  assert.ok(done(b)?.text.includes('[A &lt;div> title with words](https://example.com/source)'));
  const partial = browser({data:sse(message(['Hello <Cit']),{p:'/message/content/parts/0',o:'append',v:'e ref="turn1search0"/>'},{op:'add',path:'/message/metadata',value:{content_references:[{ref_id:'turn1search0',url:'https://example.com/source',title:'Source'}]}},'[DONE]')});
  await partial.send(); await partial.tick(2000);
  assert.equal(done(partial)?.text,'Hello [Source](https://example.com/source)');
});

test('interactive DIL source survives SSE and completion for the local interpreter', async () => {
  const raw = '{@body const [items,setItems]=DIL.useState(["Arthur Morgan"])}\n{#each items as item}<text>{item}</text>{/each}<button onClick={()=>setItems([...items,"John Marston"])}>Add</button>';
  const b = browser({data:sse(message([raw]),'[DONE]')});
  await b.send(); await b.tick(2000);
  assert.equal(done(b)?.text,raw);
  assert.ok(b.events.some(e=>e.type==='delta' && e.text===raw));
});

test('interactive NDJSON layout is preserved even alongside static fallbackMarkdown', async () => {
  const raw = '{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>setN(n+1)}>{n}</button>';
  const data = [{type:'content',messageId:'interactive',revision:1,markdown:raw,dil:{fallbackMarkdown:'0'}},{type:'done'}].map(JSON.stringify).join('\n')+'\n';
  const b = browser({data,type:'application/x-ndjson'});
  await b.send(); await b.tick(2000);
  assert.equal(done(b)?.text,raw);
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(failed ? `${failed} FAILED` : `ALL PASS (${tests.length})`);
process.exitCode = failed ? 1 : 0;
