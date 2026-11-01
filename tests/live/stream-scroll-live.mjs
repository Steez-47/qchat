// A real ChatGPT reply in the real window, read with real wheel events: an isolated guest profile
// (no account), parked off screen, with wheel input through the webview's own input channel, so no
// OS input. Refuses to run while a fullscreen app is in front, as the window can take focus.
// `--account` (owner's consent, QChat closed) uses a disposable copy of the signed-in profile instead,
// in a ChatGPT temporary chat. It will not send unless the page confirms temporary mode, prints only
// counts, and deletes the copy.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-stream-live-'));
const port = 9383;
const account = process.argv.includes('--account');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };
const ps = body => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class W { [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f); }
'@
${body}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw Error(`Timed out: ${label}`); }

let app, ws;
try {
  const front = ps(`$h=[W]::GetForegroundWindow();$r=New-Object W+R;[void][W]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;($r.Ri-$r.L) -eq $s.Width -and ($r.B-$r.T) -eq $s.Height`).stdout.trim();
  if (front === 'True') { console.log('SKIP: a fullscreen app is in front'); process.exit(0); }
  if (account) {
    const skip = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|BrowserMetrics.*|Service Worker|blob_storage|lockfile|LOCK)$/;
    cpSync(path.join(process.env.LOCALAPPDATA, 'com.qchat.app', 'EBWebView'), path.join(profile, 'EBWebView'), { recursive: true, filter: file => !skip.test(path.basename(file)) });
  }
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: 'offscreen' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let serial = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const cdp = (method, params = {}) => new Promise(res => { const id = ++serial; pending.set(id, m => res(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expression => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r?.result?.value; };
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');
  // Room for a capped reply: fit_window is off in this mode, so size the real window directly.
  const hwnd = await until(async () => (await ev(`window.__TAURI__.core.invoke('surfaces_debug')`))?.mainHwnd, 'window handle');
  ps(`[void][W]::SetWindowPos([IntPtr]${hwnd},[IntPtr]::Zero,-20000,-20000,760,800,0x4 -bor 0x10)`);
  await until(() => ev(`innerHeight>700`), 'window resized', 10000);
  await until(() => ev(`document.getElementById('btn-send') && document.getElementById('prompt-input').placeholder!=='Connecting…'`), 'guest page ready', 90000);
  if (account) {
    await ev(`window.__seen=[];window.__TAURI__.event.listen('bridge',({payload:e})=>{if(e&&e.type!=='delta')window.__seen.push({type:e.type,url:e.url,ready:e.ready,loggedIn:e.loggedIn,first:e.items?.[0]?.id})})`);
    const poll = () => ev(`window.__TAURI__.core.invoke('chat_status').catch(()=>{})`);
    await until(async () => { await poll(); return ev(`window.__seen.some(e=>e.type==='status'&&e.ready&&e.loggedIn)`); }, 'signed-in page', 90000);
    const saved = await ev(`(()=>{const c=JSON.parse(localStorage.getItem('qchat.chats')||'null');return {tabs:document.querySelectorAll('#tabs .tab').length,recent:c?.recent?.length??0,currentMessages:c?.current?.transcript?.length??0,recentWithMessages:(c?.recent||[]).filter(x=>x.transcript?.length).length,showing:document.querySelectorAll('.bubble-zone .turn-row').length};})()`);
    check('saved chats and tabs came through on the new build', saved.recent > 0 && saved.tabs > 0, JSON.stringify(saved));
    const newestChat = async () => { await ev(`window.__seen=window.__seen.filter(e=>e.type!=='conversations');window.__TAURI__.core.invoke('chat_list_conversations',{offset:0})`); return until(() => ev(`window.__seen.find(e=>e.type==='conversations')?.first`), 'chat list', 30000); };
    const newestBefore = await newestChat();
    await ev(`(()=>{const i=document.getElementById('prompt-input');i.value='/temp';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    await sleep(2000);
    await until(async () => { await poll(); return ev(`(()=>{const e=window.__seen.filter(e=>e.type==='status').at(-1);return !!e&&e.ready&&String(e.url).includes('temporary-chat');})()`); }, 'the page confirms temporary mode', 60000);
    check('the page confirms temporary mode before anything is sent', await ev(`document.getElementById('mode-chip').textContent==='Temporary'`));
    globalThis.newestBefore = newestBefore; globalThis.newestChat = newestChat;
  }
  await ev(`window.__marks=[];(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify('Write the numbers from 1 to 150, each on its own line, with one short word after each number. Plain text, no intro.')};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  const capped = await until(() => ev(`!!document.querySelector('.bubble-zone [data-role=assistant][data-capped]')`), 'a real reply reaches its cap', 90000).catch(() => false);
  if (!capped) { check('the guest reply got long enough to scroll', false, await ev(`JSON.stringify({status:document.querySelector('[data-role=assistant]')?.dataset.status,len:document.querySelector('[data-role=assistant] .turn-content')?.textContent.length,err:document.getElementById('global-error-text')?.textContent})`)); throw Error('no capped reply'); }
  const streaming = () => ev(`document.querySelector('.bubble-zone [data-role=assistant]').dataset.status==='streaming'`);
  const state = () => ev(`(()=>{const s=document.querySelector('.bubble-scroll');return {top:s.scrollTop,gap:s.scrollHeight-s.scrollTop-s.clientHeight,height:s.scrollHeight,chip:!document.querySelector('.jump-chip').hidden,fade:['qchat-fade-0','qchat-fade-1','qchat-fade-2'].some(n=>CSS.highlights.get(n)?.size>0)};})()`);
  await sleep(500);
  const before = await state();
  check('the reply is still streaming when the reader acts', await streaming(), JSON.stringify(before));
  const box = await ev(`(()=>{const r=document.querySelector('.bubble-scroll').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  // One ordinary wheel notch.
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -100 });
  await sleep(350);
  const moved = await state();
  check('one real wheel notch moves up straight away', moved.top < before.top && moved.chip, JSON.stringify({ before: before.top, after: moved.top, chip: moved.chip }));
  await sleep(1200);
  const later = await state();
  check('new text keeps arriving without pulling the reader back', later.height >= moved.height && Math.abs(later.top - moved.top) < 3, JSON.stringify({ moved: moved.top, later: later.top, grew: later.height - moved.height, streaming: await streaming() }));
  await ev(`document.querySelector('.jump-chip').click()`);
  await sleep(400);
  const back = await state();
  check('Latest returns to following', !back.chip && back.gap < 120, JSON.stringify(back));
  const done = await until(() => ev(`document.querySelector('.bubble-zone [data-role=assistant]').dataset.status==='done'`), 'the reply finishes', 120000).catch(() => false);
  check('the reply finishes cleanly', done);
  const final = await ev(`(()=>{const c=document.querySelector('.bubble-zone .turn-content');return {markers:/\\*\\*|\`\`\`/.test(c.textContent),gap:(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight;})(),fade:CSS.highlights.has('qchat-fade-0')};})()`);
  check('no raw Markdown left, and the fade is cleared', !final.markers && !final.fade, JSON.stringify(final));
  if (account) {
    await sleep(1500);
    check('nothing was added to the account chat list', (await globalThis.newestChat()) === globalThis.newestBefore);
    check('the temporary chat was not saved on this copy', await ev(`!(localStorage.getItem('qchat.chats')||'').includes('Write the numbers from 1 to 150')`));
  }
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ws?.close();
  if (app?.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  for (let i = 0; i < 5 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(1000); }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
