// Real native settings lifecycle in an isolated, hidden debug instance. No account or OS input.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedExe = path.join(root, 'src-tauri/target-surfaces-test/debug/qchat.exe');
const testExe = process.env.QCHAT_SURFACES_EXE || (existsSync(isolatedExe) ? isolatedExe : path.join(root, 'src-tauri/target/debug/qchat.exe'));
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-selection-'));
const port = 9349;
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

  const result = await evaluate(`(async()=>{
    const i=window.__TAURI__.core.invoke;
    const initial=await i('get_selection_hotkey');
    let invalid=false,duplicate=false,reverse=false;
    try { await i('set_selection_hotkey',{accelerator:'invalid shortcut'}); } catch { invalid=true; }
    try { await i('set_selection_hotkey',{accelerator:await i('get_hotkey')}); } catch { duplicate=true; }
    try { await i('set_hotkey',{accelerator:initial}); } catch { reverse=true; }
    const unchanged=initial===await i('get_selection_hotkey');
    await i('set_selection_hotkey',{accelerator:''});
    const disabled=await i('get_selection_hotkey')==='';
    await i('set_selection_hotkey',{accelerator:initial});
    await i('set_selection_clipboard',{enabled:false});
    const input=document.getElementById('prompt-input'); input.value='Draft';
    await window.__TAURI__.event.emit('qchat://selection','line one\\nline two');
    await new Promise(r=>setTimeout(r,100));
    return {invalid,duplicate,reverse,unchanged,disabled,compactSelection:input.value==='Draft' && !!document.querySelector('#attachments .selection-chip') && !document.body.textContent.includes('line one'),caret:input.selectionStart===input.value.length};
  })()`);
  for (const [label,ok] of Object.entries(result)) check(label,ok);
  await evaluate(`window.__TAURI__.core.invoke('open_settings')`);
  const settings = await connect(await until(settingsPage, 'settings page'));
  await until(() => settings(`!!document.body?.textContent.includes('Ask about selection')`), 'selection controls');
  check('settings commands allowed', await settings(`(async()=>{const i=window.__TAURI__.core.invoke;const value=await i('get_selection_hotkey');return await i('set_selection_hotkey',{accelerator:value})===value})()`));
  check('clipboard preference defaults on', await settings(`QSettings.settings.selectionClipboard===true`));
  console.log('ALL PASS');
} catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
finally {
  for (const ws of clients) ws.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  if (path.dirname(path.resolve(profile)) === path.resolve(tmpdir()) && path.basename(profile).startsWith('qchat-selection-')) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}

