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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-reading-position-ui-'));
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
  const rows = (prefix) => Array.from({ length: 30 }, (_, i) => ({
    id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user',
    text: `${prefix} message ${i} ${'long text '.repeat(15)}`
  }));
  const chat = (key, extra = {}) => {
    const transcript = rows(key);
    return { key, title: key, conversationId: `conv-${key}`, lastPrompt: transcript.at(-2).text,
      lastResponse: transcript.at(-1).text, createdAt: Date.now(), lastActive: Date.now(), transcript, ...extra };
  };
  const settings = { animations: 'off', keepHistory: true, showTabs: true, autoDismiss: 0 };
  const setup = async (a = chat('a'), b = chat('b')) => {
    await open('/?mock=1', { settings, chats: { v: 1, current: a, recent: [b] } });
    await sleep(150);
  };
  const until = async (expr, label) => {
    if (!await waitFor(expr)) throw Error(`Timed out: ${label}`);
  };
  const switchTo = async (id) => {
    await until(`!!document.querySelector('#tabs [data-key="${id}"]:not(:disabled)')`, `enabled tab ${id}`);
    await evalJS(`document.querySelector('#tabs [data-key="${id}"]').click()`);
    await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(id)}`, `switch to ${id}`);
    await sleep(100);
  };
  const history = async () => {
    await evalJS(`if(document.getElementById('history-panel').hidden)document.getElementById('btn-history').click()`);
    await until(`!document.getElementById('history-panel').hidden && document.querySelectorAll('#history-panel [data-id]').length>10`, 'history rows');
    await sleep(100);
  };
  const mark = async (name, fraction) => {
    await evalJS(`(()=>{const p=document.getElementById('history-panel');p.scrollTop=(p.scrollHeight-p.clientHeight)*${fraction};const top=p.getBoundingClientRect().top;const r=[...p.children].find(n=>n.dataset.id&&n.getBoundingClientRect().bottom>top);if(!r||p.scrollHeight-p.clientHeight<100)throw Error('History fixture did not scroll');window[${JSON.stringify(name)}]={id:r.dataset.id,offset:r.getBoundingClientRect().top-top};})()`);
    await sleep(50);
  };
  const sameMark = (name) => evalJS(`(()=>{const p=document.getElementById('history-panel'),a=window[${JSON.stringify(name)}],r=[...p.children].find(n=>n.dataset.id===a.id);return !p.hidden&&!!r&&Math.abs(r.getBoundingClientRect().top-p.getBoundingClientRect().top-a.offset)<=2})()`);
  const atLatest = () => evalJS(`(()=>{const p=document.getElementById('history-panel');return !p.hidden&&p.scrollHeight-p.scrollTop-p.clientHeight<=2})()`);
  const emitRecord = (id, messages) => evalJS(`__mock.emit('bridge',{type:'transcript',conversationId:${JSON.stringify(id)},complete:true,messages:${JSON.stringify(messages)}})`);

  // A different account record is waiting while the reader visits another chat.
  const a = chat('a'), b = chat('b');
  await setup(a, b); await history(); await mark('anchorA', 0.32); await type('a draft');
  await switchTo('b');
  const older = [{ role: 'user', text: 'Earlier question on the website' }, { role: 'assistant', text: 'Earlier answer on the website' }];
  const queuedRecord = [...older, ...a.transcript.map(({ role, text }) => ({ role, text }))];
  await switchTo('a');
  check('history row and offset restored', await sameMark('anchorA'));
  check('draft and composer focus preserved', await evalJS(`document.activeElement.id==='prompt-input'&&document.activeElement.value==='a draft'`));
  await emitRecord('conv-a', queuedRecord); await sleep(200);
  check('older messages queued while away preserve the row within 2px', await sameMark('anchorA') && await evalJS(`document.getElementById('history-panel').textContent.includes('Earlier question on the website')`));

  // Each chat has its own remembered History position.
  await switchTo('b'); await history(); await mark('anchorB', 0.67);
  await switchTo('a'); check('first chat keeps its own position', await sameMark('anchorA'));
  await switchTo('b'); check('second chat keeps its own position', await sameMark('anchorB'));
  check('no position storage', await evalJS(`!Object.keys(localStorage).some(k=>/reading.position/i.test(k))&&!localStorage.getItem('qchat.chats').includes('readingPosition')`));

  // Latest follows a new record received after returning, including its final row.
  await setup(a, b); await history();
  await evalJS(`(()=>{const p=document.getElementById('history-panel');p.scrollTop=p.scrollHeight})()`); await sleep(100);
  await switchTo('b');
  const newRecord = [...a.transcript.map(({ role, text }) => ({ role, text })),
    { role: 'user', text: 'Question added while away' }, { role: 'assistant', text: 'New answer added while away' }];
  await switchTo('a'); await emitRecord('conv-a', newRecord); await sleep(200);
  check('following returns to latest and shows new content', await atLatest() && await evalJS(`document.querySelector('#history-panel').lastElementChild.textContent.includes('New answer added while away')`));

  // Exercise the separate single-reply viewport, using a real wheel-up hold.
  const longReply = Array.from({ length: 180 }, (_, i) => `Paragraph ${i}: ${'reply words '.repeat(10)}`).join('\n\n');
  const bubbleRows = [{ id: 'question', role: 'user', text: 'long question' }, { id: 'answer', role: 'assistant', text: longReply }];
  await setup(chat('a', { transcript: bubbleRows, lastResponse: longReply }), b);
  await switchTo('b'); await switchTo('a');
  await until(`!!document.querySelector('.bubble-zone [data-capped] .bubble-scroll')`, 'capped reply');
  const bubbleTop = await evalJS(`(()=>{const s=document.querySelector('.bubble-zone [data-capped] .bubble-scroll');s.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));s.scrollTop=(s.scrollHeight-s.clientHeight)*.3;return s.scrollTop})()`);
  await sleep(80); await switchTo('b'); await switchTo('a');
  check('reply bubble restores its scroll position', bubbleTop>2 && await evalJS(`(()=>{const s=document.querySelector('.bubble-zone [data-capped] .bubble-scroll');return s&&Math.abs(s.scrollTop-${bubbleTop})<=2})()`));

  // Sending a new turn drops the old anchor, even if the send later completes.
  await setup(a, b); await history(); await mark('sentAnchor', 0.25); await switchTo('b'); await switchTo('a');
  await evalJS(`__mock.hold=true;document.getElementById('prompt-input').focus()`); await send('A new question');
  await until(`!!__mock.last('chat_send')`, 'new send');
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:'A new answer',conversationId:'conv-a'})`);
  await until(`document.querySelector('.bubble-zone [data-role=assistant][data-status=done]')?.textContent.includes('A new answer')`, 'completed answer');
  await switchTo('b'); await switchTo('a');
  check('sending clears the saved anchor', await evalJS(`document.getElementById('history-panel').hidden&&document.querySelector('.bubble-zone [data-role=assistant]')?.textContent.includes('A new answer')`));

  // Remove, undo and reopen: the restored chat must no longer have the old anchor.
  await setup(a, b); await history(); await mark('removedAnchor', 0.25); await switchTo('b');
  await key('p', { ctrlKey: true }); await until(`!document.querySelector('.feature-list').hidden`, 'chat list');
  await evalJS(`(()=>{const r=[...document.querySelectorAll('.feature-row')].find(n=>n.querySelector('.feature-title')?.textContent==='a');if(!r)throw Error('missing chat a');r.querySelector('[aria-label="Remove chat"]').click()})()`);
  await until(`!!document.querySelector('#command-feedback button') && !JSON.parse(localStorage.getItem('qchat.chats')).recent.some(c=>c.key==='a')`, 'removed chat and undo');
  await evalJS(`document.querySelector('#command-feedback button').click()`); await sleep(100); await switchTo('a');
  check('removed and undone chat has no saved anchor', await evalJS(`document.getElementById('history-panel').hidden`));

  // Suppress the anchored row during the next History render to model a missing message.
  await setup(a, b); await history(); await mark('missingAnchor', 0.3); await switchTo('b');
  await evalJS(`(()=>{const panel=document.getElementById('history-panel'),original=panel.insertBefore;panel.insertBefore=function(node,before){if(node.dataset.id===missingAnchor.id)return node;return original.call(this,node,before)};window.restoreInsertion=()=>{delete panel.insertBefore}})()`);
  await switchTo('a'); await evalJS(`restoreInsertion()`);
  check('missing anchor falls back to latest', await atLatest() && await evalJS(`![...document.querySelectorAll('#history-panel [data-id]')].some(n=>n.dataset.id===missingAnchor.id)`));

  // The mock provider_set changes provider before restoring the target's view.
  await setup(a, chat('b', { provider: 'gemini' })); await history(); await mark('providerAnchor', 0.37);
  await switchTo('b'); await switchTo('a');
  check('cross-provider return restores the row within 2px', await sameMark('providerAnchor') && await evalJS(`__mock.provider==='chatgpt' && __mock.calls.some(c=>c.cmd==='provider_set'&&c.args.provider==='gemini')`));
  check('no runtime errors', problems.length===0, problems.join(' | '));

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
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-reading-position-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
