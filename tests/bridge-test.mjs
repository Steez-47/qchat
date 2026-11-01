import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const pause = ms => new Promise(r => setTimeout(r, ms));
const domOnly = process.argv.includes('--dom-only');
const root = resolve(import.meta.dirname, '..');
const edge = spawn(process.env.QCHAT_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
  `--user-data-dir=${join(root, '.bridge-profile')}`, '--remote-debugging-port=9334', '--no-first-run', '--edge-skip-compat-layer-relaunch', '--disable-extensions', '--window-size=1000,800', 'about:blank'
], { stdio: 'ignore' });
let socket, serial = 0, cdp, current = 0;
const pending = new Map(), endpoints = new Set(), samples = [], streams = new Set();
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error('Timed out waiting for ChatGPT');
}
try {
  edge.on('error', e => { console.error(e.message); });
  const targets = await until(async () => { try { return await fetch('http://127.0.0.1:9334/json').then(r => r.json()); } catch { return null; } }, 15000);
  const target = targets.find(t => t.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { socket.onopen = ok; socket.onerror = no; });
  cdp = (method, params = {}) => new Promise((ok, no) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { ok, no, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const p = pending.get(message.id); if (!p) return; clearTimeout(p.timer); pending.delete(message.id); message.error ? p.no(new Error(message.error.message)) : p.ok(message.result); }
    if (message.method === 'Network.requestWillBeSent' && /conversation/.test(message.params.request.url)) { const p = new URL(message.params.request.url).pathname; if (!p.includes('/assets/')) { endpoints.add(p); console.log('Observed:', message.params.request.method, p); } }
    if (message.method === 'Network.responseReceived' && (/text\/event-stream/.test(message.params.response.mimeType) || message.params.response.url.includes('/conversation/updates'))) streams.add(message.params.requestId);
    if (message.method === 'Network.loadingFinished' && streams.has(message.params.requestId)) {
      cdp('Network.getResponseBody', { requestId: message.params.requestId }).then(r => samples.push(...r.body.split('\n').filter(Boolean).slice(0, 12).map(line => { try { const p = JSON.parse(line); return { version: p.version, type: p.type, mode: p.mode, revision: p.revision, baseRevision: p.baseRevision, markdown: p.markdown, fallbackMarkdown: p.dil?.fallbackMarkdown, kind: p.detail?.kind }; } catch { return { format: line.startsWith('data:') ? 'SSE' : 'unknown' }; } }))).catch(() => {});
    }
    if (message.method === 'Network.eventSourceMessageReceived' && samples.length < 8) samples.push({ format: 'SSE', event: message.params.eventName });
  };
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await cdp('Page.enable'); await cdp('Network.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__QCHAT_DISABLE_NET__ = ' + domOnly + '; window.__QCHAT_EMIT__ = e => { (window.__qlog ||= []).push(e); };\n' + await readFile(join(root, 'ui/response-tags.js'), 'utf8') + '\n' + await readFile(join(root, 'src-tauri/bridge/chatgpt-bridge.js'), 'utf8') });
  await cdp('Page.bringToFront');
  await cdp('Page.navigate', { url: 'https://chatgpt.com/' });
  await until(() => evaluate('window.__qlog?.some(e => e.type === "status" && e.ready)'));
  async function send(prompt, stop = false) {
    const id = `test-${++current}`;
    await evaluate(`window.__qchat.send(${JSON.stringify({ id, prompt })}); undefined`);
    if (stop) {
      await until(() => evaluate(`window.__qlog.find(e => e.id === ${JSON.stringify(id)} && e.type === 'delta' && e.text)`));
      await evaluate('window.__qchat.stop(); undefined');
    }
    const done = await until(async () => {
      const events = await evaluate(`window.__qlog.filter(e => e.id === ${JSON.stringify(id)})`);
      const error = events.find(e => e.type === 'error'); if (error) throw new Error(`${error.code}: ${error.message}`);
      return events.find(e => e.type === 'done');
    }, 180000);
    const count = await evaluate(`window.__qlog.filter(e => e.id === ${JSON.stringify(id)} && e.type === 'delta').length`);
    console.log(`Step ${current}: ${count} deltas; final=${JSON.stringify(done.text)}`);
    return done;
  }
  assert.match((await send('Reply with exactly the single word: pineapple')).text, /pineapple/i); console.log('PASS 1');
  assert.match((await send('What single word did you just reply with? Answer in one word.')).text, /pineapple/i); console.log('PASS 2');
  await evaluate('window.__qchat.newChat()');
  assert.ok((await send('Say hi in 3 words.')).text.trim()); console.log('PASS 3');
  const stopped = await send('Count from 1 to 40, separated by spaces.', true);
  assert.ok(stopped.text.trim()); assert.ok(!/\b40\b/.test(stopped.text), 'Expected partial output after stop'); console.log('PASS 4');
} catch (e) {
  console.error(`FAIL ${current || 'readiness'}: ${e.message}`); process.exitCode = 1;
  if (cdp) {
    try {
      const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: false });
      const path = join(tmpdir(), `qchat-bridge-${Date.now()}.png`); await writeFile(path, Buffer.from(shot.data, 'base64')); console.error(`Screenshot: ${path}`);
      const state = await cdp('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,4000),events:window.__qlog})', returnByValue: true });
      console.error(state.result.value);
    } catch (diagnosticError) { console.error(diagnosticError.message); }
  }
} finally {
  console.log('Conversation endpoints:', [...endpoints].join(', ') || '(none)');
  console.log('Redacted stream samples:', JSON.stringify(samples));
  socket?.close();
  await new Promise(resolve => { const killer = spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); killer.on('exit', resolve); killer.on('error', resolve); });
}






