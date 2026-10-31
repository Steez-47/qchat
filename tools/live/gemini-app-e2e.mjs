// Whole-app Gemini check: real QChat, real UI, real gemini.google.com as a guest. Hidden isolated profile.
// Usage: node tools/live/gemini-app-e2e.mjs   (needs `cargo build`; sends a few harmless guest prompts)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const port = 9391;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cdp(url) {
  const ws = new WebSocket(url); let n = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const ready = new Promise(r => (ws.onopen = r));
  const evaluate = async expression => { const id = ++n; ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); const d = await new Promise(r => pend.set(id, r)); return d.result?.result?.value; };
  return { ready, evaluate, close: () => ws.close() };
}
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-gemini-e2e-'));
const app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore' });
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failed++; };
const targets = async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return []; } };
try {
  let list = [];
  for (let i = 0; i < 80 && !list.some(p => p.url.includes('tauri.localhost')); i++) { list = await targets(); await sleep(500); }
  const ui = cdp(list.find(p => p.url.includes('tauri.localhost')).webSocketDebuggerUrl); await ui.ready;
  check('Gemini page not loaded until needed', !list.some(p => p.url.includes('gemini.google.com')));
  const slash = async name => { await ui.evaluate(`(()=>{const t=document.getElementById('prompt-input');t.value='/${name}';t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`); };
  const label = () => ui.evaluate(`document.querySelector('#btn-provider span')?.textContent || document.querySelector('#btn-reasoning')?.textContent || ''`);
  const status = () => ui.evaluate(`document.getElementById('status-label').textContent`);
  const waitReady = async () => { for (let i = 0; i < 100; i++) { const s = await status(); if (/Ready|Guest/.test(s)) return s; await sleep(400); } return status(); };
  check('ChatGPT bridge ready first', /Ready|Guest/.test(await waitReady()));
  await slash('gemini');
  for (let i = 0; i < 40 && !/Gemini|Flash|Model/.test(await label()); i++) await sleep(250);
  check('picker shows Gemini', /Gemini|Flash|Model/.test(await label()));
  check('model picker available on Gemini', await ui.evaluate(`!document.getElementById('btn-reasoning').hidden`));
  const ready = await waitReady(); check('Gemini bridge ready as guest', /Ready|Guest/.test(ready), ready);
  list = await targets(); check('exactly one Gemini page', list.filter(p => p.url.includes('gemini.google.com')).length === 1);
  const lastTurn = `(()=>{const ts=[...document.querySelectorAll('#bubble-zone [data-role=assistant]')];const l=ts[ts.length-1];return l?{txt:l.querySelector('.turn-content')?.innerText||'',html:l.querySelector('.turn-content')?.innerHTML||'',err:!l.querySelector('.turn-error')?.hidden,streaming:l.dataset.status==='streaming',label:l.getAttribute('aria-label')}:null})()`;
  const ask = async (q, stopEarly) => {
    await ui.evaluate(`(()=>{const t=document.getElementById('prompt-input');t.value=${JSON.stringify(q)};t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    let stopped = false;
    for (let i = 0; i < 360; i++) {
      await sleep(250);
      const busy = await ui.evaluate(`!!document.querySelector('#bubble-zone [data-status=streaming]')`);
      const r = await ui.evaluate(lastTurn);
      if (stopEarly && !stopped && busy) { await ui.evaluate(`window.__TAURI__.core.invoke('chat_stop')`); stopped = true; }
      if (i > 3 && r && !busy && (r.txt.trim() || r.err || stopped)) return r;
    }
    return { txt: '', err: true, timeout: true };
  };
  let r = await ask('Reply with a markdown h2 heading, a two item bullet list, a small table, a python code block, and the word pineapple.');
  check('Gemini reply arrives in the bubble', /pineapple/i.test(r.txt) && !r.err, r.txt.slice(0, 60));
  check('Markdown rendered, not raw', /<h2/.test(r.html) && /<ul/.test(r.html) && /<table/.test(r.html) && /<pre/.test(r.html) && !/^##/m.test(r.txt));
  check('reply is labelled Gemini', /Gemini/.test(r.label || ''), r.label || '');
  r = await ask('Show me pictures of the Eiffel Tower.');
  let imageLoaded = false;
  for (let i = 0; i < 60; i++) {
    imageLoaded = await ui.evaluate(`(()=>{const t=[...document.querySelectorAll('#bubble-zone [data-role=assistant]')].at(-1);return !!t && [...t.querySelectorAll('img')].some(i=>i.naturalWidth>0)})()`);
    if (imageLoaded) break;
    await sleep(250);
  }
  check('guest reply image loads in assistant bubble', imageLoaded);
  const pages = await targets();
  const guest = cdp(pages.find(p => p.url.includes('gemini.google.com')).webSocketDebuggerUrl); await guest.ready;
  console.log('IMAGE DOM ' + JSON.stringify(await guest.evaluate(`[...document.querySelectorAll('model-response')].at(-1) && [...[...document.querySelectorAll('model-response')].at(-1).querySelectorAll('single-image img')].map(i=>({outsideMarkdown:!i.closest('.markdown'),linked:!!i.closest('a.image-source-link'),hiddenActionContainer:!!i.closest('[hide-from-message-actions]'),host:new URL(i.src).hostname,naturalWidth:i.naturalWidth}))`)));
  guest.close();
  r = await ask('Remember the code word walnut. Reply with only: ok');
  check('second turn in the same chat', !r.err && r.txt.trim().length > 0, r.txt.slice(0, 40));
  r = await ask('What code word did I just give you? Reply with only that word.');
  check('context carries across turns', /walnut/i.test(r.txt), r.txt.slice(0, 40));
  r = await ask('Count from 1 to 400, one number per line.', true);
  check('stop ends the reply cleanly', !r.timeout);
  await sleep(1500);
  await slash('chatgpt');
  for (let i = 0; i < 40 && !/GPT|Low|Medium|High/.test(await label()); i++) await sleep(250);
  check('back on ChatGPT', /GPT|Low|Medium|High/.test(await label()));
  check('reasoning restored', !(await ui.evaluate(`document.getElementById('btn-reasoning').hidden`)));
  check('earlier Gemini chat kept as a tab', await ui.evaluate(`document.querySelectorAll('#tabs [data-key], #tabs .tab').length>0`));
  ui.close();
} catch (e) { check('run', false, String(e.stack || e)); } finally { app.kill(); await sleep(800); try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
