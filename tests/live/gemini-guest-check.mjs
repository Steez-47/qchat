// Live guest check for src-tauri/bridge/gemini-bridge.js against gemini.google.com
// via the test-mode debug exe with an isolated temporary profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = path.resolve('src-tauri/target/debug/qchat.exe');
const bridgeSource = readFileSync(path.resolve('src-tauri/bridge/gemini-bridge.js'), 'utf8');
const port = 9379;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-gem-check-'));

const app = spawn(exe, [], {
  env: {
    ...process.env,
    QCHAT_DEBUG_PORT: String(port),
    QCHAT_TEST_MODE: '1',
    QCHAT_TEST_PROFILE: profile
  },
  stdio: 'ignore'
});

function cdp(url) {
  const ws = new WebSocket(url);
  let n = 0;
  const p = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && p.has(d.id)) {
      p.get(d.id)(d);
      p.delete(d.id);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const send = (method, params = {}) => new Promise(r => {
    const id = ++n;
    p.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (d.result?.exceptionDetails) {
      throw new Error('CDP evaluate exception: ' + JSON.stringify(d.result.exceptionDetails).slice(0, 500));
    }
    return d.result?.result?.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

const harnessPrelude = `
(() => {
  if (!Array.isArray(window.__qchatTestEvents)) {
    window.__qchatTestEvents = [];
  }
  const origEmit = window.__QCHAT_EMIT__;
  window.__QCHAT_EMIT__ = function (event) {
    window.__qchatTestEvents.push(event);
    if (typeof origEmit === 'function') {
      try { origEmit(event); } catch (_) {}
    }
  };
})();
`;

async function ensureBridgeInjected(c) {
  await c.evaluate(harnessPrelude);
  const installed = await c.evaluate(`Boolean(window.__qchat && window.__qchat._installed)`);
  if (!installed) {
    await c.evaluate(bridgeSource);
  }
  await c.evaluate(`window.__qchat && window.__qchat.status && window.__qchat.status()`);
}

async function waitForEvent(c, predicateExpr, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await c.evaluate(`(() => {
      const events = window.__qchatTestEvents || [];
      const fn = ${predicateExpr};
      return events.find(fn) || null;
    })()`).catch(() => null);
    if (found) return found;
    await sleep(300);
  }
  const recent = await c.evaluate(`(window.__qchatTestEvents || []).slice(-10)`).catch(() => []);
  throw new Error(`Timed out waiting for event matching ${predicateExpr}. Recent events: ${JSON.stringify(recent)}`);
}

try {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {}
    if (list.some(p => p.url.includes('chatgpt.com') || p.url.includes('gemini.google.com'))) break;
    await sleep(500);
  }

  const target = list.find(p => p.url.includes('gemini.google.com')) || list.find(p => p.url.includes('chatgpt.com'));
  assert.ok(target, 'Could not find QChat webview target via CDP');

  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `${harnessPrelude}\n${bridgeSource}`
  });

  if (!target.url.includes('gemini.google.com')) {
    await c.send('Page.navigate', { url: 'https://gemini.google.com/app' });
  }

  // Wait for Gemini guest composer to appear
  let composerReady = false;
  for (let i = 0; i < 60; i++) {
    composerReady = await c.evaluate(`Boolean(location.hostname === 'gemini.google.com' && document.querySelector('rich-textarea [contenteditable="true"]'))`).catch(() => false);
    if (composerReady) break;
    await sleep(500);
  }
  assert.ok(composerReady, 'Gemini guest composer did not become ready');

  await ensureBridgeInjected(c);

  // 1. Verify status() in guest mode
  const statusEv = await waitForEvent(c, `e => e.type === 'status' && e.ready === true`, 15000);
  assert.equal(statusEv.loggedIn, false, 'Expected guest session to report loggedIn: false');
  assert.ok(statusEv.url.startsWith('https://gemini.google.com/app'), `Unexpected url: ${statusEv.url}`);
  console.log('PASS status event:', JSON.stringify(statusEv));

  // 2. Verify listModels() and listConversations() in guest mode
  await c.evaluate(`window.__qchatTestEvents = []; window.__qchat.listModels(); window.__qchat.listConversations(0);`);
  const modelsEv = await waitForEvent(c, `e => e.type === 'models'`, 15000);
  assert.ok(Array.isArray(modelsEv.models) && modelsEv.models.length >= 1, `Expected at least 1 model from listModels(), got: ${JSON.stringify(modelsEv)}`);
  assert.ok(modelsEv.models.some(m => m.selected), `Expected a selected model in listModels(), got: ${JSON.stringify(modelsEv.models)}`);
  console.log('PASS listModels event:', JSON.stringify(modelsEv.models));

  const convsEv = await waitForEvent(c, `e => e.type === 'conversations'`, 10000);
  assert.deepEqual(convsEv.items, [], 'Expected empty conversation list for guest');
  console.log('PASS listConversations guest event');

  // 3. Send one prompt asking for heading/list/bold/link/table/code/math/pineapple
  const prompt = 'Reply with: a markdown h2 heading, a two item bullet list, one bold word, a link to https://example.com, a small 2x2 markdown table, a fenced python code block, the inline formula $e=mc^2$, then the word pineapple.';
  await c.evaluate(`window.__qchatTestEvents = []; window.__qchat.send({ id: 'live-1', prompt: ${JSON.stringify(prompt)} });`);

  const startEv = await waitForEvent(c, `e => e.type === 'start' && e.id === 'live-1'`, 15000);
  assert.equal(startEv.id, 'live-1');

  const doneOrErr = await waitForEvent(
    c,
    `e => (e.type === 'done' || e.type === 'error') && e.id === 'live-1'`,
    60000
  );
  assert.equal(doneOrErr.type, 'done', `Expected done event but got error: ${JSON.stringify(doneOrErr)}`);

  const streamSummary = await c.evaluate(`(() => {
    const events = window.__qchatTestEvents || [];
    return {
      deltas: events.filter(e => e.type === 'delta' && e.id === 'live-1').length,
      activities: events.filter(e => e.type === 'activity' && e.id === 'live-1').length
    };
  })()`);
  assert.ok(streamSummary.deltas >= 1, 'Expected at least one delta event during streaming');
  assert.ok(doneOrErr.conversationId && doneOrErr.conversationId.length >= 8, `Expected conversationId on done event, got: ${doneOrErr.conversationId}`);

  const md = doneOrErr.text;
  assert.match(md, /^##\s+\S+/m, 'Expected markdown h2 heading in reply');
  assert.match(md, /^-\s+\S+/m, 'Expected markdown bullet list in reply');
  assert.match(md, /\*\*[^*]+\*\*/, 'Expected bold text in reply');
  assert.match(md, /\[[^\]]+\]\(https:\/\/example\.com\/?\)/, 'Expected markdown link to https://example.com in reply');
  assert.match(md, /\|.+\|[\s\S]*\| --- \|/, 'Expected markdown table in reply');
  assert.match(md, /```python[\s\S]*```/i, 'Expected fenced python code block in reply');
  assert.match(md, /\$e\s*=\s*mc\^2\$/i, 'Expected inline KaTeX math $e=mc^2$ in reply');
  assert.match(md, /pineapple/i, 'Expected word pineapple in reply');
  assert.ok(!md.includes('Gemini said'), 'Screen-reader label "Gemini said" must be stripped');
  assert.ok(!md.includes('More options'), 'Table footer button "More options" must be stripped');
  console.log('PASS send + markdown assertions:', JSON.stringify({
    conversationId: doneOrErr.conversationId,
    deltas: streamSummary.deltas,
    length: md.length
  }));

  await c.evaluate(`window.__qchatTestEvents = []; window.__qchat.send({id:'live-images',prompt:'Show me pictures of the Eiffel Tower.'})`);
  const imageDone = await waitForEvent(c, `e => (e.type === 'done' || e.type === 'error') && e.id === 'live-images'`, 60000);
  assert.equal(imageDone.type, 'done');
  assert.match(imageDone.text, /qchat-web:/);
  assert.ok(!imageDone.text.includes('Opens in a new window'));
  assert.ok(await c.evaluate(`window.__qchatTestEvents.some(e=>e.type==='delta' && e.id==='live-images' && /qchat-web:/.test(e.text || ''))`));
  console.log('PASS guest images in streaming and done snapshots');

  // 4. Test stop() API contract
  await c.evaluate(`window.__qchat.stop()`);
  console.log('PASS stop()');

  // 5. Test newChat() resets to a fresh blank chat
  await c.evaluate(`window.__qchatTestEvents = []; window.__qchat.newChat()`);
  let resetOk = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    await ensureBridgeInjected(c).catch(() => {});
    const state = await c.evaluate(`({
      pathname: location.pathname,
      ready: Boolean(document.querySelector('rich-textarea [contenteditable="true"]')),
      turns: document.querySelectorAll('model-response, user-query').length
    })`).catch(() => null);
    if (state && state.pathname === '/app' && state.ready && state.turns === 0) {
      resetOk = true;
      break;
    }
  }
  assert.ok(resetOk, 'Expected newChat() to return to /app with composer ready and 0 turns');
  console.log('PASS newChat() reset to blank /app');

  c.close();
  console.log('ALL LIVE CHECKS PASSED');
} finally {
  app.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(0);
