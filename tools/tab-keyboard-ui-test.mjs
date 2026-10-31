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
  const chat = (key) => ({key, title:key, lastPrompt:'question', lastResponse:'answer', createdAt:Date.now(), lastActive:Date.now(), transcript:[]});
  await open('/?mock=1', {settings:{animations:'off',keepHistory:true,showTabs:true}, chats:{v:1,current:chat('current'),recent:[chat('a'),chat('b'),chat('c')]}});
  await waitFor(`document.querySelectorAll('#tabs .tab').length===3`);
  check('one tab stop', await evalJS(`document.querySelectorAll('#tabs .tab[tabindex="0"]').length===1`));
  check('labels present', await evalJS(`[...document.querySelectorAll('#tabs .tab')].every(t=>t.getAttribute('aria-label'))`));
  await evalJS(`document.querySelector('#tabs .tab').focus()`);
  await key('ArrowLeft'); check('left wraps', await evalJS(`document.activeElement.dataset.key==='c'`));
  await key('ArrowRight'); check('right wraps', await evalJS(`document.activeElement.dataset.key==='a'`));
  await key('End'); check('End', await evalJS(`document.activeElement.dataset.key==='c'`));
  await key('Home'); check('Home', await evalJS(`document.activeElement.dataset.key==='a'`));
  check('moving does not switch', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key==='current'`));
  const hides = await count('hide_main'); await key('Escape');
  check('Escape focuses composer without hiding', await evalJS(`document.activeElement.id==='prompt-input'`) && await count('hide_main')===hides);
  await evalJS(`document.querySelector('#tabs .tab').focus()`); await key('Enter');
  check('Enter activates and focuses composer', await waitFor(`JSON.parse(localStorage.getItem('qchat.chats')).current.key==='a' && document.activeElement.id==='prompt-input'`));
  check('no runtime errors', problems.length===0, problems.join(' | '));
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
