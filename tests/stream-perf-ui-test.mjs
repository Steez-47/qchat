// Streaming cost: deltas coalesce into one pass per frame, finished code blocks are not
// rebuilt, and cached highlighting matches a fresh one. Mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-stream-perf-ui-'));
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
  const open = async (url = '/', { settings } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await waitFor(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify(settings))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(120);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true })}));})()`);
  const ghosts = () => evalJS(`document.querySelectorAll('[data-ghost]').length`);
  const anim = (sel) => evalJS(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return n?getComputedStyle(n).animationName:null})()`);
  const leaveMs = () => evalJS(`Math.round(QSettings.timings.t1*1.1)`);

  const emit = (type, text) => evalJS(`__mock.emit('bridge',{type:${JSON.stringify(type)},id:__mock.last('chat_send').args.id,text:${JSON.stringify(text)},conversationId:'perf-fixture'})`);
  const fence = (lang, n, tag) => '```' + lang + '\n' + Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}, "s${i}"); // line ${i}`).join('\n') + '\n```';

  await open('/?mock=1', { settings: { animations: 'on', autoDismiss: 0, streamStyle: 'paragraph' } });
  await evalJS(`__mock.hold=true`);
  await type('perf'); await key('Enter');
  await waitFor(`__mock.last('chat_send')`);
  await evalJS(`window.__bounds=0;const real=QStream.completeBoundary;QStream.completeBoundary=t=>{__bounds++;return real(t)}`);

  // A burst of deltas inside one task is read once, on the next frame, with only the latest text.
  const words = 'The quick brown fox jumps over the lazy dog again and again'.split(' ');
  const sync = await evalJS(`(()=>{let acc='';for(let i=0;i<60;i++){acc+=${JSON.stringify(words)}[i%12]+' ';__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:acc})}return __bounds})()`);
  check('a burst of deltas is not read synchronously', sync === 0, String(sync));
  check('the unfinished burst stays hidden before its frame', await evalJS(`(document.querySelector('[data-role=assistant] .turn-content')?.textContent||'')===''`));
  await sleep(200);
  check('the burst is read once, not sixty times', await evalJS(`__bounds`) <= 2, String(await evalJS(`__bounds`)));
  check('unfinished text is still withheld after the frame', await evalJS(`(document.querySelector('[data-role=assistant] .turn-content')?.textContent||'')===''`));

  // Finished code blocks keep their highlighted nodes as the reply grows by more blocks.
  const one = `Intro paragraph.\n\n${fence('js', 30, 'a')}\n\n`;
  await emit('delta', one + 'Next');
  await waitFor(`document.querySelectorAll('[data-role=assistant] pre code').length===1`, 3000);
  await evalJS(`window.__firstCode=document.querySelector('[data-role=assistant] pre code');window.__firstTok=__firstCode.querySelector('.tok-keyword')`);
  const two = one + `Middle paragraph with \`code\` and **bold**.\n\n${fence('py', 25, 'b')}\n\n`;
  await emit('delta', two + 'More');
  await waitFor(`document.querySelectorAll('[data-role=assistant] pre code').length===2`, 3000);
  check('an earlier code block keeps its nodes when a later block arrives', await evalJS(`document.querySelector('[data-role=assistant] pre code')===__firstCode && __firstCode.contains(__firstTok) && !!__firstTok`));
  check('highlighted nodes live in the page document', await evalJS(`[...document.querySelectorAll('[data-role=assistant] pre code span')].every(s=>s.ownerDocument===document)`));

  // A cached highlight is identical to a fresh one, and never shared between blocks.
  await emit('done', two + `Same block again:\n\n${fence('js', 30, 'a')}`);
  await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 3000);
  check('a repeated block highlights the same as a fresh render', await evalJS(`(()=>{const codes=[...document.querySelectorAll('[data-role=assistant] pre code')];if(codes.length!==3)return false;const fresh=document.createElement('code');QHighlight.highlightInto(fresh,codes[0].textContent+' ','js');const again=document.createElement('code');QHighlight.highlightInto(again,codes[2].textContent,'js');return codes[0].innerHTML===codes[2].innerHTML&&again.innerHTML===codes[2].innerHTML&&codes[0].firstChild!==codes[2].firstChild})()`));
  check('changing the code re-highlights it', await evalJS(`(()=>{const c=document.createElement('code');QHighlight.highlightInto(c,'let x = 1','js');const a=c.innerHTML;QHighlight.highlightInto(c,'let y = "s"','js');return a!==c.innerHTML&&c.textContent==='let y = "s"'})()`));
  check('the same text in another language is highlighted for that language', await evalJS(`(()=>{const a=document.createElement('code'),b=document.createElement('code');QHighlight.highlightInto(a,'def f(): return 1','py');QHighlight.highlightInto(b,'def f(): return 1','text');return a.querySelector('.tok-keyword')&&!b.querySelector('span')})()`));
  check('the final reply keeps every word', await evalJS(`document.querySelector('[data-role=assistant] .turn-content').textContent.includes('Same block again')`));

  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-stream-perf-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
