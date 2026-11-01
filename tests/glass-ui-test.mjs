// Bubble UI checks and screenshots in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input. `--shots <dir>` also captures review PNGs.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-glass-ui-'));
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) problems.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
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
  await cdp('Log.enable');
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({rows:[...document.querySelectorAll('.turn-row')].map(r=>({role:r.dataset.role,status:r.dataset.status,hidden:r.hidden,cls:r.className})),calls:window.__mock?.calls.slice(-4).map(c=>c.cmd),fits:window.__mock?.fits.length,lastFits:window.__mock?.fits.slice(-4).map(x=>x.height),text:document.querySelector('[data-role=assistant] .turn-content')?.textContent.length,capped:document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped'),now:performance.now()|0,hold:window.__mock?.hold,rel:!!window.__mock?.release,btn:document.getElementById('btn-send')?.dataset.mode})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await until(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const cssVar = (name) => evalJS(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const chat = (key, conv, ago, title = key) => ({ key, conversationId: conv, title, lastActive: Date.now() - ago, lastPrompt: `prompt ${key}`, lastResponse: `Cached **reply** for ${key}`, createdAt: Date.now() - ago });
  const seeded = (current, ...recent) => ({ v: 1, current, recent });

  // --- Compact idle ---------------------------------------------------------
  await open('/');
  await settle();
  const idle = await evalJS(`({bar:document.getElementById('bar').offsetHeight, stack:document.getElementById('stack').offsetHeight, fit:__mock.fit, zoneHidden:document.getElementById('bubble-zone').hidden, tabsHidden:document.getElementById('tabs').hidden, bodyBg:getComputedStyle(document.body).backgroundColor})`);
  check('compact idle is just the bar', idle.bar === 44 && idle.zoneHidden && idle.tabsHidden, JSON.stringify(idle));
  const guestChip = await evalJS(`!document.getElementById('guest-notice').hidden`);
  if (guestChip) await evalJS(`document.getElementById('btn-guest-dismiss').click()`);
  await settle();
  const idleFit = await evalJS(`__mock.fit`);
  check('idle fit_window is the reading column plus gutters, at its full reserved height', idleFit.width === 640 + 56 && idleFit.content === 44 + 56 && idleFit.height >= 600, JSON.stringify(idleFit));
  check('no set_layout call or layout attribute', await count('set_layout') === 0 && await evalJS(`!document.documentElement.dataset.layout`));
  check('guest chip appears before first message', guestChip);
  check('window prefs sent on startup', await evalJS(`__mock.last('set_window_prefs')?.args.alwaysOnTop===true && __mock.last('set_window_prefs')?.args.rememberPosition===true`));

  // Sample real layout frames: a height transition must pass through intermediate
  // sizes, keep the caret, and settle without accumulating extra native resizes.
  const composerFrames = async (text) => evalJS(`new Promise(resolve=>{
    const input=document.getElementById('prompt-input'); input.focus();
    input.value=${JSON.stringify(text)}; input.setSelectionRange(input.value.length,input.value.length);
    const before=input.getBoundingClientRect().height;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    const frames=[]; const start=performance.now();
    function sample(now){frames.push(input.getBoundingClientRect().height);
      if(now-start<450)requestAnimationFrame(sample);
      else resolve({before,frames,caret:input.selectionStart,length:input.value.length,
        line:parseFloat(getComputedStyle(input).lineHeight),
        padding:parseFloat(getComputedStyle(input).paddingTop)+parseFloat(getComputedStyle(input).paddingBottom),
        overflow:getComputedStyle(input).overflowY});}
    requestAnimationFrame(sample);
  })`);
  const grow = await composerFrames('First line\nSecond line\nThird line');
  const animatedHeight = grow.frames.at(-1);
  check('composer eases through intermediate heights on new lines', animatedHeight > grow.before && grow.frames.some(h => h > grow.before + 1 && h < animatedHeight - 1), JSON.stringify(grow));
  check('composer resizing preserves the caret', grow.caret === grow.length);
  const cappedInput = await composerFrames(Array(12).fill('Another line').join('\n'));
  check('composer keeps six-line cap and scrolls longer drafts', Math.abs(cappedInput.frames.at(-1) - (6 * cappedInput.line + cappedInput.padding)) < 2 && cappedInput.overflow === 'auto', JSON.stringify(cappedInput));
  const shrink = await composerFrames('');
  check('composer eases back to idle height', Math.abs(shrink.frames.at(-1) - grow.before) < 1 && shrink.frames.some(h => h < shrink.before - 1 && h > grow.before + 1), JSON.stringify(shrink));
  await settle();

  // --- Send flow ------------------------------------------------------------
  await evalJS(`__mock.hold=true; __mock.interval=20; __mock.reply=${JSON.stringify(Array.from({ length: 30 }, (_, i) => `Line ${i} of a response that keeps on growing nicely.`).join('\n\n'))}`);
  await send('Explain how a debounce works in three short lines');
  check('input clears on send', await evalJS(`document.getElementById('prompt-input').value===''`));
  await sleep(30);
  const rising = await evalJS(`(()=>{const u=document.querySelector('[data-role=user]');const a=document.querySelector('[data-role=assistant]');const b=document.getElementById('bar').getBoundingClientRect();return {user:!!u, above:u&&document.querySelector('.bubble-user').offsetTop>=0&&u.offsetTop+u.offsetHeight<=b.top+200, responseHidden:a&&a.hidden, dots:!!u?.querySelector('.thinking'), stop:document.getElementById('btn-send').dataset.mode};})()`);
  check('user bubble appears, response not yet shown', rising.user && rising.responseHidden, JSON.stringify(rising));
  check('thinking indicator lives on the user bubble', rising.dots);
  check('send button becomes stop', rising.stop === 'stop');
  await settle();
  const placed = await evalJS(`(()=>{const u=document.querySelector('.bubble-user').getBoundingClientRect();const b=document.getElementById('bar').getBoundingClientRect();return {above:u.bottom<=b.top, right:Math.abs(u.right-b.right)<1, lines:document.querySelector('.bubble-user .turn-content').clientHeight, fit:__mock.fit.content, stack:document.getElementById('stack').offsetHeight}})()`);
  check('user bubble sits right-aligned above the bar', placed.above && placed.right, JSON.stringify(placed));
  check('fit_window grows with the bubble', placed.fit === placed.stack + 56, JSON.stringify(placed));
  await evalJS(`__mock.release()`);
  await until(`document.querySelector('[data-role=assistant]')&&!document.querySelector('[data-role=assistant]').hidden`, 'response reveal');
  check('first delta replaces the user bubble', await evalJS(`!document.querySelector('[data-role=user]') && !document.querySelector('[data-role=assistant]').hidden`));
  const heights = [];
  const fits = [];
  for (let i = 0; i < 26; i++) {
    const m = await evalJS(`({h:document.querySelector('.bubble-response')?.offsetHeight||0, inner:document.querySelector('.bubble-inner')?.offsetHeight||0, f:__mock.fit.content, s:document.getElementById('stack').offsetHeight, top:document.querySelector('.bubble-response')?.getBoundingClientRect().top??0})`);
    heights.push(m.h); fits.push(m);
    await sleep(45);
  }
  check('response height is monotonic while streaming', heights.every((h, i) => i === 0 || h >= heights[i - 1]) && heights.at(-1) > heights[0], heights.join(','));
  check('fit_window always covers the growing bubble', fits.every((m) => m.f >= m.s + 56), JSON.stringify(fits.at(-1)));
  const resizes = await evalJS(`__mock.fits.length`);
  check('streaming does not resize the window on every line', resizes < 22, String(resizes));
  await finishReply();
  await settle();
  await until(`__mock.fit.content===document.getElementById('stack').offsetHeight+56`, 'final window fit after response animation');
  const done = await evalJS(`({inline:document.querySelector('.bubble-response').style.height,prompt:document.getElementById('prompt-input').offsetHeight,promptStyle:document.getElementById('prompt-input').style.height,zone:document.getElementById('bubble-zone').offsetHeight,pct:QSettings.settings.maxHeightPct,avail:screen.availHeight,lastFits:__mock.fits.slice(-12),fit:__mock.fit.content, stack:document.getElementById('stack').offsetHeight, h:document.querySelector('.bubble-response').offsetHeight, inner:document.querySelector('.bubble-inner').offsetHeight, capped:document.querySelector('[data-role=assistant]').hasAttribute('data-capped'), max:Math.round(screen.availHeight*0.6), overflow:getComputedStyle(document.querySelector('.bubble-scroll')).overflowY, send:document.getElementById('btn-send').dataset.mode})`);
  check('response stays after done and fit is exact', done.fit === done.stack + 56 && done.send === 'send', JSON.stringify(done));
  check('long reply caps at the height limit and scrolls itself', done.capped && done.h <= done.max && done.overflow === 'auto' && done.inner > done.h, JSON.stringify(done));
  const bar = await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return s.offsetWidth-s.clientWidth;})()`);
  check('capped reply has a thin custom scrollbar', bar === 8, String(bar));
  await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');s.scrollTop=0;s.dispatchEvent(new Event('scroll'));})()`);
  await sleep(40);
  check('jump-to-latest chip shows when scrolled up', await evalJS(`!document.querySelector('.jump-chip').hidden`));
  await evalJS(`document.querySelector('.jump-chip').click()`);
  await sleep(40);
  check('jump-to-latest returns to the bottom', await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<4 && document.querySelector('.jump-chip').hidden})()`));
  await evalJS(`__mock.hold=false; __mock.reply=null; __mock.interval=5`);

  // --- Esc order ------------------------------------------------------------
  await type('/');
  check('slash menu opens on /', await evalJS(`!document.getElementById('slash-menu').hidden`));
  const hidesBefore = await count('hide_main');
  await key('Escape');
  check('Esc closes the slash menu first', await evalJS(`document.getElementById('slash-menu').hidden && !!document.querySelector('[data-role=assistant]')`) && await count('hide_main') === hidesBefore);
  await type('');
  await key('Escape');
  await sleep(20);
  check('Esc then dismisses the bubble', await evalJS(`!document.querySelector('[data-role=assistant]')`) && await count('hide_main') === hidesBefore);
  await settle();
  check('window shrinks back after the exit animation', await evalJS(`__mock.fit.content===document.getElementById('stack').offsetHeight+56 && document.getElementById('bubble-zone').hidden`));
  await key('Escape');
  check('Esc finally hides the window', await count('hide_main') === hidesBefore + 1);

  // Repeated stream snapshots should preserve already rendered DOM. A corrected
  // snapshot and terminal event must still produce the exact final Markdown.
  await evalJS(`__mock.hold=true`);
  await send('Streaming layout regression');
  await evalJS(`(()=>{window.streamId=__mock.last('chat_send').args.id;__mock.emit('bridge',{type:'delta',id:streamId,text:'Stable **paragraph**.\\n\\nGrowing tail'});})()`);
  await until(`document.querySelector('[data-role=assistant] .turn-content p')?.textContent==='Stable paragraph.'`);
  await evalJS(`window.stableParagraph=document.querySelector('[data-role=assistant] .turn-content p')`);
  // Saved streaming styles use the same completed-block boundary.
  await evalJS(`QSettings.apply(document.documentElement,{...QSettings.settings,streamStyle:'fade'})`);
  await evalJS(`__mock.emit('bridge',{type:'delta',id:streamId,text:'Stable **paragraph**.\\n\\nGrowing tail with more words 🌿\\n\\nPending'});`);
  await until(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('more words')`);
  check('stream updates retain completed paragraph nodes', await evalJS(`stableParagraph===document.querySelector('[data-role=assistant] .turn-content p')`));
  await evalJS(`__mock.emit('bridge',{type:'delta',id:streamId,text:'Corrected **paragraph**.\\n\\nFinal tail 🌿'});`);
  await until(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Corrected paragraph.')`);
  await evalJS(`__mock.emit('bridge',{type:'done',id:streamId,text:'Corrected **paragraph**.\\n\\nFinal tail 🌿',conversationId:'stream-regression'});`);
  await finishReply();
  check('terminal stream flush preserves corrected Markdown and Unicode', await evalJS(`document.querySelector('[data-role=assistant] .turn-content').textContent.trim()==='Corrected paragraph.\\nFinal tail 🌿' && document.querySelector('[data-role=assistant] strong')?.textContent==='paragraph'`));
  await key('Escape');
  await settle();

  // --- Slash commands -------------------------------------------------------
  await open('/');
  await settle();
  // Use the size requested from the native host, not the generous 800px test
  // viewport: an overflowing menu can otherwise appear complete in the mock.
  const nativeViewport = async () => {
    const fit = await evalJS(`__mock.fit`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: fit.width, height: fit.height, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    await settle();
  };
  await nativeViewport();
  await type('/');
  // Give the host a realistic resize delay, then inspect the remaining entrance
  // frames at the requested size while the menu is still animating.
  await sleep(50);
  const menuFit = await evalJS(`__mock.fit`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: menuFit.width, height: menuFit.height, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  const entranceBounds = await evalJS(`new Promise(resolve=>{const frames=[];const start=performance.now();function sample(now){const r=document.getElementById('slash-menu').getBoundingClientRect();frames.push({top:r.top,bottom:r.bottom,height:innerHeight});if(now-start<450)requestAnimationFrame(sample);else resolve(frames);}requestAnimationFrame(sample);})`);
  check('slash entrance stays inside the resized native viewport', entranceBounds.length > 2 && entranceBounds.every(r => r.top >= 0 && r.bottom <= r.height), JSON.stringify(entranceBounds));
  await settle();
  const slashBounds = await evalJS(`(()=>{const menu=document.getElementById('slash-menu').getBoundingClientRect();return {top:menu.top,bottom:menu.bottom,height:innerHeight,items:[...document.querySelectorAll('#slash-menu [role=option]')].map(n=>{const r=n.getBoundingClientRect();return {command:n.dataset.command,top:r.top,bottom:r.bottom};})};})()`);
  const expectedCommands = ['settings','new','signin','clear','hide','update','rename','find','copy','export','gemini','startup','model','temp','chats','keys','discard'];
  check('all slash commands fit inside the native fitted viewport', slashBounds.items.length === expectedCommands.length && expectedCommands.every(name=>slashBounds.items.some(item=>item.command===name)) && slashBounds.top >= 27 && slashBounds.bottom <= slashBounds.height - 27 && slashBounds.items.every(r => r.top >= slashBounds.top && r.bottom <= slashBounds.bottom), JSON.stringify(slashBounds));
  await type('/se');
  const filtered = await evalJS(`[...document.querySelectorAll('#slash-menu [role=option]')].map(n=>n.dataset.command)`);
  check('slash menu filters as you type', filtered.length === 1 && filtered[0] === 'settings', filtered.join());
  check('slash menu is a listbox wired to the input', await evalJS(`document.getElementById('slash-menu').getAttribute('role')==='listbox' && document.getElementById('prompt-input').getAttribute('aria-activedescendant')==='slash-settings'`));
  await key('Enter');
  check('/settings opens the settings window', await evalJS(`__mock.settingsOpen===true && document.getElementById('prompt-input').value===''`));
  check('/settings is not sent as a prompt', await count('chat_send') === 0);
  await evalJS(`window.originalSettingsInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>cmd==='open_settings'?Promise.reject(new Error('native details')):window.originalSettingsInvoke(cmd,args)`);
  await type('/settings');
  await key('Enter');
  await until(`!document.getElementById('global-error').hidden`);
  check('/settings failure shows a friendly inline error', await evalJS(`document.getElementById('global-error-text').textContent==="Couldn't open settings. Try again." && document.getElementById('prompt-input').value===''`));
  await evalJS(`window.__TAURI__.core.invoke=window.originalSettingsInvoke;delete window.originalSettingsInvoke;document.getElementById('btn-error-dismiss').click()`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  await type('/');
  await key('ArrowDown');
  check('arrow keys move the selection', await evalJS(`document.getElementById('prompt-input').getAttribute('aria-activedescendant')==='slash-new'`));
  await key('Escape');
  await type('/foo');
  check('unknown command shows no menu', await evalJS(`document.getElementById('slash-menu').hidden`));
  await key('Enter');
  await sleep(20);
  check('unknown /foo is sent as a prompt', await evalJS(`__mock.last('chat_send')?.args.prompt==='/foo'`));
  await finishReply();
  const newBefore = await count('chat_new');
  await type('/new');
  await key('Enter');
  await sleep(30);
  const afterNew = await evalJS(`({bubble:!!document.querySelector('[data-role=assistant]'), tabs:document.querySelectorAll('#tabs .tab').length})`);
  check('/new starts a chat and files the old one as a tab', await count('chat_new') === newBefore + 1 && afterNew.tabs === 1, JSON.stringify(afterNew));
  await type('/clear');
  await key('Enter');
  check('/clear asks before clearing', await evalJS(`!document.getElementById('clear-confirm').hidden && document.querySelectorAll('#tabs .tab').length===1`));
  await key('Escape');
  check('Esc cancels the /clear confirmation', await evalJS(`document.getElementById('clear-confirm').hidden && document.querySelectorAll('#tabs .tab').length===1`));
  await type('/clear');
  await key('Enter');
  await evalJS(`document.getElementById('btn-clear-yes').click()`);
  check('/clear removes recent chats', await evalJS(`document.getElementById('tabs').hidden && JSON.parse(localStorage.getItem('qchat.chats')).recent.length===0`));
  await type('/hide');
  const hidesB = await count('hide_main');
  await key('Enter');
  check('/hide hides the window', await count('hide_main') === hidesB + 1);
  await type('/signin');
  await key('Enter');
  check('/signin opens sign-in', await count('show_signin') === 1);

  // --- Shortcuts ------------------------------------------------------------
  await open('/');
  await evalJS(`__mock.hold=true`);
  await send('stop me');
  await sleep(30);
  await key('.', { ctrlKey: true });
  await sleep(30);
  check('Ctrl+. stops', await count('chat_stop') === 1);
  await sleep(300);
  check('a stopped wait leaves no empty bubble', await evalJS(`!document.querySelector('[data-role=user]') && !document.querySelector('[data-role=assistant]')`));
  await evalJS(`__mock.hold=false`);
  await type(Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n'));
  await settle();
  const grown = await evalJS(`(()=>{const i=document.getElementById('prompt-input');const lh=parseFloat(getComputedStyle(i).lineHeight);const pad=parseFloat(getComputedStyle(i).paddingTop)*2;return {lines:(i.offsetHeight-pad)/lh, scrolls:getComputedStyle(i).overflowY};})()`);
  check('input grows to at most 6 lines, then scrolls', Math.round(grown.lines) === 6 && grown.scrolls === 'auto', JSON.stringify(grown));
  await type('');
  await settle();
  check('input shrinks back to one line', await evalJS(`document.getElementById('prompt-input').offsetHeight<=36`));
  await evalJS(`__mock.hold=true`);
  await send('A really long prompt '.repeat(40));
  await sleep(30);
  check('user bubble clamps to its line limit', await evalJS(`(()=>{const c=document.querySelector('.bubble-user .turn-content');return c.clientHeight<=parseFloat(getComputedStyle(c).lineHeight)*6+1 && c.scrollHeight>c.clientHeight;})()`));
  await key('.', { ctrlKey: true });
  await sleep(300);
  await evalJS(`__mock.hold=false`);
  await key('n', { ctrlKey: true });
  await sleep(20);
  check('Ctrl+N starts a new chat', await count('chat_new') === 1);
  await evalJS(`__mock.emit('qchat://new-chat', null)`);
  await sleep(20);
  check('tray new-chat event starts a new chat', await count('chat_new') === 2);
  await evalJS(`QSettings.apply(document.documentElement, {...QSettings.settings, sendKey:'ctrl'})`);
  const sendsBefore = await count('chat_send');
  await type('line one');
  await key('Enter');
  await sleep(20);
  check('Ctrl+Enter mode: Enter does not send', await count('chat_send') === sendsBefore);
  await key('Enter', { ctrlKey: true });
  await sleep(20);
  check('Ctrl+Enter mode: Ctrl+Enter sends', await count('chat_send') === sendsBefore + 1);

  // --- Tabs -----------------------------------------------------------------
  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN, 'Current chat'), chat('old', 'conv-old', 3 * DAY, 'Oldest chat'), chat('mid', 'conv-mid', 5 * HOUR, 'Middle chat'), chat('new', 'conv-new', 30 * MIN, 'A very recent chat')) });
  await settle();
  const tabInfo = () => evalJS(`[...document.querySelectorAll('#tabs .tab')].map(t=>({key:t.dataset.key,label:t.querySelector('.tab-label').textContent,disabled:t.disabled,ariaDisabled:t.getAttribute('aria-disabled'),title:t.title,logo:t.querySelector('svg.icon')?.dataset.provider}))`);
  let tabs = await tabInfo();
  check('exactly 3 tabs for 3 chats', tabs.length === 3);
  check('tabs are ordered most recent first', tabs.map((t) => t.key).join() === 'new,mid,old', tabs.map((t) => t.key).join());
  check('labels use m/h/d', tabs.map((t) => t.label).join() === '30m,5h,3d', tabs.map((t) => t.label).join());
  check('tabs use the provider logo', tabs.every((t) => t.logo === 'chatgpt'));
  check('tab tooltip has title and last active', tabs[0].title.includes('A very recent chat') && tabs[0].title.includes('Last active 30m ago'), tabs[0].title);
  check('recent chats show the title before the timestamp', await evalJS(`(()=>{const t=document.querySelector('#tabs .tab'),title=t.querySelector('.tab-title'),time=t.querySelector('.tab-label');return title?.textContent==='A very recent chat' && !!(title.compareDocumentPosition(time)&Node.DOCUMENT_POSITION_FOLLOWING);})()`));
  check('recent chats attach to the left of the composer with visible labels', await evalJS(`(()=>{const bar=document.getElementById('bar').getBoundingClientRect(),nav=document.getElementById('tabs').getBoundingClientRect(),tabs=[...document.querySelectorAll('#tabs .tab')];return Math.abs(tabs[0].getBoundingClientRect().left-bar.left)<30 && Math.abs(nav.bottom-bar.top)<4 && tabs.every(t=>{const title=t.querySelector('.tab-title').getBoundingClientRect(),time=t.querySelector('.tab-label').getBoundingClientRect();return title.bottom<=bar.top && time.bottom<=bar.top && document.elementFromPoint(title.left+2,title.top+2)?.closest('.tab')===t;});})()`));
  check('startup shows the previous reply as completed context', await evalJS(`document.querySelector('[data-role=assistant]')?.dataset.status==='done' && document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Cached reply for cur') && document.getElementById('btn-send').dataset.mode==='send'`));
  check('restored context has no stream or image generation animation', await evalJS(`document.querySelector('[data-role=assistant] .image-generation').hidden && !document.querySelector('[data-role=assistant]').classList.contains('swapping') && !document.querySelector('[data-role=assistant]').classList.contains('rising')`));
  check('no chat_open on launch', await count('chat_open') === 0);
  await evalJS(`(()=>{const real=Date.now;Date.now=()=>real()+40*60*1000;__mock.emit('qchat://shown',null);Date.now=real;})()`);
  check('labels refresh when shown', (await tabInfo())[0].label === '1h', (await tabInfo())[0].label);
  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('a', 'conv-a', 20 * 1000)) });
  check('labels show now under a minute', (await tabInfo())[0].label === 'now');
  await open('/', { settings:{barWidth:340}, chats:seeded(chat('cur','conv-current',MIN),chat('a','conv-a',MIN,'A long conversation title for testing'),chat('b','conv-b',HOUR,'Another long conversation title to shorten'),chat('c','conv-c',DAY,'😀'.repeat(12)+' a longer title')) });
  await settle();
  check('long recent titles are capped and keep the full accessible name', await evalJS(`(()=>{const tabs=[...document.querySelectorAll('#tabs .tab')];return tabs.every(t=>Array.from(t.querySelector('.tab-title').textContent).length<=24 && t.querySelector('.tab-title').textContent.endsWith('…')) && tabs[0].getAttribute('aria-label').includes('A long conversation title for testing');})()`));
  check('recent chats fit the narrow composer and contribute to window height', await evalJS(`(()=>{const s=document.getElementById('stack').getBoundingClientRect(),bar=document.getElementById('bar').getBoundingClientRect(),nav=document.getElementById('tabs').getBoundingClientRect();return [...document.querySelectorAll('#tabs .tab')].every(t=>{const r=t.getBoundingClientRect();return r.left>=s.left && r.right<=s.right+1 && r.top>=s.top && Math.abs(r.bottom-bar.top)<4;}) && nav.height>20 && __mock.fit.content>=document.getElementById('stack').offsetHeight+56;})()`));
  for (const zoom of [1, 1.5]) {
    check(`tabs touch bar at ${zoom * 100}% zoom`, await evalJS(`(()=>{document.body.style.zoom=${zoom};const b=document.getElementById('bar').getBoundingClientRect(),t=document.getElementById('tabs').getBoundingClientRect();document.body.style.zoom='';return Math.abs(b.top-t.bottom)<.6;})()`));
  }


  const restoredImageChat = { ...chat('image', 'conv-image', MIN), lastResponse: 'Previous image reply.\n\n![Generated image](qchat-media:qchat-media-old)', lastHasMedia: true };
  await open('/', { chats: seeded(restoredImageChat) });
  const restoredImage = await evalJS(`({text:document.querySelector('[data-role=assistant]')?.textContent,status:document.querySelector('[data-role=assistant]')?.dataset.status,loading:!document.querySelector('.image-generation')?.hidden,images:document.querySelectorAll('.media-preview img').length,action:!!document.querySelector('[data-action="view-media"], [data-action="signin"]')})`);
  check('restart restores image history as a completed reply with a view action', restoredImage.status==='done' && restoredImage.text.includes('Previous image reply.') && restoredImage.action && !restoredImage.loading && restoredImage.images===0, JSON.stringify(restoredImage));
  check('restart never loads expired media broker ids', await count('media_load')===0);
  check('restored history persists prose and a media hint without stale handles', await evalJS(`(()=>{const c=JSON.parse(localStorage.getItem('qchat.chats')).current;return c.lastHasMedia===true && c.lastResponse==='Previous image reply.' && !JSON.stringify(c).includes('qchat-media-old');})()`));
  const unchangedContext = await evalJS(`document.querySelector('[data-role=assistant] .turn-content').textContent`);
  await sleep(120);
  check('previous reply is not replayed through the character queue', await evalJS(`document.querySelector('[data-role=assistant] .turn-content').textContent===${JSON.stringify(unchangedContext)}`));
  await evalJS(`__mock.hold=true`);
  await send('Continue the same chat');
  await until(`__mock.last('chat_send')`);
  check('new send replaces restored context without inheriting its image', await evalJS(`!document.querySelector('.media-card') && document.querySelector('[data-role=assistant] .turn-content')?.textContent==='' && __mock.last('chat_open').args.conversationId==='conv-image'`));
  await key('.', { ctrlKey: true });
  await open('/', { chats: seeded({ ...restoredImageChat, lastResponse:'' }) });
  check('image-only history still restores completed conversation context', await evalJS(`document.querySelector('[data-role=assistant]')?.dataset.status==='done' && !!document.querySelector('[data-action="view-media"], [data-action="signin"]') && document.querySelector('.image-generation').hidden`));
  await evalJS(`document.querySelector('[data-action="view-media"]').click()`);
  await until(`__mock.count('show_signin')===1`);
  check('viewing a restored image opens its saved conversation first', await evalJS(`__mock.last('chat_open')?.args.conversationId==='conv-image' && __mock.calls.findIndex(c=>c.cmd==='chat_open')<__mock.calls.findIndex(c=>c.cmd==='show_signin')`));

  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN, 'Current'), chat('new', 'conv-new', 30 * MIN), chat('mid', 'conv-mid', 5 * HOUR), chat('old', 'conv-old', 3 * DAY)) });
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  await sleep(20);
  tabs = await tabInfo();
  check('clicking left-most puts the old chat at the front', tabs[0].key === 'cur' && tabs[0].label === 'now' && tabs.length === 3, JSON.stringify(tabs.map((t) => t.key)));
  check('switch shows the cached reply immediately', await evalJS(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Cached reply for new')`));
  check('switch calls chat_open for that chat', await evalJS(`__mock.last('chat_open')?.args.conversationId==='conv-new'`));
  await sleep(600);
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  await sleep(20);
  tabs = await tabInfo();
  check('clicking left-most again toggles back', tabs[0].key === 'new' && await evalJS(`__mock.last('chat_open')?.args.conversationId==='conv-current'`));
  await sleep(600);

  await evalJS(`__mock.hold=true`);
  await send('still here');
  await sleep(20);
  tabs = await tabInfo();
  check('tabs are disabled while waiting or streaming', tabs.length > 0 && tabs.every((t) => t.ariaDisabled === 'true' && !t.disabled) && await evalJS(`document.querySelector('#tabs .tab-all').disabled`));
  const opensBefore = await count('chat_open');
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  check('disabled tab does nothing', await count('chat_open') === opensBefore);
  check('send stays in the chat the page already holds', await evalJS(`__mock.last('chat_send')?.args.prompt==='still here'`) && await count('chat_open') === opensBefore);
  await evalJS(`__mock.hold=false; __mock.release&&__mock.release()`);

  // Readiness gate
  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('b', 'conv-b', 30 * MIN)) });
  await evalJS(`__mock.silentOpen=true; __mock.loggedIn=true; document.querySelector('#tabs .tab').click()`);
  await sleep(20);
  await send('wait for the page');
  await sleep(120);
  check('next send waits for bridge ready after a switch', await count('chat_send') === 0);
  check('waiting send shows the user bubble', await evalJS(`!!document.querySelector('[data-role=user]')`));
  await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:true,url:'https://chatgpt.com/'})`);
  await sleep(40);
  check('ready status for a different page does not release it', await count('chat_send') === 0);
  await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:true,url:'https://chatgpt.com/c/conv-b'})`);
  await sleep(40);
  check('ready status for the opened chat releases the send', await count('chat_send') === 1);
  await finishReply();

  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('b', 'conv-b', 30 * MIN)) });
  await evalJS(`__mock.silentOpen=true; __mock.loggedIn=true; __mock.openTimeout=120; document.querySelector('#tabs .tab').click()`);
  await sleep(10);
  await send('never opens');
  await until(`document.querySelector('[data-role=assistant] .error-text')`, 'open timeout error');
  check('open timeout gives a friendly error and restores the draft', await evalJS(`document.querySelector('.error-text').textContent.includes('taking too long') && document.getElementById('prompt-input').value==='never opens'`));
  check('never sends into the wrong conversation', await count('chat_send') === 0);

  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('b', 'conv-b', 30 * MIN)) });
  await evalJS(`__mock.failOpen='busy: page is responding'; document.querySelector('#tabs .tab').click()`);
  await sleep(10);
  await send('blocked');
  await until(`document.querySelector('[data-role=assistant] .error-text')`, 'busy error');
  check('chat_open errors map to friendly copy', await evalJS(`document.querySelector('.error-text').textContent==='ChatGPT is busy with another response.'`) && await count('chat_send') === 0);

  // Chats without a server id
  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('nul', null, 30 * MIN)) });
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  await sleep(40);
  check('null conversation shows its cached reply without chat_open', await evalJS(`!!document.querySelector('[data-role=assistant]')`) && await count('chat_open') === 0);
  await evalJS(`__mock.reply='ok'`);
  await send('continue here');
  await until(`__mock.count('chat_send')===1`, 'send after chat_new');
  const order = await evalJS(`__mock.calls.filter(c=>c.cmd==='chat_new'||c.cmd==='chat_send').map(c=>c.cmd).join()`);
  check('null conversation triggers chat_new before sending', order === 'chat_new,chat_send', order);
  await finishReply();
  await sleep(30);
  check('conversation id from done is stored', await evalJS(`/^conv-/.test(JSON.parse(localStorage.getItem('qchat.chats')).current.conversationId)`));
  await type('second message');
  await key('Enter');
  await sleep(30);
  check('next send stays in the same chat with no extra chat_new', await count('chat_new') === 1 && await count('chat_send') === 2);
  await finishReply();

  // Launch re-sync
  await open('/', { chats: seeded(chat('cur', 'conv-current', 5 * MIN)) });
  await evalJS(`__mock.reply='synced'`);
  await send('after restart');
  await until(`__mock.count('chat_send')===1`, 'lazy open');
  check('current chat re-syncs lazily on next send', await evalJS(`__mock.last('chat_open')?.args.conversationId==='conv-current'`));
  await finishReply();

  // Cap and history
  await open('/');
  await evalJS(`__mock.reply='r'; __mock.interval=2`);
  for (let i = 0; i < 5; i++) {
    await send(`chat number ${i}`);
    await finishReply();
    await type('/new');
    await key('Enter');
    await sleep(40);
  }
  const stored = await evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  check('recent list retains five chats, newest first', stored.recent.length === 5 && stored.recent[0].title === 'chat number 4' && stored.v === 1, JSON.stringify(stored.recent.map((c) => c.title)));
  check('stored chats have the agreed shape', ['key', 'conversationId', 'title', 'lastActive', 'lastPrompt', 'lastResponse', 'createdAt'].every((k) => k in stored.recent[0]));
  await evalJS(`__mock.reply=null`);
  await open('/', { chats: { v: 1, current: chat('c', 'conv-c', MIN), recent: [{ ...chat('big', 'conv-big', MIN), lastResponse: 'x'.repeat(200000) }] } });
  check('long stored conversation remains available on load', await evalJS(`document.querySelectorAll('#tabs .tab').length===1`));
  await evalJS(`document.querySelector('#tabs .tab').click()`);
  await sleep(20);
  check('stored reply and transcript preserve the complete long response', await evalJS(`(()=>{const c=JSON.parse(localStorage.getItem('qchat.chats')).current;return c.lastResponse.length===200000 && c.transcript.find(t=>t.role==='assistant').text.length===200000;})()`));

  await cdp('Page.navigate', { url: `${base}/` });
  await until(`document.readyState==='complete'`);
  await evalJS(`localStorage.clear(); localStorage.setItem('qchat.chats','{not json')`);
  await cdp('Page.navigate', { url: `${base}/` });
  await until(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
  await sleep(40);
  check('corrupt chat history falls back to empty', await evalJS(`document.getElementById('tabs').hidden`));

  await open('/', { settings: { keepHistory: false }, chats: seeded(chat('cur', 'conv-current', 5 * MIN), chat('a', 'conv-a', MIN)) });
  check('keepHistory off stores nothing and hides tabs', await evalJS(`document.getElementById('tabs').hidden && localStorage.getItem('qchat.chats')===null`));
  await evalJS(`__mock.reply='x'; __mock.interval=2`);
  await send('private');
  await finishReply();
  check('keepHistory off still chats but saves nothing', await evalJS(`localStorage.getItem('qchat.chats')===null`));

  // --- Settings -------------------------------------------------------------
  await open('/', { settings: '{definitely not json' });
  check('corrupt settings JSON falls back to defaults', await evalJS(`JSON.stringify(QSettings.settings)===JSON.stringify(QSettings.DEFAULTS)`));
  await open('/', { settings: { v: 2, cornerWeight: 900, glassOpacity: -4, blur: 'nope', look: 'hotdog', density: 12, speed: 0, unknownKey: 'x', accentColor: 'red', showTabs: 'yes', barWidth: 345 } });
  const clamped = await evalJS(`QSettings.settings`);
  check('settings are validated and clamped', clamped.cornerWeight === 100 && clamped.glassOpacity === 20 && clamped.blur === 40 && clamped.look === 'aurora' && clamped.density === 'cozy' && clamped.speed === 0.4 && clamped.accentColor === '#7C5CFF' && clamped.showTabs === true && clamped.barWidth === 350 && !('unknownKey' in clamped), JSON.stringify(clamped));
  check('saved settings apply before first paint', await evalJS(`document.documentElement.style.getPropertyValue('--r-bubble')==='32px'`));
  await open('/');
  const r0 = await cssVar('--r-bubble');
  await evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.DEFAULTS, cornerWeight:0, glassOpacity:40, animations:'off', barWidth:700, alwaysOnTop:false})`);
  await settle();
  check('live apply: bar corners preserve independent chat corners', r0 === await cssVar('--r-bubble') && await cssVar('--r-bar') === '6.0px');
  check('live apply: opacity respects the legibility floor', await evalJS(`QSettings.settings.glassOpacity===40 && +document.documentElement.style.getPropertyValue('--glass-a')>=.4 && +document.documentElement.style.getPropertyValue('--glass-a')<1`));
  check('live apply: animations off zero the durations', await cssVar('--t4') === '1ms' && await evalJS(`document.documentElement.dataset.motion`) === 'off');
  check('live apply: bar width reaches fit_window', await evalJS(`__mock.fit.width`) === 756);
  check('live apply: window prefs follow', await evalJS(`__mock.last('set_window_prefs').args.alwaysOnTop`) === false);
  await evalJS(`localStorage.setItem('qchat.settings', JSON.stringify({v:1, cornerWeight:100}));window.dispatchEvent(new StorageEvent('storage',{key:'qchat.settings'}))`);
  await sleep(30);
  check('storage event also applies settings', await cssVar('--r-bubble') === '32px');
  await evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.DEFAULTS, speed:2, feel:'springy'})`);
  const t2 = await cssVar('--t4');
  await evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.DEFAULTS, speed:0.5, feel:'springy'})`);
  check('speed scales every duration', t2 === '280ms' && await cssVar('--t4') === '1120ms', `${t2} ${await cssVar('--t4')}`);
  check('springy feel uses a linear() spring', (await cssVar('--ease-move')).startsWith('linear('));
  await evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.DEFAULTS, feel:'snappy'})`);
  check('snappy feel uses another curve', (await cssVar('--ease-move')).startsWith('cubic-bezier'));

  // Legibility over any wallpaper
  const contrastReport = await evalJS(`(()=>{
    const out=[]; const parse=(v)=>v.trim().split(/\\s+/).map(Number);
    const lum=(c)=>{const [r,g,b]=c.map(x=>{x/=255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4});return .2126*r+.7152*g+.0722*b;};
    const ratio=(a,b)=>{const l=lum(a),m=lum(b);return (Math.max(l,m)+.05)/(Math.min(l,m)+.05);};
    const over=(f,a,b)=>f.map((c,i)=>c*a+b[i]*(1-a));
    for(const look of Object.keys(QSettings.LOOKS)) for(const glassOpacity of [20,72,100]) {
      QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,look,glassOpacity});
      const st=document.documentElement.style; const ink=parse(st.getPropertyValue('--ink'));
      const a=+st.getPropertyValue('--glass-solid'); const tintedA=+st.getPropertyValue('--tinted-alpha');
      for(const pair of [['--tint-a','--tint-b'],['--user-a','--user-b'],['--error-a','--error-b']]) for(const name of pair) for(const back of [[255,255,255],[0,0,0]]) {
        const fill=over(parse(st.getPropertyValue(name)),name.startsWith('--tint')?a:tintedA,back);
        const main=ratio(ink,fill), second=ratio(over(ink,.86,fill),fill);
        if(main<4.5||second<4.5) out.push([look,glassOpacity,name,back[0],main.toFixed(2),second.toFixed(2)].join(' '));
      }
      for(const name of ['--accent-text','--critical-text']) { const hex=st.getPropertyValue(name).trim(); const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
        for(const tint of ['--tint-a','--tint-b']) for(const back of [[255,255,255],[0,0,0]]) { const r=ratio(c,over(parse(st.getPropertyValue(tint)),a,back)); if(r<4.5) out.push([look,glassOpacity,name,back[0],r.toFixed(2)].join(' ')); } }
    }
    QSettings.apply(document.documentElement,QSettings.DEFAULTS);
    return out;
  })()`);
  check('text reaches 4.5:1 on white and black at any opacity, in every look', contrastReport.length === 0, contrastReport.slice(0, 6).join(' | '));
  check('all looks present', await evalJS(`['system','aurora','frost','sunset','sakura','forest','graphite','ink','candy'].every(k=>QSettings.LOOKS[k])`));
  check('glass has no inner scrim', await evalJS(`getComputedStyle(document.querySelector('.glass'),'::before').content==='none'`));
  await evalJS(`QSettings.apply(document.documentElement,QSettings.DEFAULTS)`);

  // Shadows inside the gutter at full strength
  const shadowFits = await evalJS(`(()=>{QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,shadow:100});const s=document.documentElement.style;const y=parseFloat(s.getPropertyValue('--shadow-y')),r=parseFloat(s.getPropertyValue('--shadow-r'));QSettings.apply(document.documentElement,QSettings.DEFAULTS);return y+r-4<=28;})()`);
  check('strongest shadow fits in the 28px gutter', shadowFits);

  await open('/');
  check('send hidden when empty', await evalJS(`getComputedStyle(document.getElementById('btn-send')).opacity==='0'`));
  await type('Hello'); await sleep(200);
  check('send visible with text', await evalJS(`!document.getElementById('btn-send').disabled && getComputedStyle(document.getElementById('btn-send')).opacity==='1'`));
  // Settings window
  await open('/settings.html');
  await settle();
  check('settings window loads in mock mode', await evalJS(`document.querySelectorAll('.section').length===13 && !!document.getElementById('sheet')`));
  check('settings has the required sections', await evalJS(`['General','Window','Shortcuts','Presets','Colours','Glass & shape','Text','Bar & tabs','Chat','Motion & streaming','Accounts','Chats & privacy','About'].every(t=>[...document.querySelectorAll('.section-title')].some(n=>n.textContent===t))`));
  const allKeys = await evalJS(`Object.keys(QSettings.SCHEMA).filter(k=>!['look','streamStyle','streamSpeed'].includes(k)&&!document.querySelector('.row[data-key="'+k+'"]'))`);
  check('every active setting has a control', allKeys.length === 0, allKeys.join());
  check('obsolete streaming controls are absent',await evalJS(`!document.querySelector('.row[data-key="streamStyle"],.row[data-key="streamSpeed"]')`));
  await evalJS(`document.getElementById('control-cornerWeight').value=10; document.getElementById('control-cornerWeight').dispatchEvent(new Event('input',{bubbles:true}))`);
  await sleep(160);
  check('a control change persists', await evalJS(`JSON.parse(localStorage.getItem('qchat.settings')).cornerWeight`) === 10);
  check('a control change applies live here', await cssVar('--r-bar') === '8.1px' && await cssVar('--r-bubble') === '20px', await cssVar('--r-bar'));
  check('a control change is relayed to the chat window', await evalJS(`__mock.calls.filter(c=>c.cmd==='emit:qchat://settings-changed').at(-1)?.args.cornerWeight`) === 10);
  check('changed control offers a reset', await evalJS(`document.querySelector('.row[data-key=cornerWeight]').hasAttribute('data-changed')`));
  await evalJS(`document.querySelector('.row[data-key=cornerWeight] .row-reset').click()`);
  check('per-control reset restores the default', await evalJS(`JSON.parse(localStorage.getItem('qchat.settings')).cornerWeight`) === 85);
  await evalJS(`document.querySelector('[data-look=frost]').click(); document.querySelector('.row[data-key=shimmer] .switch').click(); document.querySelector('.row[data-key=feel] [data-value=snappy]').click()`);
  const toggled = await evalJS(`JSON.parse(localStorage.getItem('qchat.settings'))`);
  check('look, switch and segmented controls work', toggled.look === 'frost' && toggled.shimmer === true && toggled.feel === 'snappy');
  await evalJS(`document.getElementById('btn-reset-all').click()`);
  check('reset all asks first', await evalJS(`!document.getElementById('btn-reset-confirm').hidden && JSON.parse(localStorage.getItem('qchat.settings')).look==='frost'`));
  await evalJS(`document.getElementById('btn-reset-confirm').click()`);
  check('reset all restores everything', await evalJS(`(({v,...rest})=>JSON.stringify(rest))(JSON.parse(localStorage.getItem('qchat.settings')))===JSON.stringify(QSettings.DEFAULTS)`));
  await evalJS(`document.getElementById('btn-reset-position').click()`);
  check('reset position calls native', await count('reset_position') === 1);
  await evalJS(`document.getElementById('btn-signin').click()`);
  check('sign in calls native', await count('show_signin') === 1);
  await sleep(50);
  check('account status follows the bridge', await evalJS(`document.getElementById('account-status').textContent==='Signed in' && document.getElementById('btn-signin').textContent==='Manage account'`));
  await evalJS(`document.getElementById('btn-quit').click()`);
  check('quit calls native', await count('quit_app') === 1);
  await evalJS(`document.getElementById('btn-clear-chats').click(); document.getElementById('btn-clear-chats').click()`);
  check('clear chats relays to the chat window', await evalJS(`__mock.calls.some(c=>c.cmd==='emit:qchat://clear-chats')`));
  await evalJS(`document.querySelector('[data-section=about]').click()`);
  await sleep(100);
  check('settings has no preview', await evalJS(`!document.querySelector('.preview,#btn-replay')`));
  await evalJS(`document.getElementById('btn-close').click()`);
  check('close button calls close_settings', await count('close_settings') === 1);
  await key('Escape');
  check('Esc closes settings', await count('close_settings') === 2);

  // --- Rendering safety -----------------------------------------------------
  await open('/');
  await evalJS(`__mock.interval=2`);
  await send('xss');
  await finishReply();
  check('xss prompt renders as text', await evalJS(`!document.querySelector('.turn-content img') && !document.querySelector('.turn-content script') && document.querySelector('[data-role=assistant] .turn-content').textContent.includes('<img src=x onerror=alert(1)>')`));
  await type('hello');
  await key('Enter');
  await finishReply();
  check('canned reply renders code, table and link', await evalJS(`!!document.querySelector('.code-block pre code') && !!document.querySelector('.turn-content table') && !!document.querySelector('.turn-content a[href^="https://developer.mozilla.org"]')`));
  await evalJS(`document.querySelector('.turn-content a').click()`);
  check('links go through open_external', await evalJS(`__mock.last('open_external')?.args.url.startsWith('https://developer.mozilla.org')`));
  check('hover tools are labelled and at least 28px', await evalJS(`[...document.querySelectorAll('.bubble-tools button')].every(b=>b.getAttribute('aria-label')&&b.offsetHeight>=28)`));
  check('response zone is a quiet log with its own announced status', await evalJS(`document.getElementById('bubble-zone').getAttribute('role')==='log' && document.getElementById('bubble-zone').getAttribute('aria-live')==='off'`));
  await evalJS(`document.querySelector('[data-action=dismiss-turn]').click()`);
  await sleep(10);
  check('dismiss button removes the reply', await evalJS(`!document.querySelector('[data-role=assistant]')`));

  await open('/?mock=error');
  await send('anything');
  await until(`document.querySelector('.error-text')`, 'error bubble');
  check('errors show a small red bubble with friendly copy', await evalJS(`document.querySelector('.error-text').textContent==="You've hit ChatGPT's usage limit for now." && document.querySelector('[data-role=assistant]').hasAttribute('data-empty')`));
  await open('/');
  await send('auth');
  await until(`document.querySelector('.error-text')`, 'auth bubble');
  check('auth errors offer Sign in', await evalJS(`[...document.querySelectorAll('.error-actions button')].some(b=>b.textContent==='Sign in')`));
  await open('/?mock=media');
  await send('picture please');
  await until(`document.querySelector('.media-preview img')`, 'mock media');
  check('media variant still renders cards', await evalJS(`document.querySelectorAll('.media-card').length===2`));

  await open('/');
  await evalJS(`__mock.emit('qchat://shown',null); QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,showSuggestions:true}); __mock.emit('qchat://settings-changed',{...QSettings.DEFAULTS,showSuggestions:true})`);
  await sleep(30);
  check('suggestion chips respect the setting', await evalJS(`!document.getElementById('suggestions').hidden`));
  await evalJS(`__mock.emit('qchat://settings-changed',QSettings.DEFAULTS)`);
  await sleep(30);
  check('suggestion chips are off by default', await evalJS(`document.getElementById('suggestions').hidden`));

  // --- Reduced motion and transparency ---------------------------------------
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await open('/');
  check('reduced motion turns motion off by default', await evalJS(`document.documentElement.dataset.motion`) === 'off' && await cssVar('--t3') === '1ms');
  await type('One\nTwo\nThree');
  check('reduced motion resizes the composer immediately', await evalJS(`(()=>{const i=document.getElementById('prompt-input');const s=getComputedStyle(i);return s.transitionDuration==='0s' && i.offsetHeight>=3*parseFloat(s.lineHeight);})()`));
  await type('');
  await evalJS(`__mock.interval=2`);
  await send('hi');
  await finishReply();
  check('reduced motion: no entrance animations run', await evalJS(`getComputedStyle(document.querySelector('[data-role=assistant]')).animationName==='none' && document.getAnimations().filter(a=>a.playState==='running'&&a.effect.getTiming().iterations===Infinity).length===0`));
  await key('Escape');
  check('reduced motion: dismiss is immediate', await evalJS(`!document.querySelector('.turn-row')`));
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.DEFAULTS,animations:'on'})`);
  check('animations can be forced on over the OS setting', await evalJS(`document.documentElement.dataset.motion`) === 'on');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await open('/', { settings: { glassOpacity: 30, blur: 30 } });
  const lessGlass = await evalJS(`matchMedia('(prefers-reduced-transparency: reduce)').matches`);
  if (lessGlass) check('reduced transparency raises opacity and drops blur', await cssVar('--glass-a') === '0.960' && await cssVar('--blur') === '0px');
  else console.log('SKIP reduced transparency emulation is not available in this browser build');
  await cdp('Emulation.setEmulatedMedia', { features: [] });

  check('no console errors or exceptions', problems.length === 0, problems.slice(0, 5).join(' | '));

  // --- Screenshots ----------------------------------------------------------
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    const shot = async (name) => {
      const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
    };
    const viewport = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    const fitViewport = async () => { const f = await evalJS(`__mock.fit`); await viewport(f.width, f.height); await sleep(50); };
    const threeTabs = () => seeded(chat('cur', 'conv-current', 5 * MIN), chat('new', 'conv-new', 30 * MIN, 'Debounce helper'), chat('mid', 'conv-mid', 5 * HOUR, 'Trip ideas'), chat('old', 'conv-old', 3 * DAY, 'Résumé edits'));
    const pauseAll = () => evalJS(`document.getAnimations().forEach(a=>a.pause())`);

    const scene = async ({ name, settings = {}, chats, url = '/', wall }) => {
      await viewport(516, 900);
      await open(url, { settings, chats });
      if (wall) await evalJS(`document.documentElement.classList.add('wall-light')`);
      await evalJS(`if(!document.getElementById('guest-notice').hidden) document.getElementById('btn-guest-dismiss').click()`);
      return name;
    };

    await scene({ name: 'idle', chats: threeTabs() }); await settle(); await fitViewport(); await shot('01-idle-3-tabs');

    for (const command of ['chats', 'model', 'keys']) {
      await type('/' + command); await key('Enter'); await sleep(120); await fitViewport(); await shot('feature-' + command); await key('Escape');
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 900, deviceScaleFactor: 3, mobile: false });
    await scene({ name: 'tabs-zoom', chats: threeTabs() }); await settle(); await fitViewport();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 250, deviceScaleFactor: 3, mobile: false }); await shot('feature-tabs-3x');

    await scene({ name: 'rise', chats: threeTabs(), settings: { speed: 0.4 } });
    await evalJS(`__mock.hold=true`);
    await send('Can you write me a tiny debounce helper in JavaScript?');
    await sleep(130); await pauseAll(); await sleep(60);
    await viewport(516, (await evalJS(`document.getElementById('stack').offsetHeight`)) + 56);
    await sleep(40); await shot('02-user-bubble-rising');
    await evalJS(`document.getAnimations().filter(a=>!a.animationName?.includes('dot')).forEach(a=>a.finish())`); await sleep(60);
    await evalJS(`document.getAnimations().forEach(a=>a.play())`); await sleep(500); await fitViewport(); await shot('03-user-bubble-thinking');

    await scene({ name: 'stream', chats: threeTabs() });
    await evalJS(`__mock.interval=60`);
    await send('debounce please');
    await until(`(document.querySelector('.bubble-inner')?.offsetHeight||0)>120`, 'partial growth', 800);
    await fitViewport(); await sleep(30); await shot('04-streaming-partial');
    await finishReply(); await settle(); await fitViewport(); await shot('05-done-canned');

    await scene({ name: 'long', chats: threeTabs() });
    await viewport(516, 760);
    await evalJS(`__mock.interval=1`);
    await send('long');
    await finishReply(); await settle();
    await fitViewport();
    await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');s.scrollTop=s.scrollHeight/2;s.dispatchEvent(new Event('scroll'));})()`);
    await sleep(60); await shot('06-long-capped-scrollbar');

    await scene({ name: 'slash', chats: threeTabs() });
    await type('/'); await settle(); await fitViewport(); await shot('07-slash-menu');
    await type('/se'); await settle(); await fitViewport(); await shot('08-slash-filtered');

    await scene({ name: 'multi', chats: threeTabs() });
    await type(['Could you turn these notes into a short email?', '', '- launch moved to Tuesday', '- Sam owns the checklist', '- budget stays the same'].join('\n'));
    await evalJS(`(()=>{const d=new DataTransfer();d.items.add(new File([new Uint8Array(2048)],'meeting-notes.txt'));d.items.add(new File([new Uint8Array(900000)],'budget-2026.xlsx'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'));})()`);
    await until(`document.querySelectorAll('#attachments [data-state=ready]').length===2`); await settle(); await fitViewport(); await shot('11-multiline-attachments');
    await evalJS(`document.getElementById('prompt-input').value=''`);

    await scene({ name: 'tools', chats: threeTabs() });
    await evalJS(`__mock.reply='Sure. **Tuesday** works, and I moved the checklist over to Sam.'; __mock.interval=2`);
    await send('ok'); await finishReply(); await settle(); await fitViewport();
    await evalJS(`document.querySelector('.bubble-tools').style.cssText='opacity:1;transform:none'`); await sleep(40); await shot('12-short-reply-tools');

    await scene({ name: 'error', url: '/?mock=error', chats: threeTabs() });
    await send('anything'); await until(`document.querySelector('.error-text')`); await settle(); await fitViewport(); await shot('09-error-bubble');

    await viewport(516, 900);
    await open('/', {});
    await until(`!document.getElementById('guest-notice').hidden`);
    await settle(); await fitViewport(); await shot('10-guest-chip');

    for (const look of ['aurora', 'frost', 'sunset', 'sakura', 'forest', 'graphite', 'ink', 'candy']) {
      await scene({ name: look, settings: { look }, chats: threeTabs(), wall: look === 'frost' });
      await evalJS(`__mock.interval=1`);
      await send('debounce please'); await finishReply(); await settle(); await fitViewport(); await shot(`20-look-${look}`);
    }
    for (const weight of [0, 100]) {
      await scene({ name: 'c', settings: { cornerWeight: weight }, chats: threeTabs() });
      await evalJS(`__mock.interval=1`);
      await send('debounce please'); await finishReply(); await settle(); await fitViewport(); await shot(`30-corner-${weight}`);
    }
    await scene({ name: 'o', settings: { glassOpacity: 20 }, chats: threeTabs() });
    await evalJS(`__mock.interval=1`);
    await send('debounce please'); await finishReply(); await settle(); await fitViewport(); await shot('31-opacity-20');

    await viewport(620, 720);
    await open('/settings.html'); await settle(); await shot('40-settings-top');
    for (const section of ['appearance', 'motion', 'text', 'behavior', 'chats', 'account', 'about']) {
      await evalJS(`document.querySelector('[data-section=${section}]').click()`); await sleep(120); await shot(`41-settings-${section}`);
    }
    await open('/settings.html', { settings: { look: 'frost' } }); await evalJS(`document.documentElement.classList.add('wall-light')`); await settle(); await shot('42-settings-frost');
    await open('/settings.html', { settings: { look: 'sakura', cornerWeight: 10 } }); await settle(); await shot('43-settings-sakura-square');
    console.log(`Screenshots: ${shotsDir}`);
    if (problems.length) { console.log(`Console problems during screenshots: ${problems.slice(0, 3).join(' | ')}`); failed++; }
  }
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-glass-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
