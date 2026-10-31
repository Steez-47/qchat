// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-send-repeat-ui-'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, 'ui', relative));
    res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', CSP);
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const app = spawn(process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error('Headless Edge did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  ws.onclose=()=>{for(const callback of pending.values())callback({error:{message:'CDP closed'}});pending.clear()};
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},15000);
    pending.set(id, (d) => {clearTimeout(timer);d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)});
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description}`);
    return result.result.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const waitFor = async (expr, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(`!!(${expr})`)) return true; } catch {}
      await sleep(10);
    }
    return false;
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await waitFor(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(70);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const inputValue = () => evalJS(`document.getElementById('prompt-input').value`);
  const until=async(expression)=>{if(!await waitFor(expression))throw Error('Timed out: '+expression)};
  const seed=()=>({v:1,current:{key:'rename-current',provider:'chatgpt',title:'Original title',lastActive:1000,createdAt:500,lastPrompt:'Earlier question',lastResponse:'Earlier reply',draft:'Keep this draft 🌏',selectionTexts:['Quoted selection'],transcript:[{id:'u',role:'user',text:'Earlier question'},{id:'a',role:'assistant',text:'Earlier reply'}]},recent:[{key:'older',provider:'chatgpt',title:'Older chat',createdAt:200,lastActive:300,lastPrompt:'Other question',lastResponse:'Other reply'},{key:'gemini-chat',provider:'gemini',title:'Gemini chat',createdAt:100,lastActive:200,lastPrompt:'Gemini question',lastResponse:'Gemini reply'}]});
  const setup=async(settings={})=>{await open('/?mock=1',{settings:{animations:'off',autoDismiss:0,keepHistory:true,showTabs:true,...settings},chats:seed()});await until(`document.getElementById('prompt-input').value==='Keep this draft 🌏'`)};
  const state=()=>evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const command=async name=>{await key('k',{ctrlKey:true});await until(`!!document.querySelector('#slash-menu [data-command="${name}"]')`);await evalJS(`document.querySelector('#slash-menu [data-command="${name}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`)};
  const rename=async()=>{await command('rename');await until(`!document.getElementById('rename-chat').hidden`)};
  const setName=text=>evalJS(`(()=>{const input=document.getElementById('rename-chat-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const save=()=>evalJS(`document.getElementById('rename-chat').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  const nativeKey=async(value,code,virtual,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:virtual,modifiers,text:value==='Enter'?'\r':undefined});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:virtual,modifiers})};

  const boot=async(sendKey='enter')=>{await open('/?mock=1',{settings:{animations:'off',keepHistory:true,sendKey}});await evalJS('__mock.hold=true');};
  const draft=async text=>{await type(text);await until('!document.getElementById("btn-send").disabled');};
  const enter=(flags={})=>evalJS('(()=>{const input=document.getElementById("prompt-input");input.focus();const event=new KeyboardEvent("keydown",'+JSON.stringify({key:'Enter',bubbles:true,cancelable:true,...flags})+');input.dispatchEvent(event);return event.defaultPrevented;})()');
  await boot();await draft('Do not send from a held Enter');await enter({repeat:true});
  check('a held Enter alone does not submit the draft',await count('chat_send')===0&&await inputValue()==='Do not send from a held Enter');
  await boot();await draft('One deliberate Enter');await enter();await until('__mock.count("chat_send")===1');check('a fresh Enter still submits once',await count('chat_send')===1);
  await boot();await draft('Recover this draft');await enter();await until('__mock.count("chat_send")===1');await evalJS('__mock.emit("bridge",{type:"error",id:__mock.last("chat_send").args.id,code:"send_failed"})');await until('document.getElementById("prompt-input").value==="Recover this draft"&&!document.getElementById("btn-send").disabled');await enter({repeat:true});
  check('held Enter cannot automatically resend a restored failed draft',await count('chat_send')===1&&await inputValue()==='Recover this draft');
  await enter();await until('__mock.count("chat_send")===2');check('a fresh Enter retries the restored draft exactly once',await count('chat_send')===2);
  await boot('ctrl');await draft('Do not send from held Ctrl+Enter');await enter({ctrlKey:true,repeat:true});
  check('held Ctrl+Enter also preserves the draft without sending',await count('chat_send')===0&&await inputValue()==='Do not send from held Ctrl+Enter');
  await enter({metaKey:true,repeat:true});check('held Meta+Enter preserves the draft',await count('chat_send')===0&&await inputValue()==='Do not send from held Ctrl+Enter');
  await boot();await draft('Selection stays intact');await evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(2,9,'backward')})()`);await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('CDP repeated Enter preserves backward selection and text',await evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value==='Selection stays intact'&&i.selectionStart===2&&i.selectionEnd===9&&i.selectionDirection==='backward'})()`)&&await count('chat_send')===0);
  await boot();await draft('Streaming');await enter();await until('__mock.count("chat_send")===1');const streaming=await enter({repeat:true});check('repeated Enter while streaming retains default editing',!streaming&&await count('chat_send')===1);
  await boot();await draft('Allow a repeated newline');const shifted=await enter({shiftKey:true,repeat:true});check('Shift+Enter repeats keep their default newline behavior',!shifted&&await count('chat_send')===0);
  await boot('ctrl');await draft('Allow ordinary repeated Enter');const ordinary=await enter({repeat:true});check('Enter repeats in Ctrl-send mode keep default editing behavior',!ordinary&&await count('chat_send')===0);
  await boot();await draft('IME text stays local');await enter({repeat:true,isComposing:true});check('IME Enter repeats stay local',await count('chat_send')===0&&await inputValue()==='IME text stays local');
  check('send-repeat probe has no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e);
  if (problems.length) console.error('console:', problems.slice(0, 5).join(' | '));
  failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-send-repeat-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
