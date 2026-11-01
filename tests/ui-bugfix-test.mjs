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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-chat-undo-'));
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


  const settings = { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true };
  const seed = () => ({v:1, current:chatSeed('current',{draft:'current draft'}), recent:[chatSeed('a',{draft:'draft a'}),chatSeed('b',{draft:'draft b'}),chatSeed('c')]});
  const state = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const setup = async (data=seed(), opts=settings) => { await open('/?mock=signedin', {chats:data,settings:opts}); await sleep(150); };
  const list = async () => { await key('p',{ctrlKey:true}); await waitFor(`!document.querySelector('.feature-list').hidden`); };
  const remove = async (title) => { await evalJS(`(()=>{const row=[...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent===${JSON.stringify(title)}); if(!row)throw Error('missing row');row.querySelector('[aria-label="Remove chat"]').click()})()`); await sleep(50); };
  const undo = async () => { await evalJS(`document.querySelector('#command-feedback button').click()`); await sleep(100); };
  const clear = async () => { await key('k',{ctrlKey:true}); await evalJS(`document.querySelector('#slash-clear').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`); await waitFor(`!document.getElementById('clear-confirm').hidden`); await evalJS(`document.getElementById('btn-clear-yes').click()`); await sleep(80); };
  const visible = () => evalJS(`!document.getElementById('command-feedback').hidden`);
  await setup(); await evalJS(`__mock.hold=true`); await send('unfinished'); await sleep(100); await evalJS(`document.getElementById('btn-send').click()`); await sleep(150); let stopped=await state();
  check('empty stop removes exchange and restores metadata',stopped.current.lastPrompt==='prompt current' && !stopped.current.transcript.some(t=>t.text==='unfinished') && await inputValue()==='unfinished',JSON.stringify(stopped.current));
  await type('unfinished edit'); await key('n',{ctrlKey:true}); await sleep(200); stopped=await state();
  check('cancelled turn stays gone after later saves',!JSON.stringify([stopped.current,...stopped.recent].flatMap(c=>c.transcript||[])).includes('"unfinished"'),JSON.stringify(stopped));
  { const fresh = { v:1, current:{...chatSeed('fresh'),transcript:[],lastPrompt:'',lastResponse:'',title:''}, recent:[] }; await setup(fresh); await evalJS(`__mock.hold=true`); await send('first'); await sleep(100); await evalJS(`document.getElementById('btn-send').click()`); await sleep(150); await evalJS(`document.querySelector('#prompt-input').value=''`); await key('n',{ctrlKey:true}); await sleep(200); const after=await state(); check('empty stop on new chat leaves no recent tab',!after.recent.length && await evalJS(`!document.querySelector('#tabs [data-key]')`),JSON.stringify(after)); }
  await setup({v:1,current:{...chatSeed('empty'),transcript:[],lastPrompt:'',lastResponse:''},recent:[]}); await evalJS(`document.getElementById('prompt-input').focus()`); await type(''); const arrow=await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true});document.getElementById('prompt-input').dispatchEvent(e);return e.defaultPrevented})()`); check('empty recall leaves arrow alone',!arrow);
  await setup(); await evalJS(`__mock.hold=true`); await send('partial'); await waitFor(`__mock.last('chat_send')`); await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'received'});document.getElementById('btn-send').click()`); await sleep(100); check('stop after delta keeps turn',(await state()).current.transcript.some(t=>t.text==='partial'));
  await setup(); await send('older'); await waitFor(`document.querySelector('#btn-send').dataset.mode==='send'`); await send('first\nsecond'); await waitFor(`document.querySelector('#btn-send').dataset.mode==='send'`); await evalJS(`document.getElementById('prompt-input').focus()`); await key('ArrowUp'); const multi=await evalJS(`(()=>{const i=document.getElementById('prompt-input');i.setSelectionRange(1,1);const e=new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true});i.dispatchEvent(e);return !e.defaultPrevented&&i.value==='first\\nsecond'})()`); check('recalled multiline retains native caret navigation',multi); await evalJS(`document.getElementById('prompt-input').setSelectionRange(0,0)`); await key('ArrowUp'); check('recall steps to older prompt',await inputValue()==='older'); await key('ArrowDown'); check('single-line recall steps to newer prompt',await inputValue()==='first\nsecond');
  await setup(); await evalJS(`document.getElementById('btn-history').click()`); const rectBefore=await evalJS(`(()=>{const r=document.querySelector('#history-panel .history-row[data-role=user]').getBoundingClientRect();return {left:r.left,right:r.right}})()`); await list(); const rectAfter=await evalJS(`(()=>{const r=document.querySelector('#history-panel .history-row[data-role=user]').getBoundingClientRect();return {left:r.left,right:r.right}})()`); console.log('INFO bubble bounds at 516px',JSON.stringify({rectBefore,rectAfter}));
  const empty=seed(); empty.current={...chatSeed('empty',{conv:'empty-conv',prompt:'',reply:'',transcript:[]}),transcript:[]}; await setup(empty); await evalJS(`document.getElementById('btn-history').click();__mock.emit('bridge',{type:'transcript',conversationId:'empty-conv',messages:[{role:'user',text:'old prompt'},{role:'assistant',text:'page reply'}]})`); await sleep(100); await evalJS(`document.getElementById('btn-history').click()`); await sleep(100); check('page fallback shows and saves latest reply',await evalJS(`document.querySelector('#bubble-zone').textContent.includes('page reply')`) && (await state()).current.lastResponse==='page reply');
  const media=seed(); media.current.transcript[1].text='[file](sandbox:/mnt/data/file.txt)'; await setup(media); await evalJS(`document.getElementById('btn-history').click()`); await sleep(80); const beforeMedia=await count('show_signin'); await evalJS(`(()=>{const b=document.createElement('button');b.dataset.action='view-media';document.querySelector('#history-panel .history-row').append(b);b.click()})()`); await sleep(80); check('history media link opens provider',await count('show_signin')>beforeMedia);
  await setup(); await evalJS(`window.origInvoke=__TAURI__.core.invoke; __TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'f1'}):c==='attachment_chunk'||c==='attachment_finish'?Promise.resolve({id:'f1'}):c==='chat_send'?Promise.reject(Error('failed')):origInvoke(c,a); const d=new DataTransfer();d.items.add(new File(['x'],'x.txt',{type:'text/plain'}));document.getElementById('attachment-input').files=d.files;document.getElementById('attachment-input').dispatchEvent(new Event('change'))`); await waitFor(`document.querySelector('#attachments [data-state=ready]')`); await send('with attachment'); await sleep(200); check('attachment failure offers retained-file retry',await evalJS(`!!document.querySelector('[data-action="retry-turn"]')`));
  await open('/settings.html?mock=signedin'); await sleep(150); const title=await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='text';s.dispatchEvent(new Event('input'));const section=document.getElementById('section-text');return [...section.querySelectorAll('.row,.action-row,.preset-entry,.look-swatch')].every(r=>!r.hidden)})()`); check('section title shows all rows',title); const filter=await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='font';s.dispatchEvent(new Event('input'));const rows=[...document.querySelectorAll('#section-text .row')];return rows.some(r=>r.hidden)&&rows.some(r=>!r.hidden)})()`);check('non-title search filters rows',filter);
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-chat-undo-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;



