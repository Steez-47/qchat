// Isolated, off-screen runtime checks. All imported credentials are synthetic.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-signin-e2e-'));
const port = 9338;
const app = spawn(path.join(root, 'src-tauri/target/debug/qchat.exe'), [], {
  env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile },
  stdio: 'ignore', windowsHide: true,
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
let ui;
let failures = 0;
let stage = 'startup';
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error('Timed out');
}
async function cdp(url) {
  const ws = new WebSocket(url);
  const pending = new Map(); let sequence = 0;
  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const call = async (method, params = {}) => {
    const id = ++sequence;
    const result = new Promise(resolve => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method, params }));
    const data = await result;
    if (data.error) throw new Error('CDP call failed');
    return data.result;
  };
  const evaluate = async expression => {
    const data = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (data.exceptionDetails) throw new Error('Page evaluation failed');
    return data.result?.value;
  };
  const client = { call, evaluate, close: () => ws.close() };
  clients.push(client);
  return client;
}
try {
  const pages = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      return list.some(p => p.url.includes('tauri.localhost')) && list.some(p => p.url.includes('chatgpt.com')) ? list : null;
    } catch { return null; }
  }, 30000);
  ui = await cdp(pages.find(p => p.url.includes('tauri.localhost')).webSocketDebuggerUrl);
  const bridge = await cdp(pages.find(p => p.url.includes('chatgpt.com')).webSocketDebuggerUrl);
  await until(() => ui.evaluate(`!!document.getElementById('btn-browser-signin') && !!window.__TAURI__`));
  await ui.evaluate(`(() => {
    const realFetch = window.fetch;
    window.__signinTest = { calls: [], attempt: null };
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const command = url.hostname === 'ipc.localhost' || url.protocol === 'ipc:' ? decodeURIComponent(url.pathname.slice(1)) : '';
      if (command) window.__signinTest.calls.push(command);
      const response = await realFetch(input, options);
      if (command === 'begin_browser_signin' && response.ok) window.__signinTest.attempt = await response.clone().json();
      return response;
    };
    document.documentElement.classList.add('solid');
    const style = document.createElement('style');
    style.textContent = '* { animation: none !important; transition: none !important; }';
    document.head.appendChild(style);
  })()`);
  const click = id => ui.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const visible = id => ui.evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  stage = 'consent';
  check('backend rejects missing consent', await ui.evaluate(`window.__TAURI__.core.invoke('begin_browser_signin', {consent:false}).then(()=>false,()=>true)`));
  await ui.evaluate(`window.__signinTest.calls = []`);
  await click('btn-settings'); await click('btn-browser-signin');
  check('trust warning shown before import', await visible('browser-consent'));
  check('consent starts unchecked and Continue disabled', await ui.evaluate(`!document.getElementById('browser-consent-check').checked && document.getElementById('btn-consent-continue').disabled`));
  check('no import or browser opened before consent', await ui.evaluate(`!window.__signinTest.calls.some(x => ['begin_browser_signin','open_external','import_session_token'].includes(x))`));
  await ui.call('Emulation.setDeviceMetricsOverride', { width: 340, height: 620, deviceScaleFactor: 1, mobile: false });
  check('consent fits narrow popup', await ui.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.page-body').scrollWidth <= document.querySelector('.page-body').clientWidth`));
  if (process.env.QCHAT_TEST_SCREENSHOT) {
    const shot = await ui.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.QCHAT_TEST_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await ui.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`);
  check('Escape cancels consent and keeps Settings open', !await visible('browser-consent') && await visible('settings-page'));
  async function begin() {
    await ui.evaluate(`window.__signinTest.attempt = null`);
    await click('btn-browser-signin'); await click('browser-consent-check'); await click('btn-consent-continue');
    return until(() => ui.evaluate(`window.__signinTest.attempt`));
  }
  function connection(attempt) {
    const parsed = new URL(attempt.url);
    const token = parsed.hash.slice(1); parsed.hash = '';
    return { url: parsed.href, token };
  }
  const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);
  const cookies = [{ name: '__Secure-next-auth.session-token', value: 'synthetic-qchat-runtime-test', domain: '.chatgpt.com', path: '/', expirationDate: Math.floor(Date.now() / 1000) + 1800 }];
  async function post(target, payload = { cookies }, origin = extensionOrigin, token = target.token) {
    try {
      return (await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-QChat-Token': token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) })).status;
    } catch { return 0; }
  }
  stage = 'receiver protections';
  const first = connection(await begin());
  check('ChatGPT page cannot start cookie import', await bridge.evaluate(`window.__TAURI_INTERNALS__.invoke('begin_browser_signin', {consent:true}).then(()=>false,()=>true)`));
  const setup = await (await fetch(first.url)).text();
  check('setup page contains no pairing secret', !setup.includes(first.token) && /QChat/.test(setup));
  check('web origins cannot transfer cookies', await post(first, { cookies }, 'https://example.com') === 403);
  check('missing extension origin rejected', await post(first, { cookies }, '') === 403);
  const badHostStatus = await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(first.url).port) });
    let response = '';
    socket.setTimeout(2000, () => { socket.destroy(); resolve(0); });
    socket.on('error', () => resolve(0));
    socket.once('connect', () => socket.write(`GET /qchat-connect HTTP/1.1\r\nHost: localhost:${new URL(first.url).port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', data => {
      response += data.toString();
      if (response.includes('\r\n')) { const status = Number(response.split(' ')[1]); socket.destroy(); resolve(status); }
    });
  });
  check('unexpected Host rejected', badHostStatus === 403);
  check('incorrect pairing secret rejected', await post(first, { cookies }, extensionOrigin, '0'.repeat(64)) === 403);
  check('unrelated cookies rejected', await post(first, { cookies: [{ ...cookies[0], name: 'unrelated-cookie' }] }) === 400);
  const partial = net.createConnection({ host: '127.0.0.1', port: Number(new URL(first.url).port) });
  partial.on('error', () => {});
  await new Promise(resolve => partial.once('connect', resolve));
  partial.write(`POST /qchat-connect HTTP/1.1\r\nHost: 127.0.0.1:${new URL(first.url).port}\r\nOrigin: ${extensionOrigin}\r\nX-QChat-Token: ${first.token}\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{`);
  await sleep(50);
  await click('btn-browser-cancel');
  await sleep(350);
  partial.destroy();
  check('cancel invalidates pending transfer', await post(first) !== 200 && !await visible('browser-import'));
  stage = 'synthetic session transfer';
  const second = connection(await begin());
  check('single synthetic session imported', await post(second) === 200);
  await until(() => ui.evaluate(`/Session transferred/.test(document.getElementById('browser-wait').textContent)`));
  check('import alone is not reported as signed in', await ui.evaluate(`document.getElementById('signin-result').hidden || document.getElementById('signin-result-title').textContent !== 'Signed in.'`));
  const stored = (await bridge.call('Network.getCookies', { urls: ['https://chatgpt.com/'] })).cookies;
  check('synthetic cookie stored in isolated WebView profile', stored.some(c => c.name === cookies[0].name && c.value === cookies[0].value && c.httpOnly && c.secure && Math.abs(c.expires - cookies[0].expirationDate) < 2));
  check('transfer cannot be replayed', await post(second) !== 200);
  await click('btn-disconnect');
  await until(async () => !(await bridge.call('Network.getCookies', { urls: ['https://chatgpt.com/'] })).cookies.some(c => c.name.startsWith('__Secure-next-auth.session-token')));
  check('Disconnect removes the imported session', true);
} catch {
  check(`${stage} runtime check`, false);
  if (ui) console.log(await ui.evaluate(`JSON.stringify({calls:window.__signinTest?.calls,warning:!document.getElementById('browser-consent').hidden,checked:document.getElementById('browser-consent-check').checked,disabled:document.getElementById('btn-consent-continue').disabled,result:document.getElementById('signin-result-message').textContent})`).catch(() => 'State unavailable'));
} finally {
  clients.forEach(client => client.close());
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-signin-e2e-')) {
    try { rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
