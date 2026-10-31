// Maths rendering checks in an isolated, invisible Edge profile. Mock backend
// only: no account, no site access, no OS-level input. `--shots <dir>` also
// captures review PNGs.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-math-ui-'));
const requests = [];
const missing = [];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  requests.push(relative);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { missing.push(relative); res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, 'ui', relative));
    res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', CSP);
    res.end(bytes);
  } catch { missing.push(relative); res.writeHead(404).end(); }
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
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 600) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({rows:[...document.querySelectorAll('.turn-row')].map(r=>({role:r.dataset.role,status:r.dataset.status,hidden:r.hidden})),katex:document.querySelectorAll('.katex').length,qmath:document.querySelectorAll('[data-qmath]').length,text:document.querySelector('[data-role=assistant] .turn-content')?.textContent.slice(-120),requests:${JSON.stringify(requests.slice(-8))},now:performance.now()|0})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await until(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
    await evalJS(`window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI))`);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(500);
  const emit = (type, text) => evalJS(`__mock.emit('bridge',{type:${JSON.stringify(type)},id:__mock.last('chat_send').args.id,text:${JSON.stringify(text)},conversationId:'math-fixture'})`);
  const emitDelta = (text) => emit('delta', text);
  const visible = (text) => until(`(document.querySelector('[data-role=assistant] .turn-content')?.textContent||'').includes(${JSON.stringify(text)})`, `text ${text.slice(0, 30)}`);
  const begin = async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0, keepHistory: true } });
    await evalJS(`__mock.hold=true`);
    const before = await evalJS(`__mock.calls.length`);
    await send('Maths fixture');
    await until(`__mock.calls.length>${before} && __mock.last('chat_send')`);
    await until(`document.querySelector('[data-role=assistant]')`);
  };

  // --- A reply without maths must never load KaTeX ---------------------------
  await open('/', { settings: { animations: 'off', autoDismiss: 0, keepHistory: true } });
  await evalJS(`__mock.hold=true`);
  await send('No maths here');
  await until(`__mock.last('chat_send')`);
  const plainReply = 'Plain reply with **markdown**, a [link](https://example.com) and `$code$` inline.';
  await emit('done', plainReply);
  await finishReply();
  await settle();
  check('reply without maths renders no placeholders', await evalJS(`document.querySelectorAll('[data-qmath], .katex').length===0`));
  check('reply without maths never requests KaTeX', !requests.some((p) => /katex/i.test(p)), requests.filter((p) => /katex/i.test(p)).join(' '));
  check('reply without maths leaves the lazy loader untouched', await evalJS(`!document.querySelector('script[src*="katex"]') && !document.querySelector('link[href*="katex"]') && performance.getEntriesByType('resource').every(e=>!/katex/i.test(e.name))`));

  // --- Every delimiter, protected code and currency -------------------------
  const mathReply = [
    'Inline \\(x^2+y^2=z^2\\) inline.',
    '',
    'Display with brackets:',
    '',
    '\\[ \\int_0^1 x^2 \\, dx = \\frac{1}{3} \\]',
    '',
    'Dollar display:',
    '',
    '$$ \\sum_{i=1}^{n} i = \\frac{n(n+1)}{2} $$',
    '',
    'A long sum:',
    '',
    '\\[ a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_{10} = b_1 + b_2 + b_3 + b_4 + b_5 + b_6 + b_7 + b_8 + b_9 + b_{10} \\]',
    '',
    'Prices: $5 and $10 stay as text.',
    '',
    'Inline code `\\(not math\\)` and a fence:',
    '',
    '```tex',
    'Inline \\(a+b\\) and $$c$$ stay in the fence.',
    '```'
  ].join('\n');
  await begin();
  await emit('done', mathReply);
  await until(`document.querySelectorAll('.bubble-zone .katex').length===4`, 'four rendered formulas', 1200);
  await visible('stay in the fence');
  await settle();
  const counts = await evalJS(`({katex:document.querySelectorAll('.bubble-zone .katex').length,qmath:document.querySelectorAll('.bubble-zone [data-qmath]').length,display:document.querySelectorAll('.bubble-zone [data-display="1"]').length,block:document.querySelectorAll('.bubble-zone .math-block').length})`);
  check('inline maths renders with KaTeX', counts.katex===4 && counts.qmath===4, JSON.stringify(counts));
  check('bracket and dollar display maths render displayed', counts.display===3 && counts.block===3, JSON.stringify(counts));
  check('KaTeX loaded from self only once maths appeared', requests.some((p) => p === 'vendor/katex/katex.min.js') && requests.some((p) => p === 'vendor/katex/katex.min.css'), requests.filter((p) => /katex/i.test(p)).join(' '));
  check('KaTeX fonts are served from the app', requests.some((p) => /^vendor\/katex\/fonts\/.+\.woff2$/.test(p)), requests.filter((p) => /woff/i.test(p)).join(' '));
  check('missing KaTeX font formats are not requested', !requests.some((p) => /\.(woff|ttf)$/i.test(p)), requests.filter((p) => /\.(woff|ttf)$/i.test(p)).join(' '));
  check('TeX source is exposed as the formula label', await evalJS(`(()=>{const q=[...document.querySelectorAll('.bubble-zone [data-qmath]')];return q[0].getAttribute('aria-label')==='x^2+y^2=z^2' && q.slice(1).every(n=>n.getAttribute('aria-label').trim().length>4 && n.getAttribute('role')==='math');})()`));
  check('currency with two dollar signs stays text', await evalJS(`(()=>{const p=[...document.querySelectorAll('.bubble-zone .turn-content p')].find(p=>p.textContent.includes('$5 and $10'));return !!p && p.querySelectorAll('.qmath, .katex').length===0 && p.textContent.includes('$5 and $10');})()`));
  check('inline code is never treated as maths', await evalJS(`(()=>{const c=[...document.querySelectorAll('.bubble-zone .turn-content :not(pre) > code')].find(c=>c.textContent.includes('not math'));return !!c && c.textContent==='\\\\(not math\\\\)' && !c.querySelector('.katex');})()`));
  check('fenced code is never treated as maths', await evalJS(`(()=>{const c=[...document.querySelectorAll('.bubble-zone pre code')].find(c=>c.textContent.includes('a+b'));return !!c && c.textContent.includes('Inline \\\\(a+b\\\\) and $$c$$ stay in the fence.') && c.querySelectorAll('.katex, .qmath').length===0;})()`));
  const line = await evalJS(`(()=>{const p=[...document.querySelectorAll('.bubble-zone .turn-content p')].find(p=>p.querySelector('.qmath:not([data-display])'));const k=p.querySelector('.katex');return {p:p.getBoundingClientRect().height,lh:parseFloat(getComputedStyle(p).lineHeight),kh:k.getBoundingClientRect().height};})()`);
  check('inline maths does not raise the line height', line.kh<=line.lh+1 && line.p<=line.lh+2, JSON.stringify(line));
  const geo = await evalJS(`(()=>{const blocks=[...document.querySelectorAll('.bubble-zone .math-block')];const wide=blocks.map(b=>({sw:b.scrollWidth,cw:b.clientWidth})).sort((a,b)=>b.sw-a.sw)[0];const bubble=document.querySelector('.bubble-zone .bubble-response').getBoundingClientRect();const bar=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-w'));return {blocks:blocks.length,wide,overflow:getComputedStyle(blocks[0]).overflowX,bubble:bubble.width,bar};})()`);
  check('long display maths scrolls inside its own wrapper', geo.wide.sw>geo.wide.cw+2 && geo.overflow==='auto', JSON.stringify(geo));
  check('display maths does not widen the reply bubble', geo.bubble<=640+2, JSON.stringify(geo));
  const copied = await evalJS(`(async()=>{let value=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{value=String(t)}}});document.querySelector('.bubble-zone [data-action="copy-turn"]').click();await new Promise(r=>setTimeout(r,40));return value;})()`);
  check('Copy reply keeps the original TeX source', typeof copied==='string' && copied.includes('\\(x^2+y^2=z^2\\)') && copied.includes('$$ \\sum_{i=1}^{n}') && copied.includes('\\int_0^1'), String(copied).slice(0, 120));

  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    await settle();
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(shotsDir, 'math-reply.png'), Buffer.from(data, 'base64'));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  }

  await evalJS(`document.getElementById('btn-history').click()`);
  await until(`!document.getElementById('history-panel').hidden && document.querySelectorAll('#history-panel .katex').length===4`, 'history maths', 1200);
  await settle();
  check('history renders the same maths', await evalJS(`document.querySelectorAll('#history-panel .math-block').length===3 && document.querySelectorAll('#history-panel .katex-display').length===3`));
  check('history keeps the raw source for copying', await evalJS(`(()=>{const row=[...document.querySelectorAll('#history-panel .history-row[data-role=assistant]')].at(-1);return row?._copyText.includes('$$ \\\\sum_{i=1}^{n}') && row._copyText.includes('\\\\int_0^1');})()`));

  // --- Streaming: incomplete stays text, then one stable node ---------------
  await begin();
  await evalJS(`window.__katexCalls=0`);
  const partial = 'Euler wrote \\(e^{i\\pi}';
  await emitDelta(partial);
  await visible('Euler wrote');
  check('incomplete formula waits instead of flashing as raw TeX', await evalJS(`(()=>{const c=document.querySelector('.bubble-zone .turn-content');return document.querySelectorAll('.bubble-zone .katex').length===0 && !c.textContent.includes('e^{i');})()`));
  const complete = 'Euler wrote \\(e^{i\\pi} + 1 = 0\\) and moved on.';
  await emitDelta(complete);
  await until(`document.querySelector('.bubble-zone .katex')`, 'completed formula', 1200);
  await sleep(120);
  const instrumented = await evalJS(`(()=>{const original=window.katex.renderToString.bind(window.katex);window.katex.renderToString=(...args)=>{window.__katexCalls++;return original(...args)};window.__mathNode=document.querySelector('.bubble-zone .katex');window.__mathSpan=document.querySelector('.bubble-zone [data-qmath]');return {calls:window.__katexCalls,node:!!window.__mathNode}})()`);
  check('formula renders as soon as its closer arrives', instrumented.node && instrumented.calls===0, JSON.stringify(instrumented));
  await emitDelta(complete + ' More words follow.');
  await visible('More words follow.');
  await sleep(150);
  const stability = await evalJS(`({sameNode:window.__mathNode===document.querySelector('.bubble-zone .katex'),sameSpan:window.__mathSpan===document.querySelector('.bubble-zone [data-qmath]'),connected:window.__mathNode?.isConnected,rerenders:window.__katexCalls,text:document.querySelector('.bubble-zone .turn-content')?.textContent.includes('More words follow.')})`);
  check('the same formula nodes survive later stream frames', stability.sameNode && stability.sameSpan && stability.connected && stability.text, JSON.stringify(stability));
  check('a completed formula is not re-rendered on later frames', stability.rerenders===0, JSON.stringify(stability));
  await emit('done', complete + ' More words follow.');
  await finishReply();
  await settle();

  // --- Malformed TeX falls back to code -------------------------------------
  await begin();
  const broken = 'Broken formula \\(\\frac{1}{\\) here.';
  await emit('done', broken);
  await until(`document.querySelector('.bubble-zone .math-raw')`, 'raw fallback', 1200);
  await settle();
  check('malformed formula does not throw', problems.length===0, problems.slice(0, 3).join(' | '));
  check('malformed formula shows its raw source as code', await evalJS(`(()=>{const raw=document.querySelector('.bubble-zone .math-raw');return !!raw && raw.tagName==='CODE' && raw.textContent==='\\\\frac{1}{' && !raw.closest('[data-qmath]')?.querySelector('.katex');})()`));

  // --- Restored chats render maths ------------------------------------------
  const savedReply = 'Saved reply with inline \\(a^2+b^2\\) and display:\n\n\\[ \\frac{\\pi}{2} \\]';
  const savedChats = {
    v: 1,
    current: {
      key: 'math-restore', conversationId: null, title: 'Maths', lastActive: Date.now(),
      lastPrompt: 'Saved maths', lastResponse: savedReply, createdAt: Date.now(),
      transcript: [
        { id: 'u1', role: 'user', text: 'Saved maths' },
        { id: 'a1', role: 'assistant', text: savedReply }
      ]
    },
    recent: []
  };
  await open('/', { settings: { animations: 'off', autoDismiss: 0, keepHistory: true }, chats: savedChats });
  await settle();
  await evalJS(`document.getElementById('btn-history').click()`);
  await until(`document.querySelectorAll('#history-panel .katex').length===2`, 'restored maths', 1200);
  check('restored chats render maths from saved Markdown', await evalJS(`(()=>{const q=[...document.querySelectorAll('#history-panel [data-qmath]')];return q.length===2 && q[1].getAttribute('data-display')==='1' && document.querySelector('#history-panel .katex-display');})()`));

  check('no security policy violations', await evalJS(`window.__csp.length===0`), (await evalJS(`window.__csp`)).join(' | '));
  check('no failed asset requests', missing.filter((p) => !/favicon/i.test(p)).length===0, missing.join(' '));
  check('no console errors or exceptions', problems.length===0, problems.slice(0, 5).join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error('console:', problems.slice(0, 5).join(' | ')); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-math-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
