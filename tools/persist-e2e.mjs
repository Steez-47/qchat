// Checks that data in the app's WebView2 profile survives Quit and a restart. No windows are shown.
// Usage: node tools/persist-e2e.mjs   (needs `cargo build` first; uses the debug exe)
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const port = 9338;
const marker = 'qchat_persist_test=1';
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
  return spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore' });
}
async function portClosed() {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/json`); } catch { return true; }
    await sleep(500);
  }
  return false;
}

let app = start();
let ok = false;
try {
  let { ui, gpt } = await pages();
  await evaluate(gpt, `document.cookie = "${marker}; Secure; Path=/; Max-Age=86400"`);
  const exited = new Promise(r => app.once('exit', r));
  evaluate(ui, `window.__TAURI__.core.invoke('quit_app')`).catch(() => {});
  await Promise.race([exited, sleep(15000)]);
  console.log(`${app.exitCode === 0 ? 'PASS' : 'FAIL'} Quit exits cleanly (code ${app.exitCode})`);
  const closed = await portClosed();
  console.log(`${closed ? 'PASS' : 'FAIL'} WebView2 shut down`);

  app = start();
  ({ gpt } = await pages());
  let saved = '';
  for (let i = 0; i < 20 && !saved.includes(marker); i++) { saved = (await evaluate(gpt, 'document.cookie')) || ''; await sleep(500); }
  const kept = saved.includes(marker);
  console.log(`${kept ? 'PASS' : 'FAIL'} profile data survives Quit and restart`);
  ok = kept && closed;
} catch (e) {
  console.log('FAIL harness ::', e.message);
} finally {
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}
}
console.log(ok ? 'ALL PASS' : 'FAILED');
process.exit(ok ? 0 : 1);
