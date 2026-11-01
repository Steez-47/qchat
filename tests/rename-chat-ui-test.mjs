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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-rename-chat-ui-'));
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
  ws.onclose=()=>{for(const callback of pending.values())callback({error:{message:'CDP closed'}});pending.clear()};
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`))},15000);
    pending.set(id, (d) => {clearTimeout(timer);d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)});
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
  const until=async(expression)=>{if(!await waitFor(expression))throw Error('Timed out: '+expression)};
  const seed=()=>({v:1,current:{key:'rename-current',provider:'chatgpt',title:'Original title',lastActive:1000,createdAt:500,lastPrompt:'Earlier question',lastResponse:'Earlier reply',draft:'Keep this draft 🌏',selectionTexts:['Quoted selection'],transcript:[{id:'u',role:'user',text:'Earlier question'},{id:'a',role:'assistant',text:'Earlier reply'}]},recent:[{key:'older',provider:'chatgpt',title:'Older chat',createdAt:200,lastActive:300,lastPrompt:'Other question',lastResponse:'Other reply'},{key:'gemini-chat',provider:'gemini',title:'Gemini chat',createdAt:100,lastActive:200,lastPrompt:'Gemini question',lastResponse:'Gemini reply'}]});
  const setup=async(settings={})=>{await open('/?mock=1',{settings:{animations:'off',autoDismiss:0,keepHistory:true,showTabs:true,...settings},chats:seed()});await until(`document.getElementById('prompt-input').value==='Keep this draft 🌏'`)};
  const state=()=>evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const command=async name=>{await key('k',{ctrlKey:true});await until(`!!document.querySelector('#slash-menu [data-command="${name}"]')`);await evalJS(`document.querySelector('#slash-menu [data-command="${name}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`)};
  const rename=async()=>{await command('rename');await until(`!document.getElementById('rename-chat').hidden`)};
  const setName=text=>evalJS(`(()=>{const input=document.getElementById('rename-chat-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const save=()=>evalJS(`document.getElementById('rename-chat').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  const nativeKey=async(value,code,virtual,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:virtual,modifiers});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:virtual,modifiers})};

  await setup();const before=await state();
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(2,7)`);await rename();
  check('menu opens a selected accessible current title without changing the draft',await evalJS(`(()=>{const input=document.getElementById('rename-chat-input');return document.activeElement===input&&input.value==='Original title'&&input.selectionStart===0&&input.selectionEnd===input.value.length&&document.getElementById('rename-chat').getAttribute('aria-label')==='Rename local chat'&&document.getElementById('prompt-input').value==='Keep this draft 🌏'&&document.querySelector('#attachments .selection-chip')})()`));
  await setName('  Project\n notes  🌏\t');await save();
  const after=await state();const sameMetadata=structuredClone(before);sameMetadata.current.title='Project notes 🌏';
  check('save normalizes the title and changes no other chat or draft metadata',JSON.stringify(after)===JSON.stringify(sameMetadata));
  check('rename never sends or creates a provider chat',await count('chat_send')===0&&await count('chat_new')===0);
  check('save returns to composer with its original selection',await evalJS(`document.getElementById('rename-chat').hidden&&document.activeElement.id==='prompt-input'&&document.getElementById('prompt-input').selectionStart===2&&document.getElementById('prompt-input').selectionEnd===7`));
  await key('n',{ctrlKey:true});await until(`!!document.querySelector('.tab[data-key="rename-current"]')`);
  check('renamed title appears safely in recent tabs',await evalJS(`document.querySelector('.tab[data-key="rename-current"] .tab-title').textContent==='Project notes 🌏'`));
  await evalJS(`document.querySelector('.tab[data-key="rename-current"]').click()`);await until(`document.getElementById('prompt-input').value==='Keep this draft 🌏'`);
  await cdp('Page.reload');await until(`document.getElementById('prompt-input')?.value==='Keep this draft 🌏'`);
  check('renamed title and draft survive reload',(await state()).current.title==='Project notes 🌏');

  await setup();
  await evalJS(`window.fileRemovals=[];window.originalStage=__TAURI__.core.invoke;__TAURI__.core.invoke=(command,args)=>command==='attachment_begin'?Promise.resolve({...args,id:'rename-file'}):command==='attachment_chunk'||command==='attachment_finish'?Promise.resolve({}):command==='attachment_remove'?(fileRemovals.push(args.id),Promise.resolve()):originalStage(command,args);(()=>{const data=new DataTransfer();data.items.add(new File(['kept bytes'],'keep.txt',{type:'text/plain'}));const input=document.getElementById('attachment-input');input.files=data.files;input.dispatchEvent(new Event('change'))})()`);
  await until(`!!document.querySelector('#attachments [data-state=ready]')`);await rename();await setName('Kept files');
  await evalJS(`document.getElementById('rename-chat-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}))`);
  check('IME Enter does not save a partial composition',await evalJS(`!document.getElementById('rename-chat').hidden`)&&(await state()).current.title==='Original title');
  await nativeKey('Enter','Enter',13);
  check('native Enter saves once and keeps attachments, selections and composer text',await evalJS(`document.getElementById('rename-chat').hidden&&fileRemovals.length===0&&document.getElementById('attachments').textContent.includes('keep.txt')&&document.querySelector('#attachments .selection-chip')&&document.getElementById('prompt-input').value==='Keep this draft 🌏'`)&&(await state()).current.title==='Kept files'&&await count('chat_send')===0);
  await save();check('late duplicate submit cannot change the saved name',(await state()).current.title==='Kept files');

  await setup();await rename();await setName('   ');await save();
  check('blank save stays open with accessible feedback and keeps the title',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').getAttribute('aria-invalid')==='true'&&!document.getElementById('rename-chat-error').hidden&&document.getElementById('rename-chat-error').textContent==='Enter a chat name.'`)&&(await state()).current.title==='Original title');
  await key('Escape');
  check('Escape cancels without dismissing the conversation or draft',await evalJS(`document.getElementById('rename-chat').hidden&&document.activeElement.id==='prompt-input'&&document.querySelector('[data-role=assistant]')&&document.getElementById('prompt-input').value==='Keep this draft 🌏'`)&&await count('hide_main')===0);
  await rename();await setName('cancelled');await evalJS(`document.querySelector('[aria-label="Cancel rename"]').click()`);
  check('cancel leaves saved title unchanged',(await state()).current.title==='Original title');
  await rename();await setName('😀'.repeat(41)+'tail');await save();await cdp('Page.reload');await until(`document.getElementById('prompt-input')?.value==='Keep this draft 🌏'`);
  check('forty Unicode code points survive storage without broken surrogate pairs',(await state()).current.title==='😀'.repeat(40));
  await rename();await setName('a'.repeat(39)+' b');await save();const boundaryTitle=(await state()).current.title;
  await cdp('Page.reload');await until(`document.getElementById('prompt-input')?.value==='Keep this draft 🌏'`);
  check('a name cut at whitespace stays identical after reload',boundaryTitle==='a'.repeat(39)&&(await state()).current.title===boundaryTitle);
  const literal='<img src=x onerror=alert(1)>';
  await rename();await setName(literal);await save();await key('n',{ctrlKey:true});await until(`!!document.querySelector('.tab[data-key="rename-current"]')`);
  check('HTML in a name stays literal text',await evalJS(`document.querySelector('.tab[data-key="rename-current"]').title.startsWith(${JSON.stringify(literal)})&&!document.querySelector('img[src="x"]')`));

  await setup();await key('p',{ctrlKey:true});await until(`!!document.querySelector('[aria-label="Remove chat"]')`);
  await evalJS(`[...document.querySelectorAll('.feature-row')].find(row=>row.querySelector('.feature-title')?.textContent==='Older chat').querySelector('[aria-label="Remove chat"]').click()`);await rename();
  await nativeKey('Backspace','Backspace',8);await until(`document.getElementById('rename-chat-input').value===''`);
  await nativeKey('z','KeyZ',90,2);
  check('empty title editor uses native undo instead of restoring a removed chat',await evalJS(`document.getElementById('rename-chat-input').value==='Original title'&&!JSON.parse(localStorage.getItem('qchat.chats')).recent.some(chat=>chat.key==='older')`));
  await key('Escape');
  check('rename Escape takes priority over a pending chat Undo',await evalJS(`document.getElementById('rename-chat').hidden&&document.querySelector('#command-feedback button')?.textContent==='Undo'&&!JSON.parse(localStorage.getItem('qchat.chats')).recent.some(chat=>chat.key==='older')`));

  for(const action of ['new','switch','provider','menu','find','history','clear','dismiss']){
    await setup();await rename();await setName('must never leak');
    if(action==='new')await key('n',{ctrlKey:true});
    if(action==='switch')await evalJS(`document.querySelector('.tab[data-key="older"]').click()`);
    if(action==='provider')await command('gemini');
    if(action==='menu')await key('k',{ctrlKey:true});
    if(action==='find')await key('f',{ctrlKey:true});
    if(action==='history')await evalJS(`document.getElementById('btn-history').click()`);
    if(action==='clear')await evalJS(`__mock.emit('qchat://clear-chats',{})`);
    if(action==='dismiss')await evalJS(`document.querySelector('[data-action="dismiss-turn"]').click()`);
    await until(`document.getElementById('rename-chat').hidden`);await save();
    check(action+' closes rename and rejects a stale save',!(await state()).current.title.includes('must never leak'));
  }

  await setup();await evalJS('window.__mock.hold=true');await send('Streaming question');await until(`!!__mock.last('chat_send')`);
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'partial reply'})`);
  await rename();await setName('Named while streaming');await save();
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:'final reply'})`);await until(`!document.querySelector('[data-status=streaming]')`);
  check('renaming during streaming survives completion without sending again',(await state()).current.title==='Named while streaming'&&await count('chat_send')===1&&await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse==='final reply'`));

  await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});await type('unsent fresh draft');await command('rename');
  check('a meaningful fresh draft opens Rename without changing its text',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').value==='unsent fresh draft'&&document.getElementById('prompt-input').value==='unsent fresh draft'`));
  await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});await evalJS(`__mock.emit('qchat://selection','selection only')`);await command('rename');
  check('a selection-only draft opens Rename with its context hidden and intact',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').value==='Untitled chat'&&document.querySelector('#attachments .selection-chip')&&document.getElementById('prompt-input').value===''`));

  for(const privateMode of ['temporary','history-disabled']){
    await open('/?mock=1',{settings:{animations:'off',autoDismiss:0,keepHistory:privateMode!=='history-disabled'}});
    if(privateMode==='temporary')await command('temp');
    await evalJS(`window.__mock.hold=true`);await send('private question');await until(`!!__mock.last('chat_send')`);
    await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:'private answer'})`);await until(`!document.querySelector('[data-status=streaming]')`);
    await rename();await setName('PRIVATE TITLE');await save();
    check(privateMode+' rename keeps private data out of saved history',await evalJS(`!String(localStorage.getItem('qchat.chats')).includes('PRIVATE TITLE')&&!String(localStorage.getItem('qchat.chats')).includes('private question')`));
  }

  await setup();await type('/rename');await key('Enter');await until(`!document.getElementById('rename-chat').hidden`);
  check('typed /rename opens the editor and consumes only the command',await inputValue()===''&&await count('chat_send')===0);
  await setup();await rename();
  await evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,barWidth:340,replyWidth:340,look:'frost'}))`);
  await cdp('Emulation.setDeviceMetricsOverride',{width:368,height:800,deviceScaleFactor:1,mobile:false});await sleep(100);
  check('rename fits the narrow popup and has a usable input',await evalJS(`(()=>{const form=document.getElementById('rename-chat').getBoundingClientRect(),input=document.getElementById('rename-chat-input').getBoundingClientRect();return form.left>=0&&form.right<=innerWidth&&form.top>=0&&form.bottom<=innerHeight&&input.width>=100})()`));
  const shots=path.join(root,'.tmp','rename-shots');await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'rename-narrow.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,look:'aurora'}))`);await sleep(50);
  await writeFile(path.join(shots,'rename-narrow-dark.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-rename-chat-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
