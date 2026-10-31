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
  await mkdir(path.join(root,'.tmp/features'),{recursive:true});
  const modelShot = await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/features/feature-models-reviewed.png'),Buffer.from(modelShot.data,'base64'));
  check('model rows mark the selection with an accent check glyph', await evalJS(`(()=>{const rows=[...document.querySelectorAll('.feature-list .feature-row')];if(rows.length!==2)return false;const a=rows[0],b=rows[1];return a.querySelector('.feature-check')&&a.querySelector('.feature-check').style.visibility==='visible'&&a.querySelector('.feature-title').textContent==='Mock model'&&b.querySelector('.feature-check')&&b.querySelector('.feature-check').style.visibility==='hidden'&&b.querySelector('.feature-title').textContent==='Mock alternate';})()`));
  await evalJS(`[...document.querySelectorAll('.feature-choice')].find(n=>n.textContent==='Mock alternate').click()`);
  check('model choice label', await evalJS(`document.getElementById('model-chip').textContent==='Mock alternate'`));
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
  await evalJS(`__mock.reply='Short and done.'`);
  await send('Probe a short reply');
  await waitFor(`(()=>{const rows=[...document.querySelectorAll('.turn-row[data-role=assistant]')].filter(r=>r.dataset.status==='done');return rows.length===1&&!rows[0].hasAttribute('data-capped');})()`);
  check('reply tools float above the bubble top for a short reply', await evalJS(`(()=>{const t=document.querySelector('.turn-row[data-role=assistant] .bubble-tools');const tr=t.getBoundingClientRect(),br=t.closest('.turn-row').querySelector('.bubble').getBoundingClientRect();return tr.bottom<br.top&&tr.top>=0&&tr.right<=br.right+1;})()`));
  await evalJS(`__mock.reply=null`);
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
  check('older chats keep their messages while storage allows', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).recent.slice(7).every(c=>c.transcript.length>0)`));
  check('tabs use natural width and no fillets', await evalJS(`getComputedStyle(document.querySelector('.tab')).flexGrow==='0' && getComputedStyle(document.querySelector('.tab-label'),'::before').display==='none'`));
  await evalJS(`__mock.emit('qchat://settings-changed', QSettings.settings)`);
  check('settings refresh requests theme', await count('get_theme')>1);
  for (const command of ['new','chats','model','temp','settings','signin','clear','keys','hide']) {
    await type('/'+command); await key('Enter'); await sleep(30); await key('Escape');
  }
  check('every menu command runs without console errors', problems.length===0);
  check('attachment chips use quiet 28px height', (await readFile(path.join(root,'ui/app.css'),'utf8')).includes('height: 28px; min-height: 28px'));
  check('README documents feature checks', (await readFile(path.join(root,'README.md'),'utf8')).includes('feature-ui-test.mjs'));
  await open('/', { chats: { v:1,current:chatSeed('current'),recent:[chatSeed('a'),chatSeed('b'),chatSeed('c')] }, settings:{animations:'off',autoDismiss:0} });
  await key('p', { ctrlKey: true });
  await waitFor(`!document.querySelector('.feature-list').hidden && document.querySelectorAll('.feature-list .feature-row').length===3`);
  check('chat rows are title span plus tabular meta span', await evalJS(`(()=>{const rows=[...document.querySelectorAll('.feature-list .feature-row')];return rows.length===3&&rows.every(r=>{const t=r.querySelector('.feature-title'),m=r.querySelector('.feature-meta');return !!t&&t.textContent.length>0&&!!m&&m.textContent.trim().length>0&&getComputedStyle(m).fontVariantNumeric.includes('tabular-nums');});})()`));
  check('searchable list drops the heading and such rows hover quiet', await evalJS(`!document.querySelector('.feature-list > .feature-heading') && document.querySelectorAll('.feature-list .feature-row button').length===6`));
  check('search field opens focused, quiet, without accent ring', await evalJS(`(()=>{const f=document.querySelector('.feature-search');const s=getComputedStyle(f);return document.activeElement===f&&f.placeholder==='Search chats'&&s.outlineStyle==='none'&&s.borderTopWidth==='1px'&&s.backgroundColor!=='rgba(0, 0, 0, 0)';})()`));
  const chatsShot = await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/features/feature-chats-reviewed.png'),Buffer.from(chatsShot.data,'base64'));
  await key('ArrowDown');
  check('arrow moves the data-selected highlight with focus in the field', await evalJS(`(()=>{const rows=[...document.querySelectorAll('.feature-list .feature-row')];return rows[1].hasAttribute('data-selected')&&!rows[0].hasAttribute('data-selected')&&document.activeElement===document.querySelector('.feature-search');})()`));
  await key('Enter');
  check('Enter opens the highlighted chat into the composer', await evalJS(`document.querySelector('.feature-list').hidden&&document.activeElement===document.getElementById('prompt-input')&&JSON.parse(localStorage.getItem('qchat.chats')).current.key==='b'`));
  await type('/keys'); await key('Enter'); await sleep(80);
  check('shortcuts card rows are quiet kbd chips, not buttons', await evalJS(`(()=>{const list=document.querySelector('.feature-list');return !list.hidden&&list.querySelectorAll('.feature-row button').length===0&&list.querySelectorAll('.key').length>=8&&[...list.querySelectorAll('.feature-row')].every(r=>r.firstElementChild.classList.contains('key')&&r.children[1].classList.contains('feature-title'));})()`));
  check('combo chips are single 22px kbds', await evalJS(`(()=>{const k=document.querySelector('.feature-keys .key');const s=getComputedStyle(k);return !!k&&s.height==='22px'&&s.fontSize==='11.5px'&&!k.textContent.includes('\\n')&&k.textContent.length>1;})()`));
  check('shortcuts open focuses the list itself, not a row', await evalJS(`document.activeElement===document.querySelector('.feature-list')`));
  await key('x');
  check('any key closes the card back into the composer', await evalJS(`document.querySelector('.feature-list').hidden&&document.activeElement===document.getElementById('prompt-input')`));
  await open('/', { chats: { v:1,current:chatSeed('current'),recent:[{...chatSeed('a'),title:'Debounce helper',lastActive:Date.now()-30*MIN},{...chatSeed('b'),title:'Trip ideas',lastActive:Date.now()-300*MIN},{...chatSeed('c'),title:'Résumé edits',lastActive:Date.now()-4320*MIN}] }, settings:{animations:'off',autoDismiss:0} });
  await cdp('Emulation.setDeviceMetricsOverride', {width:516,height:300,deviceScaleFactor:3,mobile:false});
  const tabShot = await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/features/feature-tabs-reviewed-3x.png'),Buffer.from(tabShot.data,'base64'));
  const appSource = await readFile(path.join(root,'ui/app.js'),'utf8');
  const surfacesSource = await readFile(path.join(root,'ui/surfaces.js'),'utf8');
  const nativeSource = await readFile(path.join(root,'src-tauri/src/surfaces.rs'),'utf8');
  const bridgeSource = await readFile(path.join(root,'src-tauri/bridge/chatgpt-bridge.js'),'utf8');
  const settingsAcl = JSON.parse(await readFile(path.join(root,'src-tauri/capabilities/settings.json'),'utf8'));
  check('finding 1 settings selection and desktop command ACL', ['get-hotkey','set-hotkey','get-autostart','set-autostart','get-selection-hotkey','set-selection-hotkey','set-selection-clipboard'].every(c=>settingsAcl.permissions.includes('allow-'+c)));
  check('finding 2 startup registration tracked and fallback attempted', nativeSource.includes('s.registered=registered') && nativeSource.includes('chosen = "Alt+Q"'));
  check('finding 3 temporary command awaits new chat before marking it', appSource.includes('await startNewChat(false); chats.current.temporary = true'));
  check('finding 4 held buttons only prevent ignoring',nativeSource.includes('!desired || [1,2,4,5,6]'));
  check('finding 5 model selection refuses active jobs and ambiguous triggers',bridgeSource.includes('if(active)') && bridgeSource.includes('candidates.length !== 1') && bridgeSource.includes("['pointerdown','mousedown','pointerup','mouseup','click']"));
  check('finding 6 temporary chat saves a fresh current with recents',appSource.includes('chats.current.temporary ? freshChat() : chats.current'));
  check('finding 7 model menu polls and empty menu reports unavailable',bridgeSource.includes('i<30') && bridgeSource.includes('if(!nodes.length) { unavailable(); return; }'));
  check('finding 8 separate model chip has a first-line 28 character label',appSource.includes('modeChips.append(modeChip, modelChip)') && appSource.includes(".split('\\n')[0].slice(0,28)"));
  check('finding 9 retry guards attachments and persists actual prompt',appSource.includes('chat.lastPrompt = prompt;') && appSource.includes('!turn.prompt || turn.hadAttachments'));
  check('finding 10 surface limit and stale fail-open guard',nativeSource.includes('rects.len() > 2048') && nativeSource.includes('!rs.is_empty()') && nativeSource.includes('reported.elapsed()'));
  check('finding 11 surface geometry intersects viewport and clipping ancestors',surfacesSource.includes('Math.min(innerWidth,b.right)') && surfacesSource.includes('parent=parent.parentElement'));
  check('finding 12 surfaces use Set membership and finite animation loops',surfacesSource.includes('new Set(nodes)') && surfacesSource.includes('iterations !== Infinity') && nativeSource.includes('Result<(), String>'));
  check('finding 13 autostart compares stored executable path',nativeSource.includes("trim_end_matches('\\0') == expected"));
  check('finding 14 reconnect navigates signed-in unready page',appSource.includes('bridge.loggedIn && !bridge.ready ? "chat_new" : "chat_status"'));
  check('finding 15 quota trims oldest entries without erasing all recents',appSource.includes('while (recent.length > 1)') && !appSource.includes('current.transcript.slice(-2) }, recent: []'));
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
