// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-edit-prompt-ui-'));
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
  const setup = async () => {
  await open('/?mock=1', {settings:{animations:'off',keepHistory:true,showTabs:true}, chats:{v:1,current:{key:'current',createdAt:Date.now(),transcript:[]},recent:[{key:'other',title:'other',lastPrompt:'old',lastResponse:'reply',createdAt:Date.now(),lastActive:Date.now(),transcript:[]}]}});
  await evalJS(`window.sent=[];window.removed=[];window.orig=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{
    if(c==='attachment_begin')return Promise.resolve({...a,id:'retry-file'});
    if(c==='attachment_chunk'||c==='attachment_finish')return Promise.resolve({});
    if(c==='attachment_remove'){removed.push(a.id);return Promise.resolve();}
    if(c==='chat_send'){sent.push(a);return window.gone?Promise.reject(Error('Attachment is unavailable. Select it again.')):Promise.resolve();}
    return orig(c,a);
  };const d=new DataTransfer();d.items.add(new File(['x'],'x.txt'));const e=document.getElementById('attachment-input');e.files=d.files;e.dispatchEvent(new Event('change'));`);
  if(!await waitFor(`document.querySelector('#attachments [data-state=ready]')`))throw Error('stage timeout');
  };
  await setup();
  await evalJS(`document.getElementById('btn-send').click()`);await waitFor('sent.length===1');
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);await sleep(150);
  check('attachment-only failure offers Retry',await evalJS(`!!document.querySelector('[data-action="retry-turn"]')`));
  await evalJS(`const composer=document.getElementById('prompt-input');composer.value='next draft';composer.dispatchEvent(new Event('input'));window.retryButton=document.querySelector('[data-action="retry-turn"]');retryButton.click();retryButton.click()`);await sleep(200);
  check('double click sends same files once',await evalJS(`sent.length===2&&sent[1].prompt===sent[0].prompt&&JSON.stringify(sent[0].attachmentIds)===JSON.stringify(sent[1].attachmentIds)`));
  check('composer text preserved',await inputValue()==='next draft');
  await evalJS(`retryButton.click()`);await sleep(80);check('busy ignored',await evalJS('sent.length===2'));
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[1].id,code:'stream_failed'})`);await sleep(120);
  await evalJS(`window.gone=true;document.querySelector('[data-action="retry-turn"]').click()`);await sleep(150);
  check('missing file explains reattach',await evalJS(`document.body.textContent.includes('Attach it again')&&sent.length===3`));
  for(const action of ['new','clear','switch','success','auth','retry']){
    await setup();await type('same prompt');await evalJS(`document.getElementById('btn-send').click()`);await waitFor('sent.length===1');
    await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:${JSON.stringify(action==='auth'?'auth':'timeout')}})`);await sleep(100);
    if(action==='new')await evalJS(`__mock.emit('qchat://new-chat',{})`);
    if(action==='clear')await evalJS(`__mock.emit('qchat://clear-chats',{})`);
    if(action==='switch')await evalJS(`document.querySelector('.tab[data-key="other"]').click()`);
    if(action==='success'||action==='retry'){
      await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await waitFor('sent.length===2');
      check('prompt and ids preserved',await evalJS(`sent[0].prompt===sent[1].prompt&&JSON.stringify(sent[0].attachmentIds)===JSON.stringify(sent[1].attachmentIds)`));
      await evalJS(`__mock.emit('bridge',{type:'done',id:sent[1].id,text:'ok'})`);
    }
    await sleep(120);
    if(action==='auth')check('auth has no Retry',await evalJS(`!document.querySelector('[data-action="retry-turn"]')`));
    else check(action+' releases files',await evalJS(`removed.includes('retry-file')`));
  }
  await open('/?mock=1');await evalJS(`window.sent=[];window.orig=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):orig(c,a)`);await send('text only');await waitFor('sent.length===1');await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);await sleep(100);await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await waitFor('sent.length===2');check('text-only retry unchanged',await evalJS(`sent.length===2&&sent[1].prompt==='text only'&&sent[1].attachmentIds.length===0`));
  check('no runtime errors',problems.length===0,problems.join(' | '));

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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-edit-prompt-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;



