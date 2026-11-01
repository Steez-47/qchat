// Update-notice checks in an isolated, invisible Edge profile. Mock backend only: no account,
// no network, no OS-level input. `?update=<version>` makes the mock report a newer release.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-update-ui-'));
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
  // The first automatic check runs 8 s after launch.
  const AUTO = 1100;
  const open = async (query = '', settings = {}, skip = null) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify({ v: QCHAT_SETTINGS_V, animations: 'on', autoDismiss: 0, idleCollapse: 1, ...settings }))})`);
    if (skip) await evalJS(`localStorage.setItem('qchat.update.skip', ${JSON.stringify(skip)})`);
    await cdp('Page.navigate', { url: `${base}/${query}` });
    await until(`document.readyState==='complete' && window.QSettings && window.QUpdate`);
    await cdp('Page.bringToFront');
    await evalJS(`window.__focused=true;document.hasFocus=()=>window.__focused;window.__TAURI__.window={getCurrentWindow:()=>({startDragging:async()=>{}})}`);
    await mouse('mouseMoved', 4, 4);
    await sleep(60);
  };
  const mouse = (type, x, y) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const click = async (sel) => { const r = await rect(sel); await mouse('mouseMoved', r.cx, r.cy); await mouse('mousePressed', r.cx, r.cy); await mouse('mouseReleased', r.cx, r.cy); await sleep(60); };
  const rect = (sel) => evalJS(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2,right:r.right,bottom:r.bottom}})()`);
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}));})()`);
  const command = async (name) => { await evalJS(`document.getElementById('prompt-input').focus()`); await type(`/${name}`); await key('Enter'); await sleep(120); };
  const shown = (sel) => evalJS(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return !!n&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})})()`);
  const text = (sel) => evalJS(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
  const calls = (cmd) => evalJS(`__mock.count(${JSON.stringify(cmd)})`);
  const feedback = () => text('#command-feedback');

  // A newer release puts a badge on the orb; the chip waits for the pointer.
  await open('?update=1.9.0');
  check('no badge before the first check', !await shown('#update-badge'));
  await until(`!document.getElementById('update-badge').hidden`, 'update badge', AUTO);
  check('automatic check asks the native side once', await calls('update_check') === 1);
  check('badge sits on the orb', await evalJS(`document.getElementById('orb').contains(document.getElementById('update-badge'))`) && await shown('#update-badge'));
  check('chip stays hidden until the orb is hovered', !await shown('#update-chip'));

  const orb = await rect('#orb');
  await mouse('mouseMoved', orb.cx, orb.cy);
  await until(`!document.getElementById('update-chip').hidden`, 'chip on hover', 100);
  await sleep(250);
  const chip = await rect('#update-chip'), bar = await rect('#bar');
  check('hovering the orb shows the update button', await shown('#btn-update') && await text('#update-label') === 'Update to v1.9.0', await text('#update-label'));
  check('chip sits above the bar, lined up with the orb', chip.bottom <= bar.y + 0.5 && Math.abs(chip.x - (orb.x - 8)) < 1.5, JSON.stringify({ chip, orb, bar }));
  check('tabs step aside while the chip is up', await evalJS(`document.getElementById('stack').hasAttribute('data-update-chip')`));
  await mouse('mouseMoved', bar.cx, bar.cy);
  await sleep(500);
  check('moving off the orb hides the chip again', !await shown('#update-chip') && !await evalJS(`document.getElementById('stack').hasAttribute('data-update-chip')`));
  check('badge stays after the chip hides', await shown('#update-badge'));

  // Pointer can travel from the orb up into the chip without it closing.
  await mouse('mouseMoved', orb.cx, orb.cy);
  await until(`!document.getElementById('update-chip').hidden`, 'chip on hover again', 100);
  await click('#btn-update');
  await sleep(500);
  check('update button asks the native side to install', await calls('update_install') === 1);
  check('chip stays up and reports the restart', await shown('#update-chip') && await text('#update-label') === 'Restarting…');
  check('skip is hidden while installing', !await shown('#btn-update-skip'));

  // A failed install offers the release page instead.
  await open('?update=1.9.0&updateFail=checksum_mismatch');
  await until(`!document.getElementById('update-badge').hidden`, 'badge before failure', AUTO);
  await mouse('mouseMoved', orb.cx, orb.cy);
  await until(`!document.getElementById('update-chip').hidden`, 'chip before failure', 100);
  await click('#btn-update');
  await until(`document.getElementById('update-label').textContent.includes('GitHub')`, 'failure label', 100);
  check('failure says so and points at GitHub', await text('#update-label') === "Couldn't update · Get it on GitHub");
  await click('#btn-update');
  check('second click opens the release page', await evalJS(`__mock.last('open_external')?.args?.url`) === 'https://github.com/Steez-47/qchat/releases/tag/v1.9.0');
  check('a failed install is not retried silently', await calls('update_install') === 1);

  // Skipping a version hides it until a manual check.
  await open('?update=1.9.0');
  await until(`!document.getElementById('update-badge').hidden`, 'badge before skip', AUTO);
  await mouse('mouseMoved', orb.cx, orb.cy);
  await until(`!document.getElementById('update-chip').hidden`, 'chip before skip', 100);
  await click('#btn-update-skip');
  check('skip hides the badge and the chip', !await shown('#update-badge') && !await shown('#update-chip'));
  check('skip is remembered', await evalJS(`localStorage.getItem('qchat.update.skip')`) === '1.9.0');
  await open('?update=1.9.0', {}, '1.9.0');
  await until(`__mock.count('update_check')===1`, 'check with skipped version', AUTO);
  await sleep(50);
  check('a skipped version gets no badge', !await shown('#update-badge'));
  await command('update');
  check('/update brings a skipped version back and focuses its button', await shown('#update-chip') && await evalJS(`document.activeElement?.id`) === 'btn-update');
  await key('Escape');
  check('Escape puts the chip away', !await shown('#update-chip'));

  // Folded, the whole circle shows the chip.
  await open('?update=1.9.0');
  await until(`!document.getElementById('update-badge').hidden`, 'badge before fold', AUTO);
  await evalJS(`window.__focused=false;window.dispatchEvent(new Event('blur'))`);
  await until(`document.documentElement.dataset.collapse==='closed'`, 'folded', 500);
  check('badge stays on the folded orb', await shown('#update-badge'));
  const circle = await rect('#bar'), folded = await rect('#orb');
  await mouse('mouseMoved', circle.x + 4, circle.cy);
  await until(`!document.getElementById('update-chip').hidden`, 'chip while folded', 100);
  const foldedChip = await rect('#update-chip');
  check('hovering the folded circle shows the chip above it', foldedChip.bottom <= circle.y + 0.5 && foldedChip.right > folded.x, JSON.stringify({ foldedChip, circle }));
  check('the folded orb stays folded while the chip is up', await evalJS(`document.documentElement.dataset.collapse`) === 'closed');

  // Off in Settings: no checks, no badge.
  await open('?update=1.9.0', { checkUpdates: false });
  await sleep(AUTO * 10 + 500);
  check('checks off makes no request', await calls('update_check') === 0 && !await shown('#update-badge'));
  await evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,checkUpdates:true}))`);
  await until(`!document.getElementById('update-badge').hidden`, 'badge after turning checks on', 300);
  check('turning checks on checks soon', await calls('update_check') === 1);
  await evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,checkUpdates:false}))`);
  check('turning checks off hides the badge', !await shown('#update-badge'));

  // Up to date, and the note after an update.
  await open();
  await command('update');
  await until(`document.getElementById('command-feedback').textContent.includes('up to date')`, 'up-to-date feedback', 100);
  check('/update says when QChat is up to date', await feedback() === 'QChat is up to date (v1.4.1)' && !await shown('#update-badge'));
  await open('?updated=1.9.0');
  await until(`!document.getElementById('command-feedback').hidden`, 'updated feedback', 100);
  check('relaunch after an update says so', await feedback() === 'Updated to v1.9.0');

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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-update-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
