// Real native settings lifecycle in an isolated, hidden debug instance. No account or OS input.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedExe = path.join(root, 'src-tauri/target-surfaces-test/debug/qchat.exe');
const testExe = process.env.QCHAT_SURFACES_EXE || path.join(root, 'src-tauri/target/debug/qchat.exe');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-surfaces-'));
const port = 9347;
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
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
}
function check(label, ok) { if (!ok) throw Error(label); console.log(`PASS ${label}`); }
const settingsPage = async () => (await pages()).find(p => p.url.includes('tauri.localhost/settings.html'));
const slash = `(()=>{const i=document.getElementById('prompt-input');i.value='/settings';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return i.value===''})()`;
try {
  if ((await pages()).length) throw Error('Test debug port already in use');
  app = spawn(testExe, [], {
    env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_SETTINGS: visible ? '1' : '0' },
    stdio: 'ignore', windowsHide: true,
  });
  app.on('error', error => console.error(error.message));
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  const evaluate = await connect(main);
  await until(() => evaluate(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');

  const before = spawnSync('reg.exe', ['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','QChat'], {encoding:'utf8',windowsHide:true});
  const result = await evaluate(`(async()=>{const i=window.__TAURI__.core.invoke;const rects=[{x:28,y:28,w:200,h:52,r:26}];const got=await i('surfaces_set',{rects});await i('surfaces_set_blur',{enabled:false,tintArgb:2569011232});await i('set_autostart',{enabled:true});const enabled=await i('get_autostart');await i('set_autostart',{enabled:false});const disabled=await i('get_autostart');const hotkey=await i('get_hotkey');let rejected=false;try{await i('set_hotkey',{accelerator:'this is invalid'})}catch(e){rejected=true}return {same:got===null || got===undefined,enabled,disabled,rejected,unchanged:hotkey===await i('get_hotkey')}})()`);
  check('surface command round trip',result.same);
  check('isolated autostart memory',result.enabled && !result.disabled);
  check('invalid shortcut preserves previous value',result.rejected && result.unchanged);
  const debug = await evaluate(`(async()=>{const i=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(name,args)=>name==='surfaces_set'||name==='surfaces_set_blur'?Promise.resolve(args?.rects):i(name,args);await i('surfaces_set_blur',{enabled:true,tintArgb:2569011232});await i('surfaces_set',{rects:[{x:28,y:28,w:200,h:52,r:26},{x:28,y:90,w:180,h:60,r:12}]});return await i('surfaces_debug')})()`);
  check('two reported surfaces', debug.rectCount === 2);
  let lastNative;
  const native = await until(async () => {
    const s = await evaluate(`window.__TAURI__.core.invoke('surfaces_debug')`);
    lastNative = s;
    return s.glassHwnd && s.mainHwnd && s.blurOk && s.glassIsBelowMain ? s : false;
  }, 'native companion initialized and directly below main').catch(error => { throw Error(`${error.message}: ${JSON.stringify(lastNative)}`); });
  check('hidden blur state coherent', native.rectCount === 2 && !native.glassVisible && !native.ignoring);
  const after = spawnSync('reg.exe', ['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','QChat'], {encoding:'utf8',windowsHide:true});
  check('registry unchanged', before.status===after.status && before.stdout===after.stdout && before.stderr===after.stderr);
  console.log('ALL PASS');
} catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
finally {
  for (const ws of clients) ws.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  if (path.dirname(path.resolve(profile)) === path.resolve(tmpdir()) && path.basename(profile).startsWith('qchat-surfaces-')) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
