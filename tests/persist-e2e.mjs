// Checks that data in the app's WebView2 profile survives Quit and a restart. No windows are shown.
// Usage: node tests/persist-e2e.mjs   (needs `cargo build` first; uses the debug exe)
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.QCHAT_SURFACES_EXE || path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const port = 9338;
const marker = 'qchat_persist_test=1';
const draft = 'Unsent draft 🌏\nSecond line with Māori text.\n```js\nconst value = 42;\n```';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-persist-'));

async function pages() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const ui = list.find(p => p.url.includes('tauri.localhost'));
      const gpt = list.find(p => p.url.includes('chatgpt.com'));
      if (ui && gpt) return { ui, gpt };
    } catch {}
    await sleep(500);
  }
  throw new Error('app pages did not appear');
}
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  const reply = new Promise(r => (ws.onmessage = m => r(JSON.parse(m.data))));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const d = await Promise.race([reply, sleep(5000).then(() => ({}))]);
  ws.close();
  return d.result?.result?.value;
}
function start() {
  return spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore', windowsHide: true });
}
async function portClosed() {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json`); } catch { return true; }
    await sleep(500);
  }
  return false;
}

let app;
let ok = false;
try {
  const occupied = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  if (occupied) throw new Error('Persistence test debug port is already in use');
  app = start();
  let { ui, gpt } = await pages();
  // CDP lists a target before its initial navigation is finished. Writing then
  // can set the cookie on a document that ChatGPT immediately replaces.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate(gpt, `location.hostname==='chatgpt.com' && document.readyState==='complete' && !!window.__qchat`);
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error('ChatGPT document did not finish loading');
  const written = await evaluate(gpt, `document.cookie = "${marker}; Secure; Path=/; Max-Age=86400"; document.cookie.includes('${marker}')`);
  if (!written) throw new Error('Persistence marker was not written');
  await evaluate(ui, `QSettings.save({...QSettings.settings,defaultReasoning:'high'}); true`);
  const entered = await evaluate(ui, `(()=>{const input=document.getElementById('prompt-input');input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input',{bubbles:true}));return input.value===${JSON.stringify(draft)}})()`);
  let stored = false;
  for (let i = 0; i < 30 && !stored; i++) {
    stored = await evaluate(ui, `JSON.parse(localStorage.getItem('qchat.chats')||'null')?.current?.draft===${JSON.stringify(draft)}`);
    if (!stored) await sleep(100);
  }
  console.log(`${entered && stored ? 'PASS' : 'FAIL'} unsent draft reaches native profile storage`);
  const exited = new Promise(r => app.once('exit', r));
  evaluate(ui, `window.__TAURI__.core.invoke('quit_app')`).catch(() => {});
  await Promise.race([exited, sleep(15000)]);
  const cleanExit = app.exitCode === 0;
  console.log(`${cleanExit ? 'PASS' : 'FAIL'} Quit exits cleanly (code ${app.exitCode})`);
  const closed = await portClosed();
  console.log(`${closed ? 'PASS' : 'FAIL'} WebView2 shut down`);

  app = start();
  ({ ui, gpt } = await pages());
  let saved = '';
  for (let i = 0; i < 20 && !saved.includes(marker); i++) { saved = (await evaluate(gpt, 'document.cookie')) || ''; await sleep(500); }
  const kept = saved.includes(marker);
  console.log(`${kept ? 'PASS' : 'FAIL'} profile data survives Quit and restart`);
  const reasoningKept = await evaluate(ui, `QSettings.load().defaultReasoning==='high'`);
  console.log(`${reasoningKept ? 'PASS' : 'FAIL'} default reasoning survives Quit and restart`);
  const draftKept = await evaluate(ui, `(()=>{const input=document.getElementById('prompt-input');return input?.value===${JSON.stringify(draft)}&&input.clientHeight>parseFloat(getComputedStyle(input).lineHeight)*2})()`);
  console.log(`${draftKept ? 'PASS' : 'FAIL'} multiline Unicode draft and composer height survive Quit and restart`);
  ok = entered && stored && cleanExit && kept && reasoningKept && draftKept && closed;
} catch (e) {
  console.log('FAIL harness ::', e.message);
} finally {
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-persist-')) {
    try { rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
  }
}
console.log(ok ? 'ALL PASS' : 'FAILED');
process.exit(ok ? 0 : 1);
