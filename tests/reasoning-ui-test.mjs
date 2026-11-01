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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-reasoning-ui-'));
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
  const label = () => evalJS(`document.getElementById('btn-reasoning').querySelector('.reasoning-label').textContent`);
  const aria = () => evalJS(`document.getElementById('btn-reasoning').getAttribute('aria-label')`);
  const openPicker = () => evalJS(`document.getElementById('btn-reasoning').click()`);
  const press = (id) => evalJS(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));n.click();})()`);
  const pick = (title) => evalJS(`[...document.querySelectorAll('.feature-list .feature-choice')].find(n=>n.querySelector('.feature-title').textContent===${JSON.stringify(title)}).click()`);
  const lastSend = (keyName) => evalJS(`__mock.last('chat_send')?.args?.${keyName}`) ;
  const waitDone = () => waitFor(`(()=>{const rows=[...document.querySelectorAll('.turn-row[data-role=assistant]')];return rows.length>0&&rows.at(-1).dataset.status==='done'&&document.getElementById('btn-send').dataset.mode==='send';})()`, 8000);
  const setSettings = (patch) => evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.settings, ...${JSON.stringify(patch)}})`);
  const MIN = 60 * 1000;
  const chatSeed = (key, { conv = null, effort, prompt = `prompt ${key}`, reply = `reply ${key}`, ago = MIN } = {}) => ({
    key,
    conversationId: conv,
    title: key,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft: '',
    transcript: [
      { id: `${key}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${key}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago,
    ...(effort ? { reasoningEffort: effort } : {})
  });
  const baseSettings = { animations: 'off', autoDismiss: 0 };

  await open('/', { settings: baseSettings });
  check('a new chat starts at Medium in the compact composer picker',
    (await label()) === 'Medium' && (await aria()) === 'Reasoning: Medium' &&
    (await evalJS(`document.getElementById('btn-reasoning').dataset.value`)) === 'medium' &&
    (await evalJS(`!document.getElementById('btn-reasoning').hidden`)),
    `${await label()} / ${await aria()}`);

  await openPicker();
  check('the picker lists Low, Medium and High with one selected check',
    await evalJS(`(()=>{const rows=[...document.querySelectorAll('.feature-list .feature-row')].filter(r=>r.querySelector('.feature-check'));const titles=rows.map(r=>r.querySelector('.feature-title').textContent);const checks=rows.filter(r=>{const c=r.querySelector('.feature-check');return c&&c.style.visibility==='visible';});return rows.length===3&&titles.join(',')==='Low,Medium,High'&&checks.length===1&&checks[0].querySelector('.feature-title').textContent==='Medium';})()`));
  await pick('Low');
  check('picking Low stores an explicit per-chat override',
    (await label()) === 'Low' &&
    (await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.reasoningEffort`)) === 'low');
  await send('low effort');
  await waitFor(`__mock.count('chat_send')>0`);
  check('Low is snapshotted into chat_send', (await lastSend('reasoningEffort')) === 'low');
  await waitDone();

  await openPicker();
  check('the picker marks the chat override as selected', await evalJS(`(()=>{const on=[...document.querySelectorAll('.feature-list .feature-row')].filter(r=>r.querySelector('.feature-check')?.style.visibility==='visible');return on.length===1&&on[0].querySelector('.feature-title').textContent==='Low';})()`));
  await pick('High');
  await send('high effort');
  await waitFor(`__mock.count('chat_send')>1`);
  check('High is snapshotted into chat_send', (await lastSend('reasoningEffort')) === 'high');
  await waitDone();

  // Saved default: the Settings row persists it, and the chat window applies it live.
  await open('/settings.html', { settings: baseSettings });
  check('Behaviour has a Default reasoning row',
    await evalJS(`(()=>{const row=document.querySelector('[data-key="defaultReasoning"]');return !!row&&row.closest('#section-behavior')!==null&&[...row.querySelectorAll('.segmented button')].map(b=>b.textContent).join(',')==='Low,Medium,High';})()`));
  await evalJS(`document.querySelector('[data-key="defaultReasoning"] button[data-value="low"]').click()`);
  check('the saved default persists as Low',
    (await evalJS(`JSON.parse(localStorage.getItem('qchat.settings')).defaultReasoning`)) === 'low' &&
    (await evalJS(`document.querySelector('[data-key="defaultReasoning"] button[data-value="low"]').getAttribute('aria-checked')`)) === 'true');
  await open('/', { keep: true });
  check('an unoverridden chat loads with the saved default', (await label()) === 'Low' && (await aria()) === 'Reasoning: Low');
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('a live default change updates the unoverridden current chat', (await label()) === 'High' && (await aria()) === 'Reasoning: High');

  await openPicker();
  await pick('Low');
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('an explicit override wins over a later default change', (await label()) === 'Low');
  await type('/new'); await key('Enter');
  await sleep(40);
  check('a new chat starts from the saved default again',
    (await label()) === 'High' &&
    (await evalJS(`!('reasoningEffort' in JSON.parse(localStorage.getItem('qchat.chats')).current)`)));

  // Stored overrides load, sanitize and travel with their chat.
  await open('/', {
    settings: { ...baseSettings, defaultReasoning: 'medium' },
    chats: { v: 1, current: chatSeed('cur', { effort: 'low' }), recent: [chatSeed('a', { conv: 'conv-a', effort: 'high' }), chatSeed('b')] }
  });
  check('a stored override loads with its chat', (await label()) === 'Low');
  await evalJS(`document.querySelector('#tabs .tab[data-key="a"]').click()`);
  await sleep(40);
  check('switching chats shows that chat\'s override', (await label()) === 'High');
  await evalJS(`document.querySelector('#tabs .tab[data-key="b"]').click()`);
  await sleep(40);
  check('a chat without an override follows the saved default', (await label()) === 'Medium');

  await open('/', {
    settings: { ...baseSettings, defaultReasoning: 'medium' },
    chats: { v: 1, current: chatSeed('cur', { effort: 'ultra' }), recent: [] }
  });
  check('an old or invalid override is sanitized away',
    (await label()) === 'Medium' &&
    (await evalJS(`!('reasoningEffort' in JSON.parse(localStorage.getItem('qchat.chats')).current)`)));

  // Busy guard: picker disabled, display frozen and the send keeps its snapshot.
  await open('/', { settings: { ...baseSettings, defaultReasoning: 'medium' } });
  await evalJS(`__mock.hold=true; __mock.interval=5; true`);
  await send('hold this send');
  await waitFor(`__mock.count('chat_send')>0 && !!__mock.release`);
  check('the picker is disabled while a send is active',
    await evalJS(`document.getElementById('btn-reasoning').disabled`));
  await openPicker();
  check('a disabled picker cannot open while sending',
    await evalJS(`document.querySelector('.feature-list').hidden`));
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('the composer keeps the effort that was sent, not a midstream default',
    (await label()) === 'Medium' && (await lastSend('reasoningEffort')) === 'medium');
  await evalJS(`__mock.release()`);
  await waitDone();
  check('after the reply the picker returns to the saved default',
    !(await evalJS(`document.getElementById('btn-reasoning').disabled`)) && (await label()) === 'High');

  // Keyboard path through the same popup: arrows, Enter and Escape.
  await openPicker();
  check('opening the picker focuses the shared feature list', await evalJS(`document.activeElement===document.querySelector('.feature-list')`));
  await key('ArrowDown');
  await key('Enter');
  await sleep(30);
  check('ArrowDown and Enter choose an option without a pointer', (await label()) === 'Medium' && await evalJS(`document.querySelector('.feature-list').hidden`));
  await openPicker();
  await key('Escape');
  await sleep(30);
  check('Escape closes the picker, keeps the value and returns focus to the prompt',
    await evalJS(`document.querySelector('.feature-list').hidden && document.activeElement===document.getElementById('prompt-input')`) && (await label()) === 'Medium');

  // Toggle and close animation: a second press on the reasoning button closes
  // the open picker, and a pointer away fades it out instead of hiding it.
  await open('/', { settings: { ...baseSettings, animations: 'on' } });
  await press('btn-reasoning');
  check('the reasoning button opens the picker', await evalJS(`!document.querySelector('.feature-list').hidden`));
  await press('btn-reasoning');
  check('a pointer press on the open reasoning button starts a close instead of reopening it',
    await evalJS(`(()=>{const list=document.querySelector('.feature-list');return !list.hidden&&list.hasAttribute('data-leaving')&&list.getAnimations().length>0;})()`));
  check('the toggled picker finishes closing', await waitFor(`document.querySelector('.feature-list').hidden`, 1500));

  await openPicker();
  await evalJS(`document.getElementById('prompt-input').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  check('a pointer away starts the picker close animation',
    await evalJS(`(()=>{const list=document.querySelector('.feature-list');return !list.hidden&&list.hasAttribute('data-leaving');})()`));
  check('the pointer-away close finishes', await waitFor(`document.querySelector('.feature-list').hidden`, 1500));

  check('appearance presets exclude and preserve the behavioural default', await evalJS(`(()=>{
    const before={...QSettings.DEFAULTS,defaultReasoning:'high'};
    const applied=QSettings.applyPreset(before,'reader');
    const saved=QSettings.savePreset('reasoning-check',{...QSettings.DEFAULTS,defaultReasoning:'low'});
    const exported=JSON.parse(QSettings.exportPreset(saved.id));
    const ok=!QSettings.APPEARANCE_KEYS.includes('defaultReasoning')&&applied.defaultReasoning==='high'&&applied.textSize===18&&!('defaultReasoning' in exported.values)&&!('defaultReasoning' in saved.values);
    QSettings.deletePreset(saved.id);
    return ok;
  })()`));

  await open('/', { settings: { ...baseSettings, barWidth: 340, defaultReasoning: 'medium' } });
  await sleep(80);
  const fit = await evalJS(`(()=>{
    const bar=document.getElementById('bar'), input=document.getElementById('prompt-input'), button=document.getElementById('btn-reasoning');
    const br=bar.getBoundingClientRect(), ir=input.getBoundingClientRect(), rr=button.getBoundingClientRect();
    const controls=['orb','prompt-input','btn-reasoning','btn-attach','btn-snapshot','btn-send'].map(id=>document.getElementById(id));
    return {
      barWidth: br.width,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      promptWidth: ir.width,
      buttonWidth: rr.width,
      inputRight: ir.right,
      buttonLeft: rr.left,
      buttonRight: rr.right,
      barRight: br.right,
      sameRow: controls.every(n=>{const r=n.getBoundingClientRect();return r.top>=br.top-1&&r.bottom<=br.bottom+1;}),
      label: button.querySelector('.reasoning-label').textContent
    };
  })()`);
  check('at 340px the picker stays compact and the prompt keeps real room',
    Math.abs(fit.barWidth - 340) <= 1 && fit.scrollWidth <= fit.clientWidth + 1 &&
    fit.promptWidth >= 150 && fit.buttonWidth >= 24 && fit.buttonWidth <= 64 &&
    fit.inputRight <= fit.buttonLeft + 0.5 && fit.buttonRight <= fit.barRight + 0.5 &&
    fit.sameRow && fit.label === 'Medium',
    JSON.stringify(fit));

  check('no runtime errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  const shots = path.join(root, '.tmp', 'reasoning');
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, 'composer-narrow.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await openPicker();
  await sleep(100);
  await writeFile(path.join(shots, 'picker-narrow.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-reasoning-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
