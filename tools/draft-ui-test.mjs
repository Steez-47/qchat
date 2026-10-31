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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-draft-ui-'));
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


  const stored = () => evalJS("JSON.parse(localStorage.getItem('qchat.chats')||'null')?.current?.draft");
  const reload = () => open('/', {keep:true});
  await open();
  await type('Kia ora 🌏\nsecond line'); await sleep(350);
  const height = await evalJS("document.getElementById('prompt-input').style.height");
  await reload();
  check('multiline Unicode and height reload', await inputValue()==='Kia ora 🌏\nsecond line' && await evalJS("document.getElementById('prompt-input').style.height")===height);
  await type('immediate navigation'); await reload();
  check('real reload flushes before debounce',await inputValue()==='immediate navigation');
  await type('flush now'); await evalJS("window.dispatchEvent(new Event('pagehide'))");
  check('pagehide flush', await stored()==='flush now');
  await type('blur flush'); await evalJS("window.dispatchEvent(new Event('blur'))");
  check('window blur flush',await stored()==='blur flush');
  await type('hidden flush');
  await evalJS("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden");
  check('hidden document flush',await stored()==='hidden flush');
  await evalJS("window.writes=0;window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qchat.chats')writes++;return originalSet.call(this,k,v)}");
  await type('a'); await type('ab'); await type('abc'); await sleep(350);
  check('burst coalesced', await evalJS('writes===1'));
  await type(''); await sleep(350); await reload(); check('deletion persists', await inputValue()==='');
  await type('/cop'); await sleep(350); check('known slash omitted', await stored()==='');
  await type('/usr/bin'); await sleep(350); check('literal path retained', await stored()==='/usr/bin');
  await type('sent text'); await key('Enter'); await sleep(500); await reload();
  check('sent draft stays cleared', await inputValue()==='');
  await open();
  await evalJS("window.origInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?Promise.reject(Error('test rejection')):origInvoke(c,a)");
  await send('restore me'); await sleep(500); check('rejected send restored and saved', await inputValue()==='restore me' && await stored()==='restore me');
  await open();
  await evalJS("window.origInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?new Promise((_,r)=>window.rejectSend=r):origInvoke(c,a)");
  await send('old'); await waitFor('!!window.rejectSend'); await type('new'); await type(''); await evalJS("rejectSend(Error('test'))"); await sleep(350);
  check('newer deletion prevents restoration',await inputValue()==='' && await stored()==='');
  await open('/', {settings:{keepHistory:false}}); await type('private'); await sleep(350);
  check('history disabled stores nothing', await evalJS("localStorage.getItem('qchat.chats')===null"));
  await open(); await type('pending privacy text');
  await evalJS("__mock.emit('qchat://settings-changed',{...QSettings.settings,keepHistory:false})"); await sleep(350);
  check('disabling history cancels effective persistence of pending text',await evalJS("localStorage.getItem('qchat.chats')===null"));
  await open(); await evalJS("document.querySelector('[data-suggestion]').click()"); await sleep(350);
  check('suggestion persisted', (await stored())?.startsWith('Summarize'));
  await open(); await send('/temp'); await sleep(100); await type('temporary secret'); await sleep(350);
  check('temporary draft stays private', !(await evalJS("localStorage.getItem('qchat.chats')||''")).includes('temporary secret'));
  await evalJS("__mock.emit('qchat://selection','temporary selection secret')"); await sleep(350);
  check('temporary selected text also stays private', !(await evalJS("localStorage.getItem('qchat.chats')||''")).includes('temporary selection secret'));
  await open(); await type('only a draft'); await key('n',{ctrlKey:true}); await sleep(350);
  check('draft-only new chat keeps one recoverable recent entry',await evalJS("(()=>{const recent=JSON.parse(localStorage.getItem('qchat.chats')).recent;return recent.length===1&&recent[0].draft==='only a draft';})()"));
  await evalJS("document.querySelector('#tabs .tab').click()"); await sleep(100);
  check('draft-only recent entry restores its exact text',await inputValue()==='only a draft');
  await open(); await evalJS("__mock.hold=true"); await send('recall this'); await waitFor("__mock.last('chat_send')");
  await key('ArrowUp'); await sleep(350); check('recall persists',await stored()==='recall this');
  await open(); await evalJS("__mock.hold=true"); await send('bridge failure'); await waitFor("__mock.last('chat_send')");
  await evalJS("__mock.emit('bridge',{type:'error',id:__mock.last('chat_send').args.id,code:'test'})"); await sleep(80);
  check('bridge error restores empty response',await inputValue()==='bridge failure' && await stored()==='bridge failure');
  await open(); await evalJS("__mock.hold=true"); await send('partial response'); await waitFor("__mock.last('chat_send')");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'received'});__mock.emit('bridge',{type:'error',id:__mock.last('chat_send').args.id,code:'test'})"); await sleep(80);
  check('bridge error after response does not restore',await inputValue()==='');
  await open(); await evalJS("__mock.hold=true"); await send('original'); await waitFor("__mock.last('chat_send')"); await type('new text');
  await evalJS("__mock.emit('bridge',{type:'error',id:__mock.last('chat_send').args.id,code:'test'})"); await sleep(350);
  check('bridge error preserves newer input',await inputValue()==='new text' && await stored()==='new text');
  await open(); await evalJS("__mock.hold=true"); await send('stopped before response'); await waitFor("__mock.last('chat_send')");
  await key('.',{ctrlKey:true}); await sleep(350);
  check('stopping before response restores saved draft',await inputValue()==='stopped before response'&&await stored()==='stopped before response');
  await open(); await evalJS("__mock.hold=true"); await send('stop old draft'); await waitFor("__mock.last('chat_send')");
  await type('newer edit'); await type(''); await key('.',{ctrlKey:true}); await sleep(350);
  check('stopping preserves a newer deliberate deletion',await inputValue()===''&&await stored()==='');
  await open('/', {chats:{v:1,current:chatSeed('a'),recent:[chatSeed('b')]},settings:{keepHistory:true,showTabs:true}});
  await type('draft a'); await evalJS("document.querySelector('#tabs .tab[data-key=b]').click()"); await type('draft b'); await sleep(350);
  check('pending timer follows active chat',await evalJS("(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));return s.current.key==='b'&&s.current.draft==='draft b'&&s.recent.some(c=>c.key==='a'&&c.draft==='draft a')})()"));
  await evalJS("window.writes=0;window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qchat.chats')writes++;return originalSet.call(this,k,v)}");
  await type('new switch draft'); await evalJS("document.querySelector('#tabs .tab[data-key=a]').click()"); await sleep(80);
  const switchWrites=await evalJS('writes'); await sleep(350);
  check('chat switch cancels its redundant pending write',await evalJS('writes')===switchWrites);
  await open(); await type('provider draft'); await key('k',{ctrlKey:true}); await evalJS("document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(400);
  check('provider switch retains draft after timer',await inputValue()==='provider draft' && await stored()==='provider draft');
  await open('/?failProvider',{chats:{v:1,current:{...chatSeed('fallback',{draft:'/co'}),provider:'gemini'},recent:[]}}); await sleep(350);
  check('startup provider fallback does not save a slash command',await stored()==='');
  check('no runtime errors', problems.length===0, problems.slice(0,3).join(' | '));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-draft-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;


