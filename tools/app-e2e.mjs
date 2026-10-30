// End-to-end check of the real QChat app, driven over WebView2 CDP. No windows are shown.
// Usage: node tools/app-e2e.mjs   (needs `cargo build` first; uses the debug exe)
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const port = 9335;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let n = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const ready = new Promise(r => (ws.onopen = r));
  const evaluate = async expr => {
    const id = ++n;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await new Promise(r => pend.set(id, r));
    return d.result?.result?.value;
  };
  return { ready, evaluate, close: () => ws.close() };
}

const profile = mkdtempSync(path.join(tmpdir(), 'qchat-e2e-'));
const app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore' });
let ui;
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failed++; };

try {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {}
    if (list.some(p => p.url.includes('chatgpt.com')) && list.some(p => p.url.includes('tauri.localhost'))) break;
    await sleep(500);
  }
  ui = cdp(list.find(p => p.url.includes('tauri.localhost')).webSocketDebuggerUrl); await ui.ready;

  let status = '';
  for (let i = 0; i < 80 && !/Ready|Guest/.test(status); i++) { status = await ui.evaluate(`document.getElementById('status-label').textContent`); await sleep(500); }
  check('bridge ready', /Ready|Guest/.test(status), status);

  const lastTurn = `(()=>{const ts=[...document.querySelectorAll('#bubble-zone [data-role=assistant]')];const l=ts[ts.length-1];return l?{txt:l.querySelector('.turn-content')?.innerText||'',err:!l.querySelector('.turn-error')?.hidden,streaming:l.dataset.status==='streaming'}:null})()`;
  async function ask(q, { stopAfterFirst = false } = {}) {
    await ui.evaluate(`(()=>{const t=document.getElementById('prompt-input');t.value=${JSON.stringify(q)};t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    const t0 = Date.now(); let stopped = false;
    for (let i = 0; i < 480; i++) {
      await sleep(250);
      const busy = await ui.evaluate(`!!document.querySelector('#bubble-zone [data-status=streaming]')`);
      const r = await ui.evaluate(lastTurn);
      if (stopAfterFirst && !stopped && r?.txt.trim()) { await ui.evaluate(`window.__TAURI__.core.invoke('chat_stop')`); stopped = true; }
      if (i > 3 && r && !busy && (r.txt.trim() || r.err)) return { ...r, ms: Date.now() - t0 };
    }
    return { txt: '', err: true, ms: Date.now() - t0, timeout: true };
  }

  let r = await ask('Reply with exactly the single word: pineapple');
  check('send + stream', /pineapple/i.test(r.txt) && !r.err, `${r.ms}ms ${JSON.stringify(r.txt.slice(0, 80))}`);
  r = await ask('What single word did you just reply with? Answer in one word.');
  check('context recall', /pineapple/i.test(r.txt) && !r.err, `${r.ms}ms ${JSON.stringify(r.txt.slice(0, 80))}`);
  r = await ask('In one sentence, mention that someone reached your daily limit yesterday.');
  check('limit phrase in chat is not a block', !r.err && r.txt.trim().length > 0, JSON.stringify(r.txt.slice(0, 80)));
  r = await ask('Say ok.');
  check('send after limit phrase', !r.err && r.txt.trim().length > 0, JSON.stringify(r.txt.slice(0, 40)));
  await ui.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`); await sleep(2000);
  r = await ask('Write a 3-item markdown list of fruits and a one-line python code block.');
  const html = await ui.evaluate(`[...document.querySelectorAll('#bubble-zone [data-role=assistant] .turn-content')].pop()?.innerHTML || ''`);
  check('new chat + markdown', /<li>/.test(html) && /code-block/.test(html) && !/\[object Object\]/.test(r.txt), `${r.ms}ms`);
  r = await ask('Count from 1 to 200, separated by spaces.', { stopAfterFirst: true });
  check('stop mid-stream', !r.timeout && r.txt.trim().length > 0 && !/\b200\b/.test(r.txt), `${r.txt.length} chars`);
} catch (e) {
  check('harness', false, e.stack);
} finally {
  ui?.close();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-e2e-')) {
    try { rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
