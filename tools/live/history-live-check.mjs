// Opt-in, read-only check of chat history against the real account. Needs QChat closed so the
// signed-in profile can be copied. Runs the debug build off screen on a disposable copy, sends
// nothing, prints only counts and shapes, and deletes the copy (it holds a session) when done.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = path.join(process.env.LOCALAPPDATA, 'com.qchat.app', 'EBWebView');
const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-history-live-'));
const port = 9377;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } throw Error(`Timed out: ${label}`); }

let app, ws;
try {
  const skip = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|BrowserMetrics.*|Service Worker|blob_storage)$/;
  cpSync(source, path.join(profile, 'EBWebView'), { recursive: true, filter: file => !skip.test(path.basename(file)) && !/^(lockfile|LOCK)$/.test(path.basename(file)) });
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: 'offscreen' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let serial = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const ev = expression => new Promise((res, rej) => { const id = ++serial; pending.set(id, m => m.result?.exceptionDetails ? rej(Error(`${m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.exception?.value || m.result.exceptionDetails.text} @ ${expression.slice(0, 60)}`)) : res(m.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');
  await ev(`window.__seen=[];window.__TAURI__.event.listen('bridge',({payload:e})=>{if(e&&e.type!=='delta')window.__seen.push(e)});window.__TAURI__.core.invoke('chat_status').catch(()=>{})`);
  await until(async () => { await ev(`window.__TAURI__.core.invoke('chat_status').catch(()=>{})`); return ev(`window.__seen.some(e=>e.type==='status'&&e.ready&&e.loggedIn)`); }, 'signed-in page ready', 90000);
  check('the copied session is signed in', true);

  // The real commands, as the UI calls them.
  await ev(`window.__TAURI__.core.invoke('chat_list_conversations',{offset:0})`);
  const list = await until(() => ev(`(()=>{const e=window.__seen.find(e=>e.type==='conversations');return e?{count:e.items.length,total:e.total,error:e.error||null,titled:e.items.filter(i=>i.title).length,timed:e.items.filter(i=>i.updated>0).length}:null;})()`), 'chat list', 30000);
  check('the account chat list comes back', list.count > 0 && !list.error, JSON.stringify(list));
  check('chats have titles and times', list.titled > 0 && list.timed === list.count);

  await ev(`window.__seen=window.__seen.filter(e=>e.type==='conversations');window.__first=window.__seen[0].items[0].id;window.__TAURI__.core.invoke('chat_read_transcript',{conversationId:window.__first})`);
  const read = await until(() => ev(`(()=>{const e=window.__seen.find(e=>e.type==='transcript');return e?{complete:!!e.complete,notOnPage:!!e.notOnPage,count:e.messages?.length??null,roles:(e.messages||[]).map(m=>m.role[0]).join('').slice(0,40),empty:(e.messages||[]).filter(m=>!m.text&&!m.hasMedia).length}:null;})()`), 'transcript', 30000);
  check('a whole conversation reads from the account record', read.complete && read.count > 0 && read.empty === 0, JSON.stringify(read));
  check('it starts with the user and includes a reply', read.roles.startsWith('u') && read.roles.includes('a'), read.roles);

  // End to end through the real UI: All chats, pick a chat that is not this PC's, see its messages.
  const ui = await ev(`(async()=>{
    const wait=async(f,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,200));}return null;};
    const before=document.querySelectorAll('.feature-choice').length;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true}));
    await wait(()=>document.querySelectorAll('.feature-choice').length>0);
    // This PC's chats come first, so the last row is one only the account knows about.
    const rows=await wait(()=>{const r=[...document.querySelectorAll('.feature-choice')];return r.length>before+20?r:null;},25000)||[...document.querySelectorAll('.feature-choice')];
    const count=rows.length;
    if(!count)return {before,count};
    rows[count-1].click();
    const panel=document.getElementById('history-panel');
    const filled=await wait(()=>!panel.hidden&&panel.querySelectorAll('.turn-row').length>0?panel:null);
    const visible=[...panel.querySelectorAll('.turn-row')].filter(r=>getComputedStyle(r).opacity==='1').length;
    return {listed:count,open:!panel.hidden,rows:panel.querySelectorAll('.turn-row').length,visible,withText:[...panel.querySelectorAll('.turn-content')].filter(n=>n.textContent.trim()).length,status:document.getElementById('history-status').hidden,loaded:!!filled};
  })()`);
  check('All chats lists the account and opening one shows its messages', ui.listed > 0 && ui.open && ui.rows > 0 && ui.visible === ui.rows && ui.withText > 0, JSON.stringify(ui));
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ws?.close();
  if (app?.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  for (let i = 0; i < 6 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(1000); }
  console.log(existsSync(profile) ? `WARNING copy not removed: ${profile}` : 'disposable profile removed');
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
