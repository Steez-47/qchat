// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-reading-position-ui-'));
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
  const rows = (prefix) => Array.from({ length: 30 }, (_, i) => ({
    id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user',
    text: `${prefix} message ${i} ${'long text '.repeat(15)}`
  }));
  const chat = (key, extra = {}) => {
    const transcript = rows(key);
    return { key, title: key, conversationId: `conv-${key}`, lastPrompt: transcript.at(-2).text,
      lastResponse: transcript.at(-1).text, createdAt: Date.now(), lastActive: Date.now(), transcript, ...extra };
  };
  const settings = { animations: 'off', keepHistory: true, showTabs: true, autoDismiss: 0 };
  const setup = async (a = chat('a'), b = chat('b')) => {
    await open('/?mock=1', { settings, chats: { v: 1, current: a, recent: [b] } });
    await sleep(150);
  };
  const until = async (expr, label) => {
    if (!await waitFor(expr)) throw Error(`Timed out: ${label}`);
  };

  const shortcut = () => evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'End',ctrlKey:true,bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`);
  await open('/?mock=1', { settings });
  await evalJS(`document.getElementById('prompt-input').focus()`);
  check('no reply leaves default alone', !await shortcut());
  await evalJS(`__mock.hold=true`); await send('Stream test');
  await until(`__mock.last('chat_send')`, 'send');
  const text = Array.from({length:120}, (_,i)=>`Line ${i} streaming words words words`).join('\n\n');
  const emit = value => evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(value)}})`);
  await emit(text); await until(`document.querySelector('[data-role=assistant][data-capped]')`, 'capped reply'); await sleep(300);
  const scroll = `document.querySelector('[data-role=assistant] .bubble-scroll')`;
  await until(scroll, 'reply scroller');
  const hold = () => evalJS(`(()=>{const s=${scroll};s.scrollTop=0;s.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));})()`);
  const bottom = () => evalJS(`(()=>{const s=${scroll};return s.scrollHeight-s.clientHeight-s.scrollTop<=3})()`);
  await hold(); await type('draft text'); await evalJS(`document.getElementById('prompt-input').focus();document.getElementById('prompt-input').setSelectionRange(3,3)`);
  check('mid-text caret stays native and does not jump', !await shortcut() && !await bottom());
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(10,10)`);
  const sends = await evalJS(`__mock.count('chat_send')`);
  check('caret at end jumps', await shortcut() && await bottom());
  check('draft focus and send count preserved', await evalJS(`document.activeElement.id==='prompt-input'&&document.activeElement.value==='draft text'&&__mock.count('chat_send')===${sends}`));
  await emit(text+'\n\n'+text); await sleep(400);
  check('new streaming text follows', await bottom());
  await hold(); await type(''); check('empty composer jumps', await shortcut() && await bottom());
  await evalJS(`document.getElementById('btn-history').click()`); await sleep(100);
  await evalJS(`(()=>{const p=document.getElementById('history-panel');p.scrollTop=0;p.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));document.getElementById('prompt-input').focus()})()`);
  check('history jumps and stays open', await shortcut() && await evalJS(`(()=>{const p=document.getElementById('history-panel');return !p.hidden&&p.scrollHeight-p.scrollTop-p.clientHeight<=2})()`));
  await key('f',{ctrlKey:true}); await sleep(100);
  check('find input keeps native shortcut', await evalJS(`document.activeElement.id==='find-input'`) && !await shortcut());
  await evalJS(`document.getElementById('find-close').click();document.getElementById('btn-history').click()`);
  await type('/keys'); await key('Enter'); await sleep(100);
  check('/keys lists shortcut', await evalJS(`document.querySelector('.feature-list').textContent.includes('Ctrl+End')&&document.querySelector('.feature-list').textContent.includes('Jump to latest')`));
  const fire = (extra) => evalJS(`(()=>{const e=new KeyboardEvent('keydown',${JSON.stringify({ key: 'End', ctrlKey: true, bubbles: true, cancelable: true, ...extra })});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`);
  await setup(); await type('composing'); await evalJS(`document.getElementById('prompt-input').focus();document.getElementById('prompt-input').setSelectionRange(9,9)`);
  check('IME composition leaves the shortcut alone', !await fire({ isComposing: true }) && !await fire({ keyCode: 229 }));
  check('Ctrl+Shift+End keeps native selection in the composer', !await fire({ shiftKey: true }) && await evalJS(`document.getElementById('prompt-input').value==='composing'`));
  await setup(); await type('/rename'); await key('Enter'); await until(`!document.getElementById('rename-chat').hidden`, 'rename open');
  const renameBefore = await evalJS(`document.activeElement.value`);
  check('rename input keeps native shortcut and stays open', await evalJS(`document.activeElement.tagName==='INPUT'`) && !await shortcut() && await evalJS(`!document.getElementById('rename-chat').hidden&&document.activeElement.value===${JSON.stringify(renameBefore)}`));
  await setup(); await evalJS(`document.querySelector('#tabs [data-key="b"]').focus()`);
  const tabSends = await evalJS(`__mock.count('chat_send')`);
  const currentKey = await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key`);
  await shortcut(); await sleep(80);
  check('shortcut on a focused tab does not activate it, send, or move focus', await evalJS(`document.activeElement.dataset.key==='b'&&__mock.count('chat_send')===${tabSends}&&JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(currentKey)}`));
  check('no runtime errors', problems.length===0, problems.join(' | '));
  if (failed) process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-reading-position-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
