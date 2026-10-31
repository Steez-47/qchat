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



  const settings = { animations:'off', autoDismiss:0, keepHistory:true, showTabs:true };
  const user = (id,text,extra={}) => ({id,role:'user',text,...extra});
  const assistant = (id,text) => ({id,role:'assistant',text});
  const older = 'older';
  const newest = 'Kia ora 🌏\nsecond line';
  const seed = (transcript, extra={}) => ({v:1,current:{...chatSeed('current',{prompt:'fallback',reply:'answer',transcript}),transcript,...extra},recent:[]});
  const setup = async data => { await open('/?mock=signedin',{chats:data,settings}); await sleep(180); };
  const press = async k => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();const e=new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true});i.dispatchEvent(e);return e.defaultPrevented})()`);
  const value = inputValue;
  const state = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current`);
  const history = () => evalJS(`document.getElementById('btn-history').click()`);
  const feedback = () => evalJS(`document.getElementById('command-feedback').hidden?'':document.getElementById('command-feedback').textContent`);
  const data=seed([user('old',older),assistant('a','answer'),user('new',newest,{selectionTexts:['selected','selected']}),assistant('b','answer')]);
  await setup(data);
  await press('ArrowUp'); check('reload recall newest',await value()===newest);
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(0,0)`); await press('ArrowUp'); check('reload recall older',await value()===older);
  await press('ArrowDown'); check('recall newer',await value()===newest);
  await evalJS(`(()=>{const i=document.getElementById('prompt-input');i.setSelectionRange(i.value.length,i.value.length)})()`); await press('ArrowDown'); check('recall returns empty',await value()==='');
  await setup(seed([],{lastPrompt:'fallback only'})); await press('ArrowUp'); check('lastPrompt fallback',await value()==='fallback only');
  await setup(seed([],{lastPrompt:'',lastResponse:''})); await evalJS(`window.writes=0;const old=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qchat.chats')writes++;return old.call(this,k,v)}`); const prevented=await press('ArrowUp'); await sleep(350); check('empty recall leaves arrow and draft alone',!prevented && await value()==='' && await evalJS('writes===0'));
  await setup(data); await history();
  check('history user edit button and assistant none',await evalJS(`!!document.querySelector('#history-panel [data-id="new"] button[data-action="edit-prompt"][aria-label="Edit in composer"][title="Edit in composer"]') && !document.querySelector('#history-panel [data-role="assistant"] [data-action="edit-prompt"]')`));
  await evalJS(`document.querySelector('#history-panel [data-id="new"] [data-action="copy-user"]').focus()`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check('edit button reachable by Tab',await evalJS(`document.activeElement?.dataset.action==='edit-prompt'`));
  const before=await count('chat_send');
  await evalJS(`document.querySelector('#history-panel [data-id="new"] [data-action="edit-prompt"]').click()`); await sleep(350);
  check('loads multiline Unicode and focus with caret at end',await evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value===${JSON.stringify(newest)} && document.activeElement===i && i.selectionStart===i.value.length && i.selectionEnd===i.value.length})()`));
  let current=await state(); check('selection deduplicated and draft saved',current.draft===newest && JSON.stringify(current.selectionTexts)===JSON.stringify(['selected']),JSON.stringify(current));
  check('editing sends nothing',await count('chat_send')===before);
  await evalJS(`document.querySelector('#history-panel [data-id="new"] [data-action="edit-prompt"]').click()`); await sleep(300); current=await state(); check('identical text has no notice and no duplicate selection',!(await feedback()) && current.selectionTexts.length===1);
  await type('my unsent draft'); await evalJS(`window.insertCalls=0;window.realExec=document.execCommand.bind(document);document.execCommand=function(...args){if(args[0]==='insertText')insertCalls++;return realExec(...args)}`);
  await evalJS(`document.querySelector('#history-panel [data-id="old"] [data-action="edit-prompt"]').click()`);
  check('replacement notice', (await feedback()).includes('Replaced draft, Ctrl+Z restores it'));
  const undo=await evalJS(`(()=>{document.execCommand('undo');return document.getElementById('prompt-input').value})()`);
  check('native undo restores draft or insertText path ran',undo==='my unsent draft' || await evalJS('insertCalls>0'));
  await setup(seed([user('media','with file',{hadAttachments:true,hasMedia:true}),assistant('a','answer'),user('none','',{hasMedia:true})])); await history();
  check('attachment-only turn has no edit action',await evalJS(`document.querySelector('#history-panel [data-id="none"] [data-action="edit-prompt"]').hidden`));
  await evalJS(`document.querySelector('#history-panel [data-id="media"] [data-action="edit-prompt"]').click()`); check('attachments notice and no attachment staged', (await feedback()).includes("Attachments aren't included") && await evalJS(`!document.querySelector('#attachments .attachment-chip:not(.selection-chip)')`));
  await setup(seed([user('fallback','fallback insert'),assistant('a','answer')])); await history(); await type('old draft');
  await evalJS(`document.execCommand=()=>false;document.querySelector('#history-panel [data-id="fallback"] [data-action="edit-prompt"]').click()`);
  check('setRangeText fallback loads text',await value()==='fallback insert');
  const other=seed([user('current-user','current text'),assistant('a','answer')]);
  other.recent=[{...chatSeed('other',{draft:'other draft'}),provider:'gemini'}];
  await setup(other); await history(); await evalJS(`document.querySelector('#history-panel [data-id="current-user"] [data-action="edit-prompt"]').click()`); await sleep(350);
  check('edit changes current chat only',await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));return s.current.draft==='current text' && s.recent[0].draft==='other draft'})()`));
  await setup(seed([],{lastPrompt:'',lastResponse:''})); await evalJS(`__mock.hold=true`); await send('live prompt'); await waitFor(`__mock.last('chat_send')`); await sleep(80);
  check('live user bubble has real edit button, assistant does not',await evalJS(`(()=>{const b=document.querySelector('#bubble-zone [data-role="user"] [data-action="edit-prompt"]');return b?.tagName==='BUTTON' && !b.hidden && b.tabIndex===0 && !document.querySelector('#bubble-zone [data-role="assistant"] [data-action="edit-prompt"]')})()`));
  const sent=await count('chat_send'); await evalJS(`document.querySelector('#bubble-zone [data-role="user"] [data-action="edit-prompt"]').click()`); await sleep(350);
  check('edit works during held stream without sending',await value()==='live prompt' && await count('chat_send')===sent && (await state()).draft==='live prompt');
  await setup(seed([],{lastPrompt:'',lastResponse:''})); await send('/temp'); await sleep(150); await evalJS(`__mock.hold=true`); await send('temporary prompt'); await waitFor(`__mock.last('chat_send')`); await press('ArrowUp');
  check('temporary chat recalls its prompt',await value()==='temporary prompt');
  { const other=chatSeed('other',{draft:'keep this draft'}); await setup({v:1,current:{...chatSeed('current',{transcript:[user('u1','recall me')]}),transcript:[user('u1','recall me')]},recent:[other]});
    await press('ArrowUp'); check('recall precondition',await value()==='recall me');
    await evalJS(`document.querySelector('#tabs [data-key="other"]').click()`); await sleep(200);
    check('switch restores draft',await value()==='keep this draft');
    await press('ArrowUp'); await press('ArrowDown');
    check('arrows after a chat switch keep its draft',await value()==='keep this draft'); }
  const toolsCheck = async (name, row) => {
    const r = await evalJS(`(()=>{const b=document.querySelector('${row} .bubble-user');if(!b)return null;const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    check(name+': user bubble rendered',!!r);
    if (!r) return;
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x,y:r.y}); await sleep(250);
    const g = await evalJS(`(()=>{const t=document.querySelector('${row} .bubble-tools'),c=document.querySelector('${row} .turn-content'),a=t.getBoundingClientRect(),b=c.getBoundingClientRect();const hit=[...t.querySelectorAll('button:not([hidden])')].every(x=>{const q=x.getBoundingClientRect();return x.contains(document.elementFromPoint(q.left+q.width/2,q.top+q.height/2))});return {opacity:getComputedStyle(t).opacity,overlap:a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top,hit}})()`);
    check(name+': tools visible, clickable, not over the prompt',g.opacity==='1'&&!g.overlap&&g.hit,JSON.stringify(g));
    if (process.env.QCHAT_SHOT) await writeFile(process.env.QCHAT_SHOT, Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1});
  };
  await cdp('Emulation.setDeviceMetricsOverride',{width:760,height:800,deviceScaleFactor:1,mobile:false});
  await setup(seed([user('s1','Shot prompt to edit'),assistant('s2','A reply')])); await history(); await sleep(400);
  await toolsCheck('history','.history-row[data-role="user"]');
  await setup(seed([user('s1','Shot prompt to edit'),assistant('s2','A reply')])); await history(); await sleep(400);
  await evalJS(`document.querySelector('.history-row[data-role="user"] [data-action="edit-prompt"]').click()`); await sleep(100);
  check('tools action still works after move',await value()==='Shot prompt to edit');
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-edit-prompt-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;


