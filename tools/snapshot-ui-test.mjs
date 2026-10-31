// Focused composer snapshot checks in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-snapshot-ui-'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, 'ui', relative));
    res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const app = spawn(process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let failed = 0;

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
    const message = JSON.parse(e.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
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
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.test = {
      calls: [], handlers: {}, files: new Map(), finished: [], next: 0,
      png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      snapshotName: 'Snapshot 1.png',
      delaySnapshot: false, rejectSnapshot: false, snapshotError: 'snapshot_failed: no active window',
      autoDone: true
    };
    test.emit = payload => (test.handlers.bridge || []).forEach(fn => fn({ payload }));
    window.__TAURI__ = { event: { listen: async (name, fn) => { (test.handlers[name] ||= []).push(fn); } }, core: { invoke: async (cmd, args = {}) => {
      test.calls.push({ cmd, args });
      if (cmd === 'chat_status') { test.emit({ type: 'status', ready: true, loggedIn: false, url: 'https://chatgpt.com/' }); return null; }
      if (cmd === 'get_theme') return { dark: true };
      if (cmd === 'snapshot_capture') {
        if (test.delaySnapshot) await new Promise((resolve, reject) => {
          test.releaseSnapshot = resolve;
          test.rejectSnapshotNow = () => reject(new Error(test.snapshotError));
        });
        if (test.rejectSnapshot) throw new Error(test.snapshotError);
        return { name: test.snapshotName, mime: 'image/png', data: test.png };
      }
      if (cmd === 'attachment_begin') {
        const file = { ...args, id: 'file-' + (++test.next), offset: 0 };
        test.files.set(file.id, file);
        return file;
      }
      if (cmd === 'attachment_chunk') {
        const file = test.files.get(args.id);
        const size = atob(args.data).length;
        if (!file || size > 524288 || args.offset !== file.offset) throw new Error('bad chunk');
        file.offset += size;
        return null;
      }
      if (cmd === 'attachment_finish') {
        const file = test.files.get(args.id);
        if (!file || file.offset !== file.size) throw new Error('incomplete');
        test.finished.push(args.id);
        return file;
      }
      if (cmd === 'attachment_remove') { test.files.delete(args.id); return null; }
      if (cmd === 'chat_send') {
        if (test.autoDone) setTimeout(() => test.emit({ type: 'done', id: args.id, text: 'ok', conversationId: 'conv-1' }), 10);
        return null;
      }
      return null;
    } } };
  ` });

  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100; i++) { if (await evalJS(`!!window.test?.handlers.bridge && !!window.QSettings`)) break; await sleep(50); }

  const results = await evalJS(`(async () => {
    const results = [];
    const check = (name, ok) => results.push({ name, ok: !!ok });
    const $ = (id) => document.getElementById(id);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (fn) => { for (let i = 0; i < 300; i++) { if (fn()) return; await wait(10); } throw new Error('UI wait timed out'); };
    const input = (value) => { $('prompt-input').value = value; $('prompt-input').dispatchEvent(new Event('input', { bubbles: true })); };
    const attach = (name) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(1)], name, { type: 'application/octet-stream' }));
      $('attachment-input').files = data.files;
      $('attachment-input').dispatchEvent(new Event('change'));
    };
    const chips = () => [...document.querySelectorAll('#attachments .attachment-chip')];
    const chip = (name) => chips().find((node) => node.textContent.includes(name));
    const newChat = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
      await wait(30);
    };
    const snapshots = () => test.calls.filter((call) => call.cmd === 'snapshot_capture');
    const sends = () => test.calls.filter((call) => call.cmd === 'chat_send');
    const btn = $('btn-snapshot');
    const expectedBytes = atob(test.png).length;

    check('snapshot is a compact accessible bar control', btn && btn.classList.contains('bar-btn')
      && btn.getAttribute('aria-label') === 'Snapshot current window'
      && btn.title === 'Snapshot current window' && !!btn.querySelector('.icon'));

    input('keep my draft');
    attach('existing.txt');
    await until(() => chip('existing.txt')?.dataset.state === 'ready');
    check('existing draft and attachment staged before capture', $('prompt-input').value === 'keep my draft' && !!chip('existing.txt'));

    test.delaySnapshot = true;
    btn.click();
    btn.click();
    await until(() => test.releaseSnapshot);
    check('rapid duplicate clicks invoke snapshot once', snapshots().length === 1);
    check('pending capture keeps the composer editable and blocks sending', btn.disabled && $('btn-send').disabled
      && !$('prompt-input').disabled && !$('prompt-input').readOnly);

    const sendsBefore = sends().length;
    $('prompt-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    $('btn-send').click();
    await wait(40);
    check('pending capture prevents send and keeps the draft', sends().length === sendsBefore && $('prompt-input').value === 'keep my draft');
    check('pending capture does not auto-send', sends().length === 0);

    test.releaseSnapshot();
    test.delaySnapshot = false;
    await until(() => chip('Snapshot 1.png')?.dataset.state === 'ready');
    await until(() => chip('Snapshot 1.png')?.querySelector('img')?.naturalWidth === 1);

    const staged = [...test.files.values()].find((file) => file.name === 'Snapshot 1.png');
    const begin = test.calls.filter((call) => call.cmd === 'attachment_begin' && call.args.name === 'Snapshot 1.png').at(-1);
    const chunks = staged ? test.calls.filter((call) => call.cmd === 'attachment_chunk' && call.args.id === staged.id) : [];
    const finished = staged ? test.finished.filter((id) => id === staged.id) : [];
    check('snapshot stages as a PNG through begin', begin && begin.args.mime === 'image/png' && begin.args.size === expectedBytes && staged?.size === expectedBytes);
    check('snapshot stages through one decoded chunk', !!staged && staged.offset === expectedBytes
      && chunks.length === 1 && chunks[0].args.offset === 0 && atob(chunks[0].args.data).length === expectedBytes);
    check('snapshot staging finishes once', finished.length === 1);
    check('snapshot thumbnail decodes', !!chip('Snapshot 1.png')?.querySelector('img'));
    check('capture preserves the typed draft and existing files', $('prompt-input').value === 'keep my draft'
      && !!chip('existing.txt') && !!chip('Snapshot 1.png'));
    check('capture does not auto-send', sends().length === 0);
    check('controls restore after capture', !btn.disabled && !$('btn-send').disabled);

    const snapshotId = staged.id;
    chip('Snapshot 1.png').querySelector('button[aria-label="Remove Snapshot 1.png"]').click();
    await until(() => !test.files.has(snapshotId) && !chip('Snapshot 1.png'));
    check('snapshot removes through the standard staged attachment path', !test.files.has(snapshotId)
      && !!chip('existing.txt') && $('prompt-input').value === 'keep my draft');

    input('');
    chip('existing.txt').querySelector('button[aria-label="Remove existing.txt"]').click();
    await until(() => !chip('existing.txt'));
    check('removing the last file leaves an empty draft and hides the tray', $('attachments').hidden && $('prompt-input').value === '');

    btn.click();
    await until(() => chip('Snapshot 1.png')?.dataset.state === 'ready');
    check('attachment-only send is enabled with an empty draft', !$('btn-send').disabled);
    const sentStaged = [...test.files.values()].find((file) => file.name === 'Snapshot 1.png');
    const beforeSend = sends().length;
    $('btn-send').click();
    await until(() => sends().length === beforeSend + 1);
    const sent = sends().at(-1);
    check('attachment-only send passes the staged snapshot id', sent.args.prompt === ''
      && sent.args.attachmentIds.length === 1 && sent.args.attachmentIds[0] === sentStaged?.id);
    await until(() => $('attachments').hidden);
    check('sent snapshot renders as a normal user attachment', document.querySelector('[data-role=user] .uploaded-image img')?.alt === 'Snapshot 1.png');
    await until(() => document.querySelector('[data-role=assistant]')?.dataset.status === 'done');

    test.autoDone = false;
    input('busy test');
    $('btn-send').click();
    await wait(30);
    check('snapshot is disabled while a reply is streaming', btn.disabled);
    const busySnapshots = snapshots().length;
    btn.click();
    await wait(30);
    check('a snapshot click during streaming is ignored', snapshots().length === busySnapshots);
    const busySend = sends().at(-1);
    test.emit({ type: 'done', id: busySend.args.id, text: 'done', conversationId: 'conv-2' });
    await wait(50);
    test.autoDone = true;
    check('snapshot returns when the reply ends', !btn.disabled);

    test.delaySnapshot = true;
    btn.click();
    await until(() => test.releaseSnapshot);
    const lateSnapshots = snapshots().length;
    const lateBegins = test.calls.filter((call) => call.cmd === 'attachment_begin').length;
    input('discard me');
    await newChat();
    check('New chat clears the pending draft', $('prompt-input').value === '' && $('attachments').hidden);
    input('new chat draft');
    test.releaseSnapshot();
    test.delaySnapshot = false;
    await wait(100);
    check('late snapshot result is ignored after New chat', snapshots().length === lateSnapshots
      && test.calls.filter((call) => call.cmd === 'attachment_begin').length === lateBegins
      && $('attachments').hidden && $('prompt-input').value === 'new chat draft');
    check('late result still restores the composer', !btn.disabled && !$('btn-send').disabled);

    test.rejectSnapshot = true;
    input('failure draft');
    btn.click();
    await until(() => !btn.disabled);
    await wait(20);
    const message = $('global-error-text').textContent;
    check('snapshot failure shows the native reason', !$('global-error').hidden
      && message.includes('no active window') && message.toLowerCase().includes('snapshot'));
    check('failure restores controls and preserves the draft', !btn.disabled
      && $('prompt-input').value === 'failure draft' && $('attachments').hidden);

    test.rejectSnapshot = false;
    btn.click();
    await until(() => chip('Snapshot 1.png')?.dataset.state === 'ready');
    await until(() => chip('Snapshot 1.png')?.querySelector('img')?.naturalWidth === 1);
    check('a snapshot succeeds after a failure and clears the error', !btn.disabled
      && !!chip('Snapshot 1.png')?.querySelector('img') && $('global-error').hidden);

    return results;
  })()`);

  for (const { name, ok } of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }
} catch (error) {
  console.error(error);
  failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-snapshot-ui-')) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
