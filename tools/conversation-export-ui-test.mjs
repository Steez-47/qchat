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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-conversation-copy-'));
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
  const MIN = 60 * 1000;
  const chatSeed = (key, { conv = null, prompt = `prompt ${key}`, reply = `reply ${key}`, ago = MIN, draft = "", transcript } = {}) => ({
    key,
    conversationId: conv,
    title: key,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft,
    transcript: transcript || [
      { id: `${key}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${key}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago
  });


  const runExport = async () => { await type('/export'); await key('Enter'); await sleep(50); };
  const paletteExport = async () => { await key('k',{ctrlKey:true}); await evalJS("document.querySelector('#slash-export').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(50); };
  const transcript = [
    {id:'u',role:'user',text:'Kia ora 🌏',selectionTexts:['quoted\nselection']},
    {id:'a',role:'assistant',text:'```js\nconst x = "é";\n```\nciteturn0search0',sources:[{id:'turn0search0',url:'https://example.com/',title:'Source'}]},
    {id:'f',role:'user',text:'',hadAttachments:true},
    {id:'m',role:'assistant',text:'',media:[{file:'file-test-id',name:'report.csv'}]}
  ];
  await open('/',{chats:{v:1,current:chatSeed('export',{transcript}),recent:[]},settings:{animations:'off',autoDismiss:0}});
  await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>window.copied=t}})");
  await type('/copy'); await key('Enter'); await sleep(50);
  await evalJS(`__mock.emit('qchat://selection','draft selection');(()=>{const d=new DataTransfer();d.items.add(new File(['private bytes'],'keep.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))})()`); await waitFor("document.querySelector('#attachments .selection-chip') && document.getElementById('attachments').textContent.includes('keep.txt')");
  await type('unsent draft'); await evalJS("(()=>{let i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(2,5)})()");
  await paletteExport();
  check('copy parity and draft excluded',await evalJS("__mock.last('conversation_export').args.markdown===window.copied&&!window.copied.includes('unsent draft')&&window.copied.includes('🌏')&&window.copied.includes('quoted')&&window.copied.includes('const x')&&window.copied.includes('[Attachment]')"));
  check('citation and media name preserved',await evalJS("window.copied.includes('https://example.com/') && window.copied.includes('report.csv')"));
  check('draft and selection preserved',await evalJS("(()=>{let i=document.getElementById('prompt-input');return i.value==='unsent draft'&&i.selectionStart===2&&i.selectionEnd===5})()"));
  check('files and selection preserved',await evalJS("document.querySelector('#attachments .selection-chip') && document.getElementById('attachments').textContent.includes('keep.txt') && !__mock.last('conversation_export').args.markdown.includes('private bytes')"));
  check('success feedback',await evalJS("document.getElementById('command-feedback').textContent.includes('to Downloads')"));
  await open('/',{settings:{animations:'off',autoDismiss:0}}); await runExport();
  check('empty skips native',await evalJS("__mock.count('conversation_export')===0&&document.getElementById('command-feedback').textContent.includes('No messages')"));
  await open('/',{chats:{v:1,current:chatSeed('async'),recent:[chatSeed('other')]},settings:{animations:'off',autoDismiss:0}});
  await evalJS('__mock.exportError=true'); await runExport();
  check('error feedback',await evalJS(`document.getElementById("command-feedback").textContent.includes("Couldn't save")`));
  await evalJS('__mock.exportError=false; __mock.exportHold=true'); await runExport(); await runExport();
  check('pending prevents duplicate',await evalJS("__mock.count('conversation_export')===2"));
  await evalJS("document.querySelector('#tabs [data-key=other]').click(); __mock.releaseExport()"); await sleep(80);
  check('switch suppresses stale feedback',await evalJS("document.getElementById('command-feedback').hidden"));
  await evalJS('__mock.exportHold=false'); await runExport();
  check('retry succeeds',await evalJS("__mock.count('conversation_export')===3&&document.getElementById('command-feedback').textContent.includes('Saved')"));
  for (const mode of ['temporary','history-disabled']) {
    await open('/',{settings:{animations:'off',autoDismiss:0,keepHistory:mode!=='history-disabled',streamStyle:'paragraph'}});
    if (mode==='temporary') { await type('/temp'); await key('Enter'); await sleep(100); }
    await evalJS('__mock.hold=true'); await send('private question'); await waitFor("__mock.count('chat_send')===1");
    await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'```js\nconst received = 42;'})"); await sleep(50);
    await runExport();
    check(mode+' exports streaming snapshot',await evalJS("__mock.last('conversation_export').args.markdown.includes('const received = 42;')"));
    check(mode+' keeps storage private',await evalJS("!String(localStorage.getItem('qchat.chats')).includes('private question')"));
  }
  check('no runtime errors',problems.length===0,problems.slice(0,3).join(' | '));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-conversation-copy-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;



