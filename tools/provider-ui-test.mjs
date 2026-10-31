// Reasoning effort composer and settings checks in an isolated, invisible Edge
// profile. Mock backend only: no account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-provider-ui-'));
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
  const press = (id) => evalJS(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));n.click();})()`);
  const pick = (name) => evalJS(`[...document.querySelectorAll('.feature-choice')].find(n=>n.textContent.includes(${JSON.stringify(name)})).click()`);
  const provider = () => evalJS(`__mock.provider`);
  await open('/?mock=signedin');
  await send('first on chatgpt');
  await waitFor(`!document.querySelector('[data-status=streaming]') && document.querySelector('[data-role=assistant]')`);
  await sleep(300);
  await press('btn-reasoning'); await sleep(60); await pick('Gemini'); await sleep(200);
  await press('btn-reasoning'); await sleep(60); await pick('ChatGPT'); await sleep(200);
  const newBefore = await evalJS(`__mock.count('chat_new')`);
  await send('second on chatgpt');
  await waitFor(`__mock.count('chat_new')>${newBefore}`, 2000);
  check('returning to a provider never sends into the chat its page still holds', await evalJS(`__mock.count('chat_new')>${newBefore}`));
  await sleep(400);
  await open('/?mock=signedin');
  await press('btn-reasoning');
  check('provider picker opens', await evalJS(`!document.querySelector('.feature-list').hidden`));
  const shots = path.join(root,'.tmp','provider-shots'); await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'composer-picker.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await press('btn-reasoning');
  check('toggle closes without reopening', await evalJS(`document.querySelector('.feature-list').hasAttribute('data-leaving') || document.querySelector('.feature-list').hidden`));
  await sleep(350);
  check('close finishes', await evalJS(`document.querySelector('.feature-list').hidden`));
  await type('keep my draft'); await press('btn-reasoning'); await pick('Gemini');
  await waitFor(`__mock.provider==='gemini'`); await sleep(100);
  check('switch keeps draft', await evalJS(`document.getElementById('prompt-input').value==='keep my draft'`));
  check('Gemini model label', await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite' && document.getElementById('btn-reasoning').getAttribute('aria-label')==='Model: Flash-Lite'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:true})`);
  const orb = await evalJS(`document.getElementById('status-dot').dataset.state`);
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'chatgpt',ready:false,loggedIn:false})`);
  check('other provider status leaves orb alone', orb===await evalJS(`document.getElementById('status-dot').dataset.state`));
  await evalJS(`__mock.interval=1`); await send('hello Gemini');
  await waitFor(`__mock.count('chat_send')>0`); await sleep(500);
  check('Gemini send carries provider without reasoning', await evalJS(`__mock.last('chat_send').args.provider==='gemini' && !('reasoningEffort' in __mock.last('chat_send').args)`));
  await evalJS(`__mock.emit('bridge',{type:'error',provider:'gemini',code:'offline'})`);
  check('Gemini error copy uses its provider',await evalJS(`document.getElementById('global-error').textContent.includes('Gemini') && !document.getElementById('global-error').textContent.includes('ChatGPT')`));
  check('Gemini response region uses its provider',await evalJS(`document.getElementById('bubble-zone').getAttribute('aria-label')==='Gemini response'`));
  check('Gemini reply labels', await evalJS(`!!document.querySelector('[aria-label="Gemini replied"]') && !document.querySelector('[aria-label="ChatGPT replied"]')`));
  await press('btn-reasoning'); await pick('ChatGPT'); await sleep(100);
  check('ChatGPT restores reasoning', !(await evalJS(`document.getElementById('btn-reasoning').hidden`)));
  await evalJS(`document.querySelector('.tab').click()`); await sleep(150);
  check('tab reopen switches provider', await provider()==='gemini');
  await evalJS(`__mock.failProvider=true`); await press('btn-reasoning'); await pick('ChatGPT'); await sleep(100);
  check('failed switch rolls back', await provider()==='gemini' && await evalJS(`document.getElementById('btn-reasoning').getAttribute('aria-label')==='Model: Flash-Lite'`));
  await open('/?mock=signedin',{chats:{v:1,current:{key:'g1',provider:'gemini',conversationId:'abcdef0123456789',title:'Old Gemini',messages:[{role:'user',text:'hi'}]},recent:[]}});
  await open('/?mock=signedin&failProvider',{keep:true});
  await sleep(250);
  check('failed startup switch follows native', await evalJS(`document.querySelector('#btn-reasoning span').textContent==='Medium'`) && await evalJS(`/Using ChatGPT/.test(document.getElementById('global-error-text').textContent)`));
  await open('/',{settings:{v:5,defaultReasoning:'high'}});
  check('v5 migrates to v6 with defaults', await evalJS(`QSettings.VERSION===6 && QSettings.settings.defaultProvider==='chatgpt' && QSettings.settings.showBarAtStartup===false && QSettings.settings.defaultReasoning==='high'`));
  check('normal launch shows main', await evalJS(`__mock.count('show_main')===1`));
  await open('/?autostart'); check('autostart stays quiet',await evalJS(`__mock.count('show_main')===0`));
  await open('/?autostart',{settings:{v:6,showBarAtStartup:true}}); check('startup preference shows main',await evalJS(`__mock.count('show_main')===1`));
  for (const name of ['chatgpt','gemini']) {
    await open('/',{settings:{v:6,barWidth:340,defaultProvider:name}});
    check(name+' narrow prompt fit',await evalJS(`document.getElementById('prompt-input').getBoundingClientRect().width>=150`));
  }
  await open('/settings.html');
  check('settings provider and startup rows',await evalJS(`!!document.querySelector('[data-key="defaultProvider"]') && !!document.querySelector('[data-key="showBarAtStartup"]') && !!document.getElementById('btn-signin-gemini') && document.body.textContent.includes('Open at startup')`));
  await evalJS(`document.getElementById('btn-signin-gemini').click()`);
  check('Gemini account sign in passes provider',await evalJS(`__mock.last('show_signin').args.provider==='gemini'`));
  await open('/?mock=signedin');
  await key('k', {ctrlKey:true});
  check('commands include other provider and startup', await evalJS(`document.getElementById('slash-menu').textContent.includes('gemini') && document.getElementById('slash-menu').textContent.includes('startup') && ![...document.querySelectorAll('.slash-name')].some(n=>n.textContent==='chatgpt')`));
  await type('/gem');
  check('typing filters command menu', await evalJS(`document.querySelectorAll('#slash-menu [role=option]').length===1`));
  await key('Escape'); await send('/model'); await sleep(100);
  check('model list exposes selection', await evalJS(`!!document.querySelector('.feature-results[role=listbox] [role=option][aria-selected=true]')`));
  await pick('Mock alternate'); await sleep(100);
  check('model chip selected', await evalJS(`document.getElementById('model-chip').textContent==='Mock alternate'`));
  await send('/gemini'); await sleep(150);
  check('provider switch clears model chip', await evalJS(`document.getElementById('model-chip').hidden`));
  await send('/clear');
  await key('ArrowRight');
  check('clear arrow moves to keep', await evalJS(`document.activeElement===document.getElementById('btn-clear-no')`));
  await evalJS(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  check('outside pointer dismisses clear', await evalJS(`document.getElementById('clear-confirm').hidden`));
  await open('/settings.html?mock=signedin');
  await evalJS(`(()=>{const b=document.querySelector('[role=radio]'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);
  check('settings arrow applies radio', await evalJS(`document.activeElement.getAttribute('aria-checked')==='true'`));
  await evalJS(`__mock.emit('bridge',{provider:'gemini',type:'error',code:'auth'})`); await sleep(30);
  check('Gemini auth updates account', await evalJS(`document.getElementById('gemini-account-status').textContent==='Signed out'`));
  await open('/?mock=silent-models');
  await send('/model'); await sleep(6200);
  check('silent model request times out', await evalJS(`document.querySelector('.feature-heading').textContent==="Couldn't read the model list"`));
  await evalJS(`__mock.emit('bridge',{type:'models',models:[{id:'late',label:'Late'}]})`);
  check('late models cannot reopen timed out picker', await evalJS(`!document.querySelector('.feature-list').textContent.includes('Late')`));
  await send('/model'); await press('btn-reasoning'); await sleep(6200);
  check('model timeout cannot replace newer picker', await evalJS(`!document.querySelector('.feature-list').textContent.includes("Couldn't read")`));
  await open('/?mock=signedin');
  check('one composer picker only',await evalJS(`!document.getElementById('btn-provider') && document.querySelectorAll('.reasoning-btn').length===1`));
  await press('btn-reasoning');
  check('ChatGPT panel contract',await evalJS(`[...document.querySelectorAll('.feature-title')].map(n=>n.textContent).join('|')==='Low|Medium|High|Switch to Gemini'`));
  await writeFile(path.join(shots,'chatgpt-panel.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await pick('Switch to Gemini'); await sleep(100);
  await press('btn-reasoning');
  check('Gemini disabled row is inert',await evalJS(`(()=>{const b=[...document.querySelectorAll('.feature-choice')].find(n=>n.textContent.includes('Pro')); const count=__mock.count('chat_model_choose'); b.click(); return b.disabled && __mock.count('chat_model_choose')===count;})()`));
  await key('ArrowDown');
  check('keyboard skips disabled model',await evalJS(`document.querySelector('[data-selected] .feature-title').textContent==='Thinking'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:false,model:'Flash-Lite'})`);
  await press('btn-reasoning'); await sleep(300); await send('/model');
  check('signed-out disabled row includes Sign in',await evalJS(`[...document.querySelectorAll('.feature-choice')].some(n=>n.disabled && n.textContent.includes('Pro') && n.textContent.includes('Sign in'))`));
  check('no invented reasoning group',await evalJS(`![...document.querySelectorAll('.feature-heading')].some(n=>n.textContent==='Reasoning')`));
  await writeFile(path.join(shots,'gemini-panel.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await pick('Thinking'); await sleep(30);
  check('model chosen short updates composer',await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking'`));
  await press('btn-reasoning'); await evalJS(`__mock.failModel=true`); await pick('Flash-Lite'); await sleep(30);
  check('failed choice preserves label',await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking' && document.getElementById('global-error').textContent.includes("Couldn't change the model")`));
  await evalJS(`__mock.failModel=false; __mock.levels=[{id:'effort',label:'Medium',selected:true}]`);
  await press('btn-reasoning');
  check('optional reasoning group appears',await evalJS(`[...document.querySelectorAll('.feature-heading')].some(n=>n.textContent==='Reasoning')`));
  await press('btn-reasoning'); await sleep(300);
  await evalJS(`__mock.models.gemini=[{id:'long',label:'An exceptionally long model name for narrow composer checks',selected:true}]`);
  await press('btn-reasoning'); await pick('An exceptionally'); await sleep(30);
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,barWidth:340})`); await sleep(100);
  check('long Gemini label keeps narrow prompt usable',await evalJS(`document.getElementById('prompt-input').getBoundingClientRect().width>=150 && document.querySelector('.reasoning-label').getBoundingClientRect().width<=96`),await evalJS(`JSON.stringify({prompt:document.getElementById('prompt-input').getBoundingClientRect().width,label:document.querySelector('.reasoning-label').getBoundingClientRect().width,bar:document.getElementById('btn-reasoning').parentElement.getBoundingClientRect().width})`));
  await press('btn-reasoning'); await press('btn-reasoning'); await sleep(300);
  await evalJS(`__mock.silentModels=true`);
  // A silent backend proves the cached list paints synchronously on reopening.
  await evalJS(`__mock.calls=[]`);
  await press('btn-reasoning');
  check('cached list opens immediately',await evalJS(`document.querySelector('.feature-list').textContent.includes('An exceptionally')`));
  await open('/?mock=signedin',{chats:{v:1,current:{key:'current',provider:'chatgpt',title:'Current'},recent:[{key:'g',provider:'gemini',title:'Gemini chat',lastActive:Date.now()},{key:'c',provider:'chatgpt',title:'GPT chat',lastActive:Date.now()}]}});
  check('recent tabs use provider SVGs and All chats retains clock',await evalJS(`document.querySelectorAll('.tab svg[data-provider]').length===2 && !!document.querySelector('.tab svg[data-provider="gemini"]') && document.querySelector('.tab-all .icon').tagName!=='svg'`));
  await sleep(350);
  await writeFile(path.join(shots,'provider-tabs.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,showTabClock:false})`); await sleep(50);
  check('stored clock preference hides logos',await evalJS(`[...document.querySelectorAll('.tab svg')].every(n=>getComputedStyle(n).display==='none')`));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-provider-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
