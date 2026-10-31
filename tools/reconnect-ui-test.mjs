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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-reconnect-ui-'));
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
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
  const start = async () => {
    await open('/?mock=1&status=hold&connect=120');
    if (!await waitFor(`!document.getElementById('global-error').hidden`)) throw Error('connection deadline did not fire');
    await evalJS(`window.realNow=Date.now;window.offset=0;Date.now=()=>realNow()+offset;window.attempts=[];window.originalInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{if(c==='chat_status'||c==='chat_new'){attempts.push(c);if(window.rejectAttempt)return Promise.reject(Error('offline'));if(window.holdAttempt)return new Promise(resolve=>window.releaseAttempt=resolve);return Promise.resolve()}return originalInvoke(c,a)}`);
  };
  const ready = `__mock.emit('bridge',{type:'status',ready:true,loggedIn:false})`;
  await open('/?mock=1'); await sleep(200);
  check('normal startup has no reconnect feedback', await evalJS(`!document.getElementById('command-feedback').textContent.includes('Reconnected')`));
  await start(); await type('my draft');
  await evalJS(`window.before=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'file'}):c==='attachment_chunk'||c==='attachment_finish'?Promise.resolve({}):before(c,a);const d=new DataTransfer();d.items.add(new File(['x'],'x.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`);
  await evalJS(`window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'))`);
  check('flapping gives one attempt', await evalJS('attempts.length===1'));
  await evalJS(ready); await sleep(40);
  check('ready clears error with feedback', await evalJS(`document.getElementById('global-error').hidden&&document.getElementById('command-feedback').textContent.includes('Reconnected')`));
  check('draft and attachment preserved', await evalJS(`document.getElementById('prompt-input').value==='my draft'&&document.getElementById('attachments').textContent.includes('x.txt')`));
  check('no prompt sent', await count('chat_send')===0);
  await start(); await evalJS(`window.rejectAttempt=true;window.dispatchEvent(new Event('online'))`); await sleep(20);
  check('failed attempt retains error', await evalJS(`!document.getElementById('global-error').hidden`));
  await evalJS(`window.rejectAttempt=false;offset+=3001;window.dispatchEvent(new Event('online'))`);
  check('later attempt allowed', await evalJS('attempts.length===2'));
  await start(); await evalJS(`window.holdAttempt=true;window.dispatchEvent(new Event('online'));offset+=20000;window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('pending attempt cannot overlap', await evalJS('attempts.length===1'));
  await evalJS(`releaseAttempt();${ready}`);
  await start(); await evalJS(`window.rejectAttempt=true;window.dispatchEvent(new Event('online'))`); await sleep(20);
  await evalJS(`window.dispatchEvent(new Event('focus'));offset+=15001;window.dispatchEvent(new Event('focus'))`);
  check('focus waits 15 seconds', await evalJS('attempts.length===2'));
  await start(); await evalJS(`__mock.emit('bridge',{type:'error',code:'auth',message:'Sign in'});window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('auth stays and never opens sign in', await evalJS(`!document.getElementById('global-error').hidden&&document.getElementById('btn-error-signin').dataset.action==='signin'&&attempts.length===0&&__mock.count('show_signin')===0`));
  await open('/?mock=1'); await sleep(100);
  await evalJS(`window.originalInvoke=__TAURI__.core.invoke;window.sent=[];__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):originalInvoke(c,a)`);
  await send('failed turn'); await waitFor('sent.length===1'); await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);
  await waitFor(`document.querySelector('[data-action="retry-turn"]')`);
  await evalJS(`window.retry=document.querySelector('[data-action="retry-turn"]');__mock.emit('bridge',{type:'error',code:'offline'});window.dispatchEvent(new Event('online'))`);
  check('failed turn retry unchanged and no resend', await evalJS(`document.querySelector('[data-action="retry-turn"]')===retry&&sent.length===1`));
  await open('/?mock=1'); await sleep(100);
  await evalJS(`window.originalInvoke=__TAURI__.core.invoke;window.sent=[];window.recoveries=0;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):c==='chat_status'||c==='chat_new'?(recoveries++,Promise.resolve()):originalInvoke(c,a)`);
  await send('busy'); await waitFor('sent.length===1'); await evalJS(`__mock.emit('bridge',{type:'error',code:'offline'});window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('busy turn untouched', await evalJS(`sent.length===1&&recoveries===0&&!document.getElementById('global-error').hidden`));
  await open('/?mock=1&connect=150'); await sleep(250);
  await evalJS(`window.attempts=[];window.originalInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{if(c==='chat_status'||c==='chat_new'){attempts.push(c);return Promise.resolve()}return originalInvoke(c,a)};${ready};__mock.emit('bridge',{type:'error',code:'not_ready',message:'x'})`); await sleep(40);
  check('ready bridge can still show the retry error', await evalJS(`!document.getElementById('global-error').hidden&&document.getElementById('btn-error-signin').textContent==='Try again'`));
  await evalJS(`document.getElementById('btn-error-signin').click()`); await sleep(30);
  check('Try again shows it is working', await evalJS(`attempts.length===1&&document.getElementById('btn-error-signin').disabled&&document.getElementById('btn-error-signin').textContent.startsWith('Reconnecting')`));
  await sleep(300);
  check('attempt with no status event ends by itself', await evalJS(`!document.getElementById('btn-error-signin').disabled&&document.getElementById('btn-error-signin').textContent==='Try again'`));
  await evalJS(`document.getElementById('btn-error-signin').click()`); await sleep(30);
  check('Try again still works after a silent attempt', await evalJS('attempts.length===2'));
  check('no runtime errors', problems.length===0, problems.join(' | '));

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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-reconnect-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
