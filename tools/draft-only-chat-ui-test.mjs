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


  const recent = () => evalJS("JSON.parse(localStorage.getItem('qchat.chats')||'{}').recent||[]");
  const draft = '\n  Kia ora 🌏 first line\nsecond searchable line';
  await open(); await type(draft); await key('n',{ctrlKey:true}); await sleep(150);
  let rows = await recent();
  check('new archives pristine multiline draft', rows.length===1 && rows[0].draft===draft);
  check('draft title visible', await evalJS("document.querySelector('.tab-title')?.textContent.includes('Kia ora')"));
  if (rows.length) { await evalJS("document.querySelector('.tab[data-key]').click()"); await sleep(100); }
  check('tab restores exact draft', await inputValue()===draft);
  await key('n',{ctrlKey:true,shiftKey:true}); await sleep(150); await type('private secret'); await key('n',{ctrlKey:true}); await sleep(150);
  rows=await recent(); check('temporary private text excluded', !JSON.stringify(rows).includes('private secret') && rows.some(x=>x.draft===draft));
  await open('/', {keep:true}); rows=await recent(); check('reload retains draft',rows.some(x=>x.draft===draft));
  if(rows.length){await evalJS("document.querySelector('.tab[data-key]').click()"); await sleep(100);}
  check('reload tab restores exact text',await inputValue()===draft);
  await open('/', {chats:{v:1,current:chatSeed('current',{prompt:'',reply:'',transcript:[]}),recent:[chatSeed('other')]}}); await type('another draft'); await evalJS("document.querySelector('.tab[data-key]')?.click()"); await sleep(100);
  rows=await recent(); check('switch preserves draft-only current',rows.some(x=>x.draft==='another draft'));
  await open(); await type('   \n '); await key('n',{ctrlKey:true}); await sleep(100); await type('/ne'); await key('n',{ctrlKey:true}); await sleep(100);
  check('whitespace and slash prefixes ignored',(await recent()).length===0);
  await open(); const longDraft = '<img src=x onerror=alert(1)> ' + 'x'.repeat(100) + '\nneedle hidden'; await type(longDraft); await key('n',{ctrlKey:true}); await sleep(120);
  check('long draft title is compact and text only', await evalJS("document.querySelector('.tab-title').textContent.length<=24 && !document.querySelector('.tab-title img')"));
  await key('p',{ctrlKey:true}); await sleep(100); await evalJS("(()=>{let f=document.querySelector('.feature-search');f.value='needle hidden';f.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(100);
  check('search finds later draft text',await evalJS("document.querySelectorAll('.feature-list .feature-row').length===1"));
  await key('Enter'); await sleep(100); check('list restores exact draft',await inputValue()===longDraft);
  await key('n',{ctrlKey:true}); await sleep(100); await evalJS("document.querySelector('.tab[data-key]').click()"); await sleep(100); await key('n',{ctrlKey:true}); await sleep(100);
  rows=await recent(); check('repeated transitions keep one key',new Set(rows.map(x=>x.key)).size===rows.length && rows.length===1);
  await open('/',{settings:{keepHistory:false}}); await type('disabled secret'); await key('n',{ctrlKey:true}); await sleep(100);
  check('disabled history stores nothing',await evalJS("localStorage.getItem('qchat.chats')===null"));
  const until=async expression=>{if(!await waitFor(expression))throw Error('Timed out: '+expression)};
  const pickCommand=async name=>{await key('k',{ctrlKey:true});await until('!!document.getElementById("slash-'+name+'")');await evalJS('document.getElementById("slash-'+name+'").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');};
  for(const command of ['new','temp']) {
    await open();await type('Keep menu draft '+command);await pickCommand(command);await until('__mock.count("chat_new")>0');
    check(command+' menu command preserves an ordinary pristine draft',(await recent()).some(chat=>chat.draft==='Keep menu draft '+command)&&await inputValue()===''&&await count('chat_send')===0);
  }
  await open();await evalJS('__mock.emit("qchat://selection","Quote-only context stays recoverable")');await key('n',{ctrlKey:true});await sleep(100);
  check('quote-only chats are already preserved by content handling',(await recent()).some(chat=>chat.selectionTexts?.includes('Quote-only context stays recoverable')));
  await open();await type('Draft to delete');await key('n',{ctrlKey:true});await sleep(100);const clearedKey=(await recent())[0].key;await evalJS('document.querySelector("#tabs .tab").click()');await type('');await key('n',{ctrlKey:true});await sleep(100);
  check('clearing a restored pristine draft drops the abandoned empty tab',!(await recent()).some(chat=>chat.key===clearedKey));
  await open();await type('/unknown-command useful text');await key('n',{ctrlKey:true});await sleep(100);
  check('unknown slash text is still a recoverable ordinary draft',(await recent()).some(chat=>chat.draft==='/unknown-command useful text'));
  const empty={key:'empty-current',provider:'chatgpt',conversationId:null,title:'',lastActive:Date.now(),lastPrompt:'',lastResponse:'',draft:'',selectionTexts:[],transcript:[],createdAt:Date.now()};
  const capped=Array.from({length:49},(_,index)=>chatSeed('older-'+index,{ago:(index+1)*MIN}));
  await open('/',{chats:{v:1,current:empty,recent:capped}});await type('Newest recoverable draft');await key('n',{ctrlKey:true});await sleep(100);rows=await recent();
  check('draft-only entries respect the existing 49-chat history cap',rows.length===49&&rows.some(chat=>chat.draft==='Newest recoverable draft')&&!rows.some(chat=>chat.key==='older-48'));
  await open();await type('Preview must not become a permanent title');await key('n',{ctrlKey:true});await sleep(100);
  check('draft preview leaves the stored conversation title unset',(await recent())[0]?.title==='');
  await evalJS('document.querySelector("#tabs .tab").click()');await evalJS('__mock.hold=true');await send('Actual first sent prompt');await until('__mock.count("chat_send")===1');
  check('the first send replaces the display-only draft preview',await evalJS('JSON.parse(localStorage.getItem("qchat.chats")).current.title==="Actual first sent prompt"'));
  await open('/',{chats:{v:1,current:{...chatSeed('named'),title:'My custom name'},recent:[]}});await type('A different draft preview');await key('n',{ctrlKey:true});await sleep(100);
  check('an explicit conversation name takes priority over draft previews',await evalJS('document.querySelector(".tab-title").textContent==="My custom name"'));
  await open('/',{chats:{v:1,current:{...chatSeed('old-provider-chat'),provider:'chatgpt'},recent:[]}});await type('Move this composed text exactly once');await evalJS('__mock.emit("qchat://selection","Move this pending quote exactly once")');await pickCommand('gemini');await until('__mock.provider==="gemini"&&!document.getElementById("btn-reasoning").disabled');
  check('a provider change keeps the current draft and pending quote',await inputValue()==='Move this composed text exactly once'&&await evalJS('document.querySelectorAll("#attachments .selection-chip").length===1'));
  check('a provider move clears draft and pending quote from the archived transcript',(await recent()).some(chat=>chat.key==='old-provider-chat'&&!chat.draft&&!chat.selectionTexts?.length));
  await evalJS('document.querySelector(\'#tabs .tab[data-key="old-provider-chat"]\').click()');await until('__mock.provider==="chatgpt"&&!document.getElementById("btn-reasoning").disabled');
  check('returning to the old provider tab does not duplicate the moved composer',await inputValue()===''&&await evalJS('!document.querySelector("#attachments .selection-chip")')&&(await recent()).filter(chat=>chat.draft==='Move this composed text exactly once'&&chat.selectionTexts?.includes('Move this pending quote exactly once')).length===1);
  check('no provider sends',await count('chat_send')===0);
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-draft-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;


