// Idle-collapse checks in an isolated, invisible Edge profile. Mock backend only: no account,
// no site access, no OS-level input. Window focus is simulated by stubbing document.hasFocus and
// dispatching blur/focus. `--shots <dir>` also captures review PNGs of each stage.
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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-collapse-ui-'));
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
  ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(process.platform === 'win32' ? [] : ['--no-sandbox']), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({collapse:document.documentElement.dataset.collapse,focused:window.__focused,bar:document.getElementById('bar').getBoundingClientRect().width,status:document.querySelector('[data-role=assistant]')?.dataset.status})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const QCHAT_SETTINGS_V = 4;
  const MIN = 60 * 1000;
  const chat = (key, conv, ago) => ({ key, conversationId: conv, title: key, lastActive: Date.now() - ago, lastPrompt: `prompt ${key}`, lastResponse: `Cached **reply** for ${key}`, createdAt: Date.now() - ago });
  const recent = { v: 1, current: { key: 'now', conversationId: null, title: '', lastActive: Date.now(), createdAt: Date.now() }, recent: [chat('Trip ideas', 'c-1', 5 * MIN), chat('Regex help', 'c-2', 30 * MIN)] };
  const open = async (settings = {}, { chats = recent } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify({ v: QCHAT_SETTINGS_V, animations: 'on', autoDismiss: 0, speed: 2, idleCollapse: 1, ...settings }))})`);
    if (chats) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete' && window.QSettings && window.QCollapse`);
    await cdp('Page.bringToFront');
    // The page cannot lose real OS focus here, so focus is a flag the test flips.
    await evalJS(`window.__focused=true;document.hasFocus=()=>window.__focused;window.__drags=0;window.__TAURI__.window={getCurrentWindow:()=>({startDragging:async()=>{window.__drags++;}})}`);
    await mouse('mouseMoved', 4, 4);
    await sleep(60);
  };
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
  const blur = () => evalJS(`window.__focused=false;window.dispatchEvent(new Event('blur'))`);
  const focus = () => evalJS(`window.__focused=true;window.dispatchEvent(new Event('focus'))`);
  const state = () => evalJS(`document.documentElement.dataset.collapse||'open'`);
  const rect = (sel) => evalJS(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2,bottom:r.bottom}})()`);
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settings = (patch) => evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,...${JSON.stringify(patch)}}))`);
  const folded = () => until(`document.documentElement.dataset.collapse==='closed'`, 'folded', 500);
  const opened = () => until(`!document.documentElement.dataset.collapse`, 'opened', 300);
  // Visible on screen, counting visibility and opacity, as the hit-test pass does.
  const shown = (sel) => evalJS(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return !!n&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})})()`);
  const frames = (ms) => evalJS(`new Promise(resolve=>{const out=[];const start=performance.now();
    function sample(now){const b=document.getElementById('bar').getBoundingClientRect();out.push({t:now-start,w:b.width,h:b.height,s:document.documentElement.dataset.collapse||'open',z:+getComputedStyle(document.getElementById('bubble-zone')).opacity});
      if(now-start<${ms})requestAnimationFrame(sample);else resolve(out);}
    requestAnimationFrame(sample);})`);
  const shot = async (name) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // --- Defaults ------------------------------------------------------------------------------
  await cdp('Page.navigate', { url: `${base}/` });
  await until(`document.readyState==='complete' && window.QSettings`);
  await evalJS(`localStorage.clear()`);
  check('idle collapse defaults to five seconds', await evalJS(`QSettings.DEFAULTS.idleCollapse===5 && QSettings.sanitize({}).idleCollapse===5`));
  check('idle collapse is a behaviour setting that presets keep', await evalJS(`!QSettings.APPEARANCE_KEYS.includes('idleCollapse') && QSettings.applyPreset({...QSettings.DEFAULTS,idleCollapse:12},'compact').idleCollapse===12`));

  // --- Fold after the delay ------------------------------------------------------------------
  await open();
  await send('Collapse fixture');
  await finishReply();
  await type('A draft that survives\nthe fold');
  await sleep(250);
  const before = { reply: await rect('.bubble-response'), bar: await rect('#bar'), orb: await rect('#orb'), input: await rect('#prompt-input'), fits: await evalJS(`__mock.fits.length`), lastFit: await evalJS(`JSON.stringify(__mock.fit)`) };
  check('tabs and reply are on screen before folding', await shown('.tab') && await shown('.bubble-response'));
  await shot('1-open');
  const t0 = Date.now();
  await blur();
  await sleep(700);
  check('stays open inside the idle delay', await state() === 'open');
  const foldFrames = await frames(900);
  await folded();
  const elapsed = Date.now() - t0;
  check('folds after the idle delay', elapsed >= 1000 && elapsed < 2200, `${elapsed}ms`);
  const closingWidths = foldFrames.filter((f) => f.s === 'closing').map((f) => f.w);
  check('fold animates the bar through intermediate widths', closingWidths.some((w) => w > 60 && w < before.bar.w - 40), JSON.stringify(closingWidths.map(Math.round)));
  check('bar only narrows while folding', closingWidths.every((w, i) => i === 0 || w <= closingWidths[i - 1] + 0.5), JSON.stringify(closingWidths.map(Math.round)));
  const shut = { bar: await rect('#bar'), orb: await rect('#orb') };
  check('folded bar is a circle the height of the bar', Math.abs(shut.bar.w - 44) < 0.5 && Math.abs(shut.bar.h - 44) < 0.5 && await evalJS(`getComputedStyle(document.getElementById('bar')).borderTopLeftRadius==='50%'`), JSON.stringify(shut.bar));
  check('orb sits centred in the circle', Math.abs(shut.orb.cx - shut.bar.cx) < 0.6 && Math.abs(shut.orb.cy - shut.bar.cy) < 0.6, `${JSON.stringify(shut.orb)} ${JSON.stringify(shut.bar)}`);
  check('orb stays where it was; the bar folds into it', Math.abs(shut.orb.cx - before.orb.cx) < 0.6 && Math.abs(shut.orb.cy - before.orb.cy) < 0.6);
  check('folded bar keeps its bottom edge', Math.abs(shut.bar.bottom - before.bar.bottom) < 0.6);
  check('reply, tabs and composer controls are hidden', !await shown('.bubble-response') && !await shown('.tab') && !await shown('#prompt-input') && !await shown('#btn-attach') && await shown('#orb'));
  check('window is not resized by folding', await evalJS(`JSON.stringify(__mock.fit)`) === before.lastFit);
  await sleep(120);
  const hit = await evalJS(`__mock.last('surfaces_set')?.args.rects`);
  check('only the folded circle hit-tests and blurs', hit?.length === 1 && Math.abs(hit[0].w - 44) < 0.6 && Math.abs(hit[0].r - 22) < 0.6 && hit[0].b === true, JSON.stringify(hit));
  check('reply is kept while folded', await evalJS(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.length>40`));
  check('reply keeps its height behind the fold', Math.abs((await rect('.bubble-response')).h - before.reply.h) < 0.5);
  await shot('3-folded');

  // --- Click opens it ------------------------------------------------------------------------
  await mouse('mouseMoved', shut.bar.cx, shut.bar.cy);
  await focus(); // clicking an inactive window activates it before the press arrives
  await sleep(60);
  check('a focus that comes with a press on the orb waits for the click', await state() === 'closed');
  await mouse('mousePressed', shut.bar.cx, shut.bar.cy);
  await mouse('mouseReleased', shut.bar.cx, shut.bar.cy);
  const openFrames = await frames(700);
  await opened();
  const openingWidths = openFrames.filter((f) => f.s === 'opening').map((f) => f.w);
  check('click on the folded orb opens it with an animation', openingWidths.some((w) => w > 60 && w < before.bar.w - 40), JSON.stringify(openingWidths.map(Math.round)));
  check('reply fades back in while opening', openFrames.some((f) => f.s === 'opening' && f.z > 0.05 && f.z < 0.95));
  const reopened = { bar: await rect('#bar'), input: await rect('#prompt-input') };
  check('bar returns to its full size', Math.abs(reopened.bar.w - before.bar.w) < 0.5 && Math.abs(reopened.bar.h - before.bar.h) < 0.5, `${JSON.stringify(reopened.bar)} vs ${JSON.stringify(before.bar)}`);
  check('composer is focused with the draft intact', await evalJS(`document.activeElement===document.getElementById('prompt-input') && document.getElementById('prompt-input').value==='A draft that survives\\nthe fold'`));
  check('draft keeps its height', Math.abs(reopened.input.h - before.input.h) < 0.5, `${reopened.input.h} vs ${before.input.h}`);
  check('reply and tabs are back', await shown('.bubble-response') && await shown('.tab') && await shown('#btn-attach'));
  check('reply opens at the height it had', Math.abs((await rect('.bubble-response')).h - before.reply.h) < 0.5);
  check('no animations are left behind', await evalJS(`document.getAnimations().filter(a=>a.playState!=='finished'&&a.effect?.getTiming().iterations!==Infinity).length===0 && !document.getElementById('bar').getAnimations().length`));

  // --- Drag moves it folded ------------------------------------------------------------------
  await mouse('mouseMoved', 4, 4);
  await blur();
  await folded();
  await mouse('mouseMoved', shut.bar.cx, shut.bar.cy);
  await focus();
  await mouse('mousePressed', shut.bar.cx, shut.bar.cy);
  await mouse('mouseMoved', shut.bar.cx + 20, shut.bar.cy - 12, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', shut.bar.cx + 20, shut.bar.cy - 12);
  await sleep(500);
  check('dragging the folded orb moves the window and leaves it folded', await evalJS(`window.__drags`) === 1 && await state() === 'closed');

  // --- Other ways back -----------------------------------------------------------------------
  await mouse('mouseMoved', 4, 4);
  await key('a');
  await opened();
  check('a key press on the folded window opens it', await evalJS(`document.activeElement===document.getElementById('prompt-input')`));
  await blur();
  await folded();
  await focus();
  await sleep(30);
  check('focus from the shortcut or tray opens it at once', await state() === 'opening' || await state() === 'open');
  await opened();

  // --- Reverse mid-fold ----------------------------------------------------------------------
  await blur();
  await until(`document.documentElement.dataset.collapse==='closing' && document.getElementById('bar').getBoundingClientRect().width<300`, 'mid-fold', 300);
  await shot('2-folding');
  const mid = (await rect('#bar')).w;
  await focus();
  const reverse = await frames(120);
  check('coming back mid-fold reverses from where it is', reverse[0].s === 'opening' && Math.abs(reverse[0].w - mid) < 40, `${mid} -> ${JSON.stringify(reverse.slice(0, 3))}`);
  await opened();
  check('reversal ends at full size', Math.abs((await rect('#bar')).w - before.bar.w) < 0.5);

  // --- Opening animation screenshot ----------------------------------------------------------
  await blur();
  await folded();
  await focus();
  await sleep(110);
  await shot('4-opening');
  await opened();

  // --- Things that keep it open --------------------------------------------------------------
  await evalJS(`__mock.hold=true`);
  await send('Streaming fixture');
  await until(`__mock.last('chat_send') && document.getElementById('btn-send').dataset.mode==='stop'`, 'streaming');
  await blur();
  await sleep(1500);
  check('never folds while a reply is streaming', await state() === 'open');
  await evalJS(`__mock.release?.()`);
  await finishReply();
  const done = Date.now();
  await sleep(500);
  check('a finished reply gets the full delay before folding', await state() === 'open');
  await folded();
  check('folds once the reply has been idle for the delay', Date.now() - done >= 1000);
  await focus();
  await opened();

  const bubble = await rect('.bubble-response');
  await blur();
  for (let i = 0; i < 6; i++) { await mouse('mouseMoved', bubble.cx + (i % 2) * 8, bubble.cy); await sleep(250); }
  check('stays open while the pointer is over it', await state() === 'open');
  await mouse('mouseMoved', 4, 4);
  await folded();
  check('folds after the pointer leaves', true);
  await focus();
  await opened();

  await evalJS(`__mock.emit('qchat://settings-focus',null)`);
  await blur();
  await sleep(1500);
  check('never folds while the settings window is open', await state() === 'open');
  await evalJS(`__mock.emit('qchat://settings-closed',null)`);
  await folded();
  check('folds after the settings window closes', true);
  await focus();
  await opened();

  await blur();
  await evalJS(`__mock.emit('qchat://hidden',null)`);
  await sleep(1500);
  check('a hidden window never folds', await state() === 'open');
  await evalJS(`__mock.emit('qchat://shown',null)`);
  await focus();
  await blur();
  await folded();
  await evalJS(`__mock.emit('qchat://hidden',null)`);
  check('hiding a folded window resets it at once', await state() === 'open' && Math.abs((await rect('#bar')).w - before.bar.w) < 0.5);
  await evalJS(`__mock.emit('qchat://shown',null)`);
  await focus();

  await settings({ idleCollapse: 0 });
  await blur();
  await sleep(1500);
  check('zero seconds turns folding off', await state() === 'open');
  await settings({ idleCollapse: 1 });
  await folded();
  check('turning it back on while unfocused starts the count', true);
  await focus();
  await opened();

  await settings({ hideOnBlur: true });
  await blur();
  await sleep(1500);
  check('hide-on-blur takes over from folding', await state() === 'open');
  await focus();
  await settings({ hideOnBlur: false });

  // --- Reduced motion and the hidden orb style -----------------------------------------------
  await open({ animations: 'off', orbStyle: 'hidden' }, { chats: null });
  await blur();
  await until(`document.documentElement.dataset.collapse`, 'any collapse state', 300);
  check('motion off folds without an animation', await state() === 'closed' && !await evalJS(`document.getElementById('bar').getAnimations().length`));
  const quiet = { bar: await rect('#bar'), orb: await rect('#orb') };
  check('hidden orb style still shows the orb when folded', Math.abs(quiet.orb.w - 18) < 0.5 && Math.abs(quiet.orb.cx - quiet.bar.cx) < 0.6 && await evalJS(`getComputedStyle(document.getElementById('orb')).backgroundImage!=='none'`));
  await focus();
  check('motion off opens without an animation', await state() === 'open');

  check('no runtime errors', problems.length === 0, problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error('console:', problems.slice(0, 5).join(' | ')); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else app.kill('SIGKILL');
  }
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-collapse-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
