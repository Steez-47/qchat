// Synthetic bridge checks only: no app, browser profile, credentials, or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/bridge/chatgpt-bridge.js', import.meta.url), 'utf8');
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (body, ok = true) => ({ ok, json: async () => body });

function browser({ ready = false, focused = true, composer = 'legacy', hidden = false, prepareBeforeSend = false } = {}) {
  let now = 0, nextTimer = 0, sendClicks = 0;
  const timers = new Map(), requests = [], events = [], replies = [];
  const location = { hostname: 'chatgpt.com', href: 'https://chatgpt.com/', pathname: '/' };
  const composerSelector = composer === 'semantic' ? 'form .ProseMirror[contenteditable="true"][role="textbox"]'
    : composer === 'unrelated' ? '[contenteditable="true"]' : '#prompt-textarea';
  const editable = { closest: () => null, getClientRects: () => hidden ? [] : [{}], focus() {} };
  const sendButton = { disabled: false, getAttribute: () => null, click() {
    sendClicks++;
    window.fetch('/backend-api/f/conversation', { method: 'POST' });
  } };
  const document = {
    title: 'ChatGPT', visibilityState: 'visible', hasFocus: () => focused,
    querySelector: selector => ready && selector === composerSelector ? editable
      : prepareBeforeSend && now >= 120 && selector === '[data-testid="send-button"]' ? sendButton : null,
    querySelectorAll: selector => ready && selector === composerSelector ? [editable] : [],
    execCommand(command) {
      if (prepareBeforeSend && command === 'insertText') window.fetch('/backend-api/f/conversation/prepare', { method: 'POST' });
      return true;
    }
  };
  const schedule = (fn, delay, interval = 0) => {
    const id = ++nextTimer; timers.set(id, { fn, at: now + delay, interval }); return id;
  };
  const window = {
    __QCHAT_EMIT__: event => events.push(event),
    fetch: (url, options) => {
      requests.push({ url, options });
      if (prepareBeforeSend && url.endsWith('/prepare')) return Promise.resolve({ ok: true });
      if (prepareBeforeSend && url === '/backend-api/f/conversation') {
        let part = 0;
        const encode = packet => new TextEncoder().encode(`data: ${JSON.stringify(packet)}\n\n`);
        const reader = {
          async read() {
            if (part++ === 0) return { value: encode({ v: { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['synthetic'] } } } }), done: false };
            return new Promise(resolve => schedule(() => resolve({ value: new TextEncoder().encode(
              `data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: ' answer' })}\n\ndata: [DONE]\n\n`
            ), done: false }), 100));
          },
          async cancel() {}
        };
        const stream = { ok: true, headers: { get: () => 'text/event-stream' }, body: { getReader: () => reader }, clone() { return this; } };
        return Promise.resolve(stream);
      }
      const reply = replies.shift();
      assert.ok(reply, 'Unexpected session request');
      return reply(options);
    }
  };
  window.top = window;
  const context = vm.createContext({
    window, document, location, URL, AbortController, console, TextDecoder,
    MutationObserver: class { observe() {} disconnect() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  return {
    requests, events, document,
    reply(body, ok = true) { replies.push(async () => response(body, ok)); },
    fail() { replies.push(async () => { throw new Error('Offline'); }); },
    hang() { replies.push(() => new Promise(() => {})); },
    defer() {
      let resolve;
      replies.push(() => new Promise(r => { resolve = r; }));
      return body => resolve(response(body));
    },
    status: () => window.__qchat.status(),
    send: () => window.__qchat.send({ id: 'synthetic-job', prompt: 'synthetic prompt' }),
    sendClicks: () => sendClicks,
    last: () => events.filter(event => event.type === 'status').at(-1),
    navigate(path) { location.pathname = path; location.href = `https://chatgpt.com${path}`; },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due; now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn(); await drain();
      }
      now = end; await drain();
    }
  };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('authenticated session uses bounded uncached same-origin request and emits no session data', async () => {
  const b = browser(); b.reply({ user: { name: 'synthetic-user' }, accessToken: 'synthetic-token' });
  await b.status();
  assert.equal(b.last().loggedIn, true); assert.equal(b.last().ready, false); assert.equal(b.last().authPending, false);
  assert.equal(b.requests[0].url, '/api/auth/session');
  assert.equal(b.requests[0].options.credentials, 'same-origin'); assert.equal(b.requests[0].options.cache, 'no-store');
  assert.ok(b.requests[0].options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(b.events), /synthetic-user|synthetic-token/);
});

test('successful empty session is signed out even with a composer', async () => {
  const b = browser({ ready: true }); b.reply({}); await b.status();
  assert.equal(b.last().loggedIn, false); assert.equal(b.last().ready, true); assert.equal(b.last().authPending, false);
});

test('composer readiness supports guest and signed-in markup, excluding hidden or unrelated editables', async () => {
  for (const [options, expected] of [
    [{ ready: true }, true],
    [{ ready: true, composer: 'semantic' }, true],
    [{ ready: true, composer: 'semantic', hidden: true }, false],
    [{ ready: true, composer: 'unrelated' }, false],
    [{ ready: false }, false]
  ]) {
    const b = browser(options); b.reply({}); await b.status();
    assert.equal(b.last().ready, expected, JSON.stringify(options));
    assert.equal(b.last().loggedIn, false, 'DOM readiness must never imply login');
  }
});

test('concurrent calls share a request and cooldown prevents a storm', async () => {
  const b = browser(); const resolve = b.defer();
  const checks = Array.from({ length: 20 }, () => b.status());
  assert.equal(b.requests.length, 1); resolve({}); await Promise.all(checks);
  await Promise.all(Array.from({ length: 20 }, () => b.status())); await b.tick(4500);
  assert.equal(b.requests.length, 1);
});

test('timeout aborts the request, preserves known login, and ignores a late guest result', async () => {
  const b = browser(); b.reply({ user: {} }); await b.status();
  const resolve = b.defer(); await b.tick(5000); await b.tick(8000);
  assert.equal(b.requests[1].options.signal.aborted, true);
  assert.equal(b.last().loggedIn, true); assert.equal(b.last().authPending, true);
  resolve({}); await drain(); assert.equal(b.last().loggedIn, true);
  b.reply({ user: {} }); await b.tick(5000);
  assert.equal(b.last().authPending, false); assert.equal(b.last().loggedIn, true);
});

test('network and HTTP failures preserve known login', async () => {
  const b = browser(); b.reply({ accessToken: 'synthetic-token' }); await b.status();
  b.fail(); await b.tick(5000); assert.equal(b.last().loggedIn, true); assert.equal(b.last().authPending, true);
  b.reply({}, false); await b.tick(5000); assert.equal(b.last().loggedIn, true); assert.equal(b.last().authPending, true);
});

test('failed initial session eventually retries with unchanged URL and composer', async () => {
  const b = browser(); b.fail(); await b.status();
  assert.equal(b.last().authPending, true);
  b.reply({ user: {} }); await b.tick(5000);
  assert.equal(b.requests.length, 2); assert.equal(b.last().loggedIn, true); assert.equal(b.last().ready, false);
});

test('a sign-in route change refreshes a cached guest session within cooldown', async () => {
  const b = browser({ ready: true }); b.reply({}); await b.status();
  b.navigate('/auth/login'); await b.tick(500); assert.equal(b.requests.length, 1);
  b.reply({ user: {} }); await b.tick(4500);
  assert.equal(b.requests.length, 2); assert.equal(b.last().loggedIn, true);
});

test('ready guest and background pages use slower polling', async () => {
  const guest = browser({ ready: true }); guest.reply({}); await guest.status();
  await guest.tick(29500); assert.equal(guest.requests.length, 1);
  guest.reply({}); await guest.tick(500); assert.equal(guest.requests.length, 2);
  const background = browser({ focused: false, ready: true }); background.reply({}); await background.status();
  await background.tick(59500); assert.equal(background.requests.length, 1);
  background.reply({}); await background.tick(500); assert.equal(background.requests.length, 2);
});

test('an unfocused loading page retries an unavailable session promptly', async () => {
  const b = browser({ focused: false }); b.fail(); await b.status();
  b.reply({ user: {} }); await b.tick(5000);
  assert.equal(b.requests.length, 2);
  assert.equal(b.last().loggedIn, true);
  assert.equal(b.last().authPending, false);
});

test('prepare before Send enables does not start a turn or prevent the actual send and stream', async () => {
  const b = browser({ ready: true, composer: 'semantic', prepareBeforeSend: true });
  const sent = b.send();
  assert.equal(b.requests.filter(request => request.url.endsWith('/prepare')).length, 1);
  assert.equal(b.events.filter(event => event.type === 'start').length, 0, 'prepare is not an actual send');
  await b.tick(100);
  assert.equal(b.sendClicks(), 0, 'button is still rendering');
  assert.equal(b.events.filter(event => event.type === 'start').length, 0);
  await b.tick(300); await sent;
  assert.equal(b.sendClicks(), 1);
  assert.equal(b.requests.filter(request => request.url === '/backend-api/f/conversation').length, 1);
  assert.deepEqual(b.events.filter(event => event.type !== 'status').map(event => event.type), ['start', 'delta', 'delta', 'done']);
  assert.deepEqual(b.events.filter(event => event.type === 'delta').map(event => event.text), ['synthetic', 'synthetic answer']);
  assert.equal(b.events.at(-1).text, 'synthetic answer');
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(failed ? `${failed} FAILED` : `ALL PASS (${tests.length})`);
process.exitCode = failed ? 1 : 0;
