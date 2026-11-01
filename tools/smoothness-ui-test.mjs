// Smoothness regressions: tab widths, readable titles, and feedback where an action used to do
// nothing. Driven through the mock backend in an isolated, invisible Edge profile.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-smoothness-ui-'));
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
  const until = async (expr, label) => {
    if (!await waitFor(expr)) throw Error(`Timed out: ${label}`);
  };
  const chat = (key, title, extra = {}) => ({ key, title, provider: 'chatgpt', conversationId: `conv-${key}`, lastPrompt: title,
    lastResponse: `reply for ${key}`, createdAt: Date.now(), lastActive: Date.now() - 60000,
    transcript: [{ id: `${key}-u`, role: 'user', text: title }, { id: `${key}-a`, role: 'assistant', text: `reply for ${key}` }], ...extra });
  const empty = () => ({ key: 'current', title: '', provider: 'chatgpt', conversationId: null, transcript: [], lastPrompt: '', lastResponse: '', createdAt: Date.now(), lastActive: Date.now() });
  const settings = { animations: 'off', keepHistory: true, showTabs: true, autoDismiss: 0 };
  const stored = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const feedback = () => evalJS(`(()=>{const n=document.getElementById('command-feedback');return n.hidden?'':n.textContent})()`);
  const idle = () => until(`document.getElementById('btn-send').dataset.mode==='send'&&!document.querySelector('[data-status="streaming"]')`, 'reply finished');
  const ready = () => until(`document.getElementById('prompt-input').placeholder!=='Connecting…'`, 'bridge ready');
  const focusInput = () => evalJS(`document.getElementById('prompt-input').focus()`);
  const family = '👨‍👩‍👧‍👦';

  // --- Tabs share space fairly -------------------------------------------------------------
  await open('/?mock=signedin', { settings, chats: { v: 1, current: empty(), recent: [
    chat('short', 'Hi'), chat('long-a', 'Explain what this regular expression does'), chat('long-b', 'Summarize this article about the climate') ] } });
  await until(`document.querySelectorAll('#tabs .tab').length===3`, 'tabs');
  const tabs = await evalJS(`[...document.querySelectorAll('#tabs .tab')].map(t=>{const s=t.querySelector('.tab-title');return {key:t.dataset.key,cut:s.scrollWidth>s.clientWidth+1,width:t.getBoundingClientRect().width}})`);
  const overflowing = tabs.some(t => t.cut);
  check('a short tab title stays whole while longer titles shorten', overflowing && !tabs.find(t => t.key === 'short').cut, JSON.stringify(tabs));
  check('the tab row stays inside the composer width', await evalJS(`(()=>{const bar=document.getElementById('bar').getBoundingClientRect();return [...document.querySelectorAll('#tabs > *')].every(t=>{const r=t.getBoundingClientRect();return r.left>=bar.left-1&&r.right<=bar.right+1})})()`));

  // --- Titles never split a visible character ----------------------------------------------
  await open('/?mock=signedin', { settings, chats: { v: 1, current: empty(), recent: [chat('emoji', 'x'.repeat(22) + family + ' and more words')] } });
  await until(`document.querySelector('#tabs .tab-title')`, 'emoji tab');
  check('tab titles shorten without splitting an emoji sequence', await evalJS(`document.querySelector('#tabs .tab-title').textContent`) === 'x'.repeat(22) + family + '…');

  await ready(); await focusInput();
  await send('First message'); await idle();
  await type('/rename'); await key('Enter'); await until(`!document.getElementById('rename-chat').hidden`, 'rename open');
  const graphemeName = 'a'.repeat(38) + family + family + 'tail';
  await evalJS(`(()=>{const i=document.getElementById('rename-chat-input');i.value=${JSON.stringify(graphemeName)};i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('rename-chat').requestSubmit()})()`);
  await sleep(50);
  check('a 40-character name keeps whole emoji sequences', (await stored()).current.title === 'a'.repeat(38) + family + family, JSON.stringify((await stored()).current.title));
  check('renaming reports the shortened name in visible characters', (await feedback()).includes('shortened to 40 characters'));
  await open('/?mock=signedin', { settings, keep: true });
  check('the grapheme-safe name is unchanged after reload', (await stored()).current.title === 'a'.repeat(38) + family + family);

  // --- Chats are named from their first line, at a word --------------------------------------
  await open('/?mock=signedin', { settings });
  await ready(); await evalJS(`__mock.interval=5`); await focusInput();
  await send('Summarize this in three bullet points:\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit'); await idle();
  check('a multi-line first prompt names the chat by its first line', (await stored()).current.title === 'Summarize this in three bullet points:');
  await key('n', { ctrlKey: true }); await sleep(60);
  await send('Please explain the difference between promises and async functions in detail'); await idle();
  const longTitle = (await stored()).current.title;
  check('a long first prompt is shortened at a word with an ellipsis', longTitle === 'Please explain the difference between…', JSON.stringify(longTitle));
  await key('n', { ctrlKey: true }); await sleep(60);
  await send('y'.repeat(80)); await idle();
  check('one unbroken word is cut with an ellipsis inside the limit', (await stored()).current.title === 'y'.repeat(39) + '…');
  await open('/?mock=signedin', { settings, keep: true });
  check('automatic titles survive reload unchanged', (await stored()).recent.some(c => c.title === 'Please explain the difference between…') && (await stored()).current.title === 'y'.repeat(39) + '…');
  await ready(); await focusInput(); await key('n', { ctrlKey: true }); await sleep(60);
  await type('Draft heading line that is quite long and keeps going for a while\nsecond line'); await key('n', { ctrlKey: true }); await sleep(80);
  check('draft-only chats preview the same word-boundary title', await evalJS(`[...document.querySelectorAll('#tabs .tab')].some(t=>t.getAttribute('aria-label').includes('Draft heading line that is quite long…'))`));

  // --- Busy actions explain themselves -----------------------------------------------------
  await open('/?mock=signedin', { settings, chats: { v: 1, current: empty(), recent: [chat('other', 'Other chat')] } });
  await ready(); await focusInput();
  await evalJS(`__mock.hold=true`); await send('Keep streaming'); await until(`__mock.last('chat_send')`, 'send');
  await evalJS(`document.querySelector('#tabs .tab').click()`); await sleep(30);
  check('clicking a tab mid-reply says why it did not switch', (await feedback()).startsWith('Finish or stop the reply first') && (await stored()).current.key === 'current');
  await evalJS(`document.getElementById('command-feedback').hidden=true`);
  await evalJS(`document.querySelector('#tabs .tab').focus()`); await key('Enter'); await sleep(30);
  check('Enter on a focused tab mid-reply explains too', (await feedback()).startsWith('Finish or stop the reply first'));
  await focusInput(); await key('p', { ctrlKey: true }); await until(`document.querySelector('.feature-search')`, 'chat list');
  await evalJS(`[...document.querySelectorAll('.feature-choice')].find(b=>b.textContent.includes('Other chat')).click()`); await sleep(30);
  check('choosing a chat from the list mid-reply explains', (await feedback()).startsWith('Finish or stop the reply first') && (await stored()).current.key === 'current');
  await focusInput(); await type('/gem'); await key('Enter'); await sleep(30);
  check('a provider switch mid-reply explains and does not switch', (await feedback()).startsWith('Finish or stop the reply first') && await evalJS(`__mock.count('provider_set')`) === 1);
  await type('/mod'); await key('Enter'); await sleep(30);
  check('/model mid-reply explains', (await feedback()).startsWith('Finish or stop the reply first') && await evalJS(`document.querySelector('.feature-list').hidden`));
  await evalJS(`__mock.hold=false;__mock.release?.()`); await idle();
  await type('/chatgpt'); await key('Escape'); await focusInput(); await key('Enter'); await sleep(30);
  check('asking for the provider already in use says so', (await feedback()) === 'Already using ChatGPT' && await evalJS(`__mock.count('provider_set')`) === 1);

  // --- Enter while connecting ----------------------------------------------------------------
  await open('/?status=hold', { settings });
  await focusInput(); await type('Hello early'); await key('Enter'); await sleep(30);
  check('Enter while connecting says it is still connecting and keeps the draft', (await feedback()) === 'Still connecting to ChatGPT…' && await evalJS(`document.getElementById('prompt-input').value==='Hello early'&&__mock.count('chat_send')===0`));
  await evalJS(`document.getElementById('command-feedback').hidden=true`);
  await type(''); await key('Enter'); await sleep(30);
  check('Enter with nothing to send while connecting stays quiet', (await feedback()) === '');
  await type('/keys'); await key('Escape'); await focusInput(); await key('Enter'); await sleep(60);
  check('an exact command still runs while connecting', await evalJS(`!document.querySelector('.feature-list').hidden&&document.querySelector('.feature-list').textContent.includes('Ctrl+P')`));
  await key('Escape');

  // --- Menus close with the shortcut that opened them ----------------------------------------
  await open('/?mock=signedin', { settings, chats: { v: 1, current: empty(), recent: [chat('other', 'Other chat')] } });
  await ready(); await focusInput(); await type('keep this draft');
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(4,4)`);
  await key('k', { ctrlKey: true }); await sleep(30);
  const menuOpen = await evalJS(`!document.getElementById('slash-menu').hidden`);
  await key('k', { ctrlKey: true }); await sleep(30);
  check('Ctrl+K again closes the menu and keeps the draft and caret', menuOpen && await evalJS(`(()=>{const i=document.getElementById('prompt-input');return document.getElementById('slash-menu').hidden&&document.activeElement===i&&i.value==='keep this draft'&&i.selectionStart===4})()`));
  await key('k', { ctrlKey: true, repeat: true }); await sleep(30);
  check('a held Ctrl+K does not flicker the menu', await evalJS(`document.getElementById('slash-menu').hidden`));
  await key('p', { ctrlKey: true }); await sleep(30);
  const listOpen = await evalJS(`!document.querySelector('.feature-list').hidden`);
  await key('p', { ctrlKey: true }); await sleep(30);
  check('Ctrl+P again closes the chat list', listOpen && await evalJS(`document.querySelector('.feature-list').hidden||document.querySelector('.feature-list').hasAttribute('data-leaving')`));

  // --- Find starts from the selected words ---------------------------------------------------
  await evalJS(`__mock.interval=5`); await type(''); await send('Explain debounce'); await idle();
  await evalJS(`(()=>{const node=document.querySelector('[data-role=assistant] .turn-content strong').firstChild;const r=document.createRange();r.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  await key('f', { ctrlKey: true }); await sleep(150);
  check('Ctrl+F searches for the selected word', await evalJS(`document.getElementById('find-input').value==='debounce'&&document.activeElement.id==='find-input'&&document.getElementById('find-count').textContent.startsWith('1/')`));
  await evalJS(`(()=>{const p=document.querySelector('#history-panel [data-role=assistant] .turn-content');const r=document.createRange();r.selectNodeContents(p);getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  await key('f', { ctrlKey: true }); await sleep(100);
  check('a multi-line selection leaves the query alone', await evalJS(`document.getElementById('find-input').value==='debounce'`));

  // --- Auto-dismiss waits while reply text is selected --------------------------------------
  await open('/?mock=signedin', { settings: { ...settings, autoDismiss: 5 } });
  await ready(); await evalJS(`__mock.interval=5`); await focusInput();
  await send('Explain debounce'); await idle();
  await evalJS(`(()=>{const node=document.querySelector('[data-role=assistant] .turn-content strong').firstChild;const r=document.createRange();r.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(r)})()`);
  await sleep(6700);
  check('auto-dismiss keeps a reply whose text is selected', await evalJS(`!!document.querySelector('.turn-row[data-role=assistant]:not(.leaving)')`));
  await evalJS(`getSelection().removeAllRanges()`); await sleep(2000);
  check('auto-dismiss resumes once the selection is cleared', await evalJS(`!document.querySelector('.turn-row[data-role=assistant]:not(.leaving)')`));

  check('no runtime errors', problems.length === 0, problems.join(' | '));
  if (failed) process.exitCode = 1;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-smoothness-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
