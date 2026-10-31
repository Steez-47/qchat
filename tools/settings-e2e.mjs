// Real native settings lifecycle in an isolated, hidden debug instance. No account or OS input.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commandCount = [...readFileSync(path.join(root,'ui/app.js'),'utf8').matchAll(/\{ name: "[^"]+", icon:/g)].length;
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-settings-'));
const port = 9346;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
const visible = process.argv.includes('--visible');
let app;
async function pages() {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return []; }
}
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(100); }
  throw Error(`Timed out: ${label}`);
}
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  clients.push(ws);
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  return async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text);
    return result.result?.value;
  };
}
function check(label, ok) { if (!ok) throw Error(label); console.log(`PASS ${label}`); }
const settingsPage = async () => (await pages()).find(p => p.url.includes('tauri.localhost/settings.html'));
const slash = `(()=>{const i=document.getElementById('prompt-input');i.value='/settings';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return i.value===''})()`;
try {
  if ((await pages()).length) throw Error('Test debug port already in use');
  app = spawn(process.env.QCHAT_SURFACES_EXE || path.join(root, 'src-tauri/target-surfaces-test/debug/qchat.exe'), [], {
    env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_SETTINGS: visible ? '1' : '0' },
    stdio: 'ignore', windowsHide: true,
  });
  app.on('error', error => console.error(error.message));
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  const evaluate = await connect(main);
  await until(() => evaluate(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');
  await evaluate(`(()=>{const i=document.getElementById('prompt-input');i.value='/';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(() => evaluate(`(()=>{const menu=document.getElementById('slash-menu');const r=menu.getBoundingClientRect();return !menu.hidden && r.top>=0 && r.bottom<=innerHeight && menu.children.length===${commandCount} && [...menu.children].every(n=>{const b=n.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})})()`), 'all native slash menu rows inside window');
  check('native fitted window contains all slash commands', true);
  check('/settings consumes command', await evaluate(slash));
  const first = await until(settingsPage, 'native settings webview');
  let settings = await connect(first);
  await until(() => settings(`document.querySelectorAll('.section').length===11`), 'settings content');
  await until(() => settings(`document.visibilityState==='visible'`), 'settings shown by native window');
  check('native settings window is shown', true);
  if (visible) {
    await until(() => settings(`document.hasFocus() && screenX>=screen.availLeft && screenY>=screen.availTop && screenX+outerWidth<=screen.availLeft+screen.availWidth && screenY+outerHeight<=screen.availTop+screen.availHeight`), 'settings focused and fully inside desktop work area');
    check('settings visibly opens, gains focus and fits on desktop', true);
  }
  const acl = await settings(`(async()=>{const i=window.__TAURI__.core.invoke;const hotkey=await i('get_hotkey');await i('set_hotkey',{accelerator:hotkey});const selection=await i('get_selection_hotkey');await i('set_selection_hotkey',{accelerator:selection});await i('set_selection_clipboard',{enabled:true});const auto=await i('get_autostart');await i('set_autostart',{enabled:auto});await i('get_theme');await i('get_hotkey_available');await i('get_selection_hotkey_available');await i('chat_status');await i('reset_position');await i('show_signin');return true})()`);
  check('finding 1 real settings window hotkey selection autostart and utility ACL',acl);
  check('/settings creates real settings window and loads controls', true);
  await evaluate(`window.__TAURI__.core.invoke('open_settings')`);
  check('opening again reuses settings window', (await pages()).filter(p => p.url.includes('tauri.localhost/settings.html')).length === 1 && (await settingsPage()).id === first.id);
  await settings(`document.getElementById('btn-close').click()`);
  await until(async () => !(await settingsPage()), 'settings close');
  check('settings close destroys native window', true);
  check('/settings works after closing', await evaluate(slash));
  const reopened = await until(settingsPage, 'settings reopen');
  settings = await connect(reopened);
  await until(() => settings(`document.querySelectorAll('.section').length===11`), 'reopened controls');
  check('settings reopens with functioning controls', await settings(`!!document.getElementById('btn-close') && !!QSettings.settings`));
  await settings(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(async () => !(await settingsPage()), 'Escape close');
  check('Escape closes reopened settings', true);
  // Quit is last because it destroys the isolated test process.
  await evaluate(`window.__TAURI__.core.invoke('open_settings')`);
  const finalSettings=await connect(await until(settingsPage,'settings for quit'));
  await finalSettings(`window.__TAURI__.core.invoke('quit_app'); true`);
  await until(()=>app.exitCode!==null,'settings quit command');
  check('finding 1 real settings quit command exits isolated instance',true);
  console.log('ALL PASS');
} catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
finally {
  for (const ws of clients) ws.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  if (path.dirname(path.resolve(profile)) === path.resolve(tmpdir()) && path.basename(profile).startsWith('qchat-settings-')) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
