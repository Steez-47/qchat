// Discard draft slash command & undo UX regressions driven through the mock backend
// in an isolated, invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-discard-draft-'));
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
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const inputValue = () => evalJS(`document.getElementById('prompt-input').value`);
  const state = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const quote = (text) => evalJS(`__mock.emit('qchat://selection', ${JSON.stringify(text)})`);
  const MIN = 60 * 1000;
  const chatSeed = (k, { conv = null, prompt = `prompt ${k}`, reply = `reply ${k}`, ago = MIN, draft = '' } = {}) => ({
    key: k,
    conversationId: conv,
    title: k,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft,
    selectionTexts: [],
    transcript: [
      { id: `${k}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${k}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago
  });

  const settings = { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true };
  const seed = () => ({ v: 1, current: chatSeed('current'), recent: [chatSeed('a', { draft: 'draft a', ago: MIN })] });
  const setup = async (data = seed(), opts = settings) => { await open('/?mock=signedin', { chats: data, settings: opts }); await sleep(150); };
  const undo = async () => { await evalJS(`document.querySelector('#command-feedback button').click()`); await sleep(100); };
  const discardSlash = async () => { await type('/discard'); await key('Enter'); await sleep(80); };
  const discardCtrlK = async () => {
    await key('k', { ctrlKey: true });
    await waitFor(`!document.getElementById('slash-menu').hidden`);
    await evalJS(`document.querySelector('#slash-discard').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
    await sleep(80);
  };
  const stage = (name) => evalJS(`(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'${name}'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))})()`);

  // 1. empty composer shows Nothing to discard
  await setup();
  await discardSlash();
  check('empty composer shows Nothing to discard', await evalJS(`document.querySelector('#command-feedback').textContent.includes('Nothing to discard') && !document.querySelector('#command-feedback button')`));
  await sleep(100);
  await discardCtrlK();
  check('empty composer via Ctrl+K shows Nothing to discard', await evalJS(`document.querySelector('#command-feedback').textContent.includes('Nothing to discard') && !document.querySelector('#command-feedback button')`));

  // 2. /discard text is not treated as a draft
  await setup();
  await type('/discard');
  check('/discard text is not treated as a draft in storage', await evalJS(`!localStorage.getItem('qchat.chats')?.includes('/discard') && !Object.keys(localStorage).some(k=>/undo/i.test(k))`));
  await key('Enter');
  await sleep(80);
  check('/discard submission clears without undo offer', (await inputValue()) === '' && await evalJS(`!document.querySelector('#command-feedback button')`));

  // 3. typed text cleared and restored with caret
  await setup();
  await type('Hello world draft');
  await evalJS(`document.getElementById('prompt-input').focus(); document.getElementById('prompt-input').setSelectionRange(5, 5)`);
  await discardCtrlK();
  check('typed text cleared', (await inputValue()) === '' && await evalJS(`document.querySelector('#command-feedback').textContent.includes('Draft discarded') && !document.getElementById('command-feedback').hidden`));
  await undo();
  const restoredCaret = await evalJS(`({ val: document.getElementById('prompt-input').value, start: document.getElementById('prompt-input').selectionStart, end: document.getElementById('prompt-input').selectionEnd })`);
  check('typed text restored with caret', restoredCaret.val === 'Hello world draft' && restoredCaret.start === 5 && restoredCaret.end === 5, JSON.stringify(restoredCaret));

  // 4. quote cleared and restored
  await setup();
  await quote('Quoted excerpt text');
  await waitFor(`document.querySelector('#attachments .selection-chip')`);
  await discardSlash();
  check('quote cleared', await evalJS(`!document.querySelector('#attachments .selection-chip')`) && (await state()).current.selectionTexts?.length === 0);
  await undo();
  await waitFor(`document.querySelector('#attachments .selection-chip')`);
  check('quote restored', (await state()).current.selectionTexts?.includes('Quoted excerpt text') && !!await evalJS(`document.querySelector('#attachments .selection-chip')`));

  // 5. /discard text with a quote is not treated as draft
  await setup();
  await quote('Quoted excerpt text');
  await waitFor(`document.querySelector('#attachments .selection-chip')`);
  await discardSlash();
  await undo();
  await waitFor(`document.querySelector('#attachments .selection-chip')`);
  check('/discard text is not treated as a draft on quote undo', (await inputValue()) === '' && (await state()).current.selectionTexts?.includes('Quoted excerpt text'));

  // 6. Ctrl+K path with a real draft
  await setup();
  await type('Real draft via Ctrl+K');
  await discardCtrlK();
  check('Ctrl+K path with a real draft cleared', (await inputValue()) === '' && await evalJS(`document.querySelector('#command-feedback').textContent.includes('Draft discarded')`));
  await undo();
  check('Ctrl+K path with a real draft restored', (await inputValue()) === 'Real draft via Ctrl+K');

  // 7. ready file removed (attachment_remove called) and restored with a fresh id (attachment_begin called again) and the same name
  await setup();
  await evalJS(`
    window.attachmentCalls = { begin: [], remove: [] };
    window.nextFileId = 0;
    const realInvoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === 'attachment_begin') {
        const id = 'staged-' + (++window.nextFileId);
        window.attachmentCalls.begin.push({ id, name: args.name });
        return Promise.resolve({ ...args, id });
      }
      if (cmd === 'attachment_remove') {
        window.attachmentCalls.remove.push(args.id);
        return Promise.resolve({});
      }
      if (cmd === 'attachment_chunk' || cmd === 'attachment_finish') {
        return Promise.resolve({});
      }
      return realInvoke(cmd, args);
    };
  `);
  await stage('ready-doc.txt');
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`);
  const firstId = await evalJS(`window.attachmentCalls.begin[0]?.id`);
  await discardSlash();
  check('ready file removed and attachment_remove called',
    await evalJS(`!document.getElementById('attachments').textContent.includes('ready-doc.txt')`) &&
    await evalJS(`window.attachmentCalls.remove.includes('${firstId}')`)
  );
  await undo();
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`);
  const secondId = await evalJS(`window.attachmentCalls.begin[1]?.id`);
  const secondName = await evalJS(`window.attachmentCalls.begin[1]?.name`);
  check('ready file restored with fresh id and same name',
    secondName === 'ready-doc.txt' && secondId && secondId !== firstId &&
    await evalJS(`document.getElementById('attachments').textContent.includes('ready-doc.txt')`)
  );

  // 8. staging file cancelled and restored
  await setup();
  await evalJS(`
    window.attachmentCalls = { begin: [], remove: [] };
    window.nextFileId = 0;
    const realInvoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd === 'attachment_begin') {
        const id = 'staged-' + (++window.nextFileId);
        window.attachmentCalls.begin.push({ id, name: args.name });
        return Promise.resolve({ ...args, id });
      }
      if (cmd === 'attachment_chunk') {
        // Keep file staging
        return new Promise(() => {});
      }
      if (cmd === 'attachment_remove') {
        window.attachmentCalls.remove.push(args.id);
        return Promise.resolve({});
      }
      return realInvoke(cmd, args);
    };
  `);
  await stage('staging-doc.txt');
  await waitFor(`document.querySelector('#attachments [data-state=staging]')`);
  await discardSlash();
  check('staging file cancelled and removed', await evalJS(`!document.getElementById('attachments').textContent.includes('staging-doc.txt')`));
  // Allow chunks to complete on undo
  await evalJS(`window.__TAURI__.core.invoke = (cmd, args) => cmd === 'attachment_begin' ? Promise.resolve({ ...args, id: 'staged-restored' }) : Promise.resolve({})`);
  await undo();
  await waitFor(`document.getElementById('attachments').textContent.includes('staging-doc.txt')`);
  check('staging file restored from File object', await evalJS(`document.getElementById('attachments').textContent.includes('staging-doc.txt')`));

  // 9. conversation transcript untouched and chat_send count 0
  await setup();
  const transcriptBefore = JSON.stringify((await state()).current.transcript);
  const sendCountBefore = await count('chat_send');
  await type('test transcript preserved');
  await discardCtrlK();
  await undo();
  const transcriptAfter = JSON.stringify((await state()).current.transcript);
  const sendCountAfter = await count('chat_send');
  check('conversation transcript untouched', transcriptBefore === transcriptAfter);
  check('chat_send count 0', sendCountBefore === 0 && sendCountAfter === 0);

  // 10. Undo after typing new text refuses and keeps the new text
  await setup();
  await type('original draft to lose');
  await discardCtrlK();
  await type('newer work typed in');
  await undo();
  check('Undo after typing new text refuses and keeps the new text',
    (await inputValue()) === 'newer work typed in' &&
    await evalJS(`document.querySelector('#command-feedback').textContent.includes("Couldn't restore: the draft has changed")`)
  );

  // 11. Undo after switching chat refuses
  await setup();
  await type('draft on initial chat');
  await discardCtrlK();
  await key('n', { ctrlKey: true });
  await sleep(120);
  await undo();
  check('Undo after switching chat refuses',
    await evalJS(`document.querySelector('#command-feedback').textContent.includes("Couldn't restore: the draft has changed")`) &&
    (await inputValue()) === ''
  );

  // 12. Undo expired after six seconds offers nothing
  await setup();
  await type('expiring draft');
  await discardCtrlK();
  check('Undo offered initially before expiry', await evalJS(`!document.getElementById('command-feedback').hidden && !!document.querySelector('#command-feedback button')`));
  await sleep(6200);
  check('Undo expired after six seconds offers nothing', await evalJS(`document.getElementById('command-feedback').hidden || !document.querySelector('#command-feedback button')`));
  await key('z', { ctrlKey: true });
  await sleep(80);
  check('Ctrl+Z after expiry does not restore', (await inputValue()) === '');

  // 13. Ctrl+Z and the Undo button both work as for other undos, and Ctrl+Z with text in the composer stays native
  await setup();
  await type('ctrl-z draft restore');
  await discardCtrlK();
  await key('z', { ctrlKey: true });
  await sleep(80);
  check('Ctrl+Z undoes discard when composer empty', (await inputValue()) === 'ctrl-z draft restore');
  await type('text remains in composer');
  const prevented = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});document.querySelector('#prompt-input').dispatchEvent(e);return e.defaultPrevented})()`);
  check('Ctrl+Z with text in the composer stays native', !prevented);

  // 14. nothing about the snapshot in localStorage
  await setup();
  await type('secret draft not in storage');
  await discardCtrlK();
  check('nothing about the snapshot in localStorage', await evalJS(`!localStorage.getItem('qchat.chats')?.includes('secret draft not in storage') && !Object.keys(localStorage).some(k=>/undo/i.test(k))`));

  // 15. temporary chat draft stays out of storage through discard and Undo
  await setup();
  await type('/temp');
  await key('Enter');
  await sleep(100);
  await type('temporary chat draft content');
  await discardCtrlK();
  check('temporary chat draft stays out of storage through discard', await evalJS(`!localStorage.getItem('qchat.chats')?.includes('temporary chat draft content')`));
  await undo();
  check('temporary chat draft restored in composer', (await inputValue()) === 'temporary chat draft content');
  check('temporary chat draft stays out of storage after Undo', await evalJS(`!localStorage.getItem('qchat.chats')?.includes('temporary chat draft content')`));

  check('no runtime errors', problems.length === 0, problems.slice(0, 4).join(' | '));
} catch (e) {
  console.error(e);
  if (problems.length) console.error('console:', problems.slice(0, 5).join(' | '));
  failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  try { app.kill('SIGKILL'); } catch {}
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (failed) {
    console.error(`FAILED (${failed})`);
    process.exit(1);
  }
  console.log('ALL PASS');
}
