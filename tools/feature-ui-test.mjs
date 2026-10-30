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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-feature-ui-'));
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
  const section = async (label, fn) => {
    try { await fn(); } catch (e) { check(`${label} completed`, false, e.message); }
  };
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

  await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
  await key('k', { ctrlKey: true });
  check('orb menu / Ctrl+K opens command list', await evalJS(`!document.getElementById('slash-menu').hidden`));
  await key('Escape');
  await key('p', { ctrlKey: true });
  check('chat switcher empty state', await evalJS(`document.querySelector('.feature-list').textContent.includes('No chats yet')`));
  await key('Escape');
  await type('/model'); await key('Enter');
  check('model picker mock list', await waitFor(`document.querySelector('.feature-list').textContent.includes('Mock alternate')`));
  await evalJS(`[...document.querySelectorAll('.feature-choice')].find(n=>n.textContent==='Mock alternate').click()`);
  check('model choice label', await evalJS(`document.getElementById('mode-chip').textContent==='Mock alternate'`));
  await type('/keys'); await key('Enter');
  await mkdir(path.join(root,'.tmp/features'),{recursive:true});
  const keysShot = await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/features/feature-keys-reviewed.png'),Buffer.from(keysShot.data,'base64'));
  check('keyboard shortcuts overlay', await evalJS(`document.querySelector('.feature-list').textContent.includes('Ctrl+P')`));
  await key('Escape');
  await send('Recall this');
  await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`);
  check('finished reply tools', await evalJS(`!!document.querySelector('[aria-label="Retry"]')`));
  await key('ArrowUp');
  check('prompt recall', await inputValue()==='Recall this');
  check('code highlighting loaded', await evalJS(`typeof QHighlight.highlightInto==='function'`));
  await type('/temp'); await key('Enter');
  check('temporary chat navigation', await evalJS(`__mock.last('chat_new').args.temporary===true`));
  await type('/new'); await key('Enter');
  check('new clears mode label', await evalJS(`document.getElementById('mode-chip').hidden`));
  await open('/?mock=no-models', { settings: { animations: 'off', autoDismiss: 0 } });
  await type('/model'); await key('Enter');
  check('model guest fallback has sign in', await waitFor(`document.querySelector('.feature-list').textContent.includes('Sign in to choose a model')`));
  await key('Escape');
  await evalJS(`__mock.emit('qchat://shown',null)`);
  check('first-run placeholder on shown', await evalJS(`document.getElementById('prompt-input').placeholder==='Ask anything, or type / for commands'`));
  const seeded = Array.from({length:55}, (_,i)=>chatSeed('saved-'+i));
  await open('/', { chats: {v:1,current:chatSeed('current'),recent:seeded}, settings:{animations:'off',autoDismiss:0} });
  await type('draft');
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  check('chat storage caps at 50 with three visible tabs', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).recent.length===49 && document.querySelectorAll('#tabs .tab').length===3`));
  check('older chats keep metadata only', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).recent.slice(7).every(c=>c.transcript.length===0)`));
  check('tabs use natural width and no fillets', await evalJS(`getComputedStyle(document.querySelector('.tab')).flexGrow==='0' && getComputedStyle(document.querySelector('.tab-label'),'::before').display==='none'`));
  await evalJS(`__mock.emit('qchat://settings-changed', QSettings.settings)`);
  check('settings refresh requests theme', await count('get_theme')>1);
  for (const command of ['new','chats','model','temp','settings','signin','clear','keys','hide']) {
    await type('/'+command); await key('Enter'); await sleep(30); await key('Escape');
  }
  check('every menu command runs without console errors', problems.length===0);
  check('attachment chips use quiet 28px height', (await readFile(path.join(root,'ui/app.css'),'utf8')).includes('height: 28px; min-height: 28px'));
  check('README documents feature checks', (await readFile(path.join(root,'README.md'),'utf8')).includes('feature-ui-test.mjs'));
  await open('/', { chats: { v:1,current:chatSeed('current'),recent:[{...chatSeed('a'),title:'Debounce helper',lastActive:Date.now()-30*MIN},{...chatSeed('b'),title:'Trip ideas',lastActive:Date.now()-300*MIN},{...chatSeed('c'),title:'Résumé edits',lastActive:Date.now()-4320*MIN}] }, settings:{animations:'off',autoDismiss:0} });
  await cdp('Emulation.setDeviceMetricsOverride', {width:516,height:300,deviceScaleFactor:3,mobile:false});
  const tabShot = await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/features/feature-tabs-reviewed-3x.png'),Buffer.from(tabShot.data,'base64'));
  check('no runtime errors', problems.length === 0, problems.slice(0, 3).join(' | '));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-feature-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
