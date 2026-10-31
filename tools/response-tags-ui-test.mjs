// Bubble UI checks and screenshots in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input. `--shots <dir>` also captures review PNGs.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://images.openai.com; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-history-ui-'));
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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|images\.openai\.com/.test(m.params.entry.url || '')) problems.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({rows:[...document.querySelectorAll('.turn-row')].map(r=>({role:r.dataset.role,status:r.dataset.status,hidden:r.hidden,cls:r.className})),calls:window.__mock?.calls.slice(-4).map(c=>c.cmd),fits:window.__mock?.fits.length,lastFits:window.__mock?.fits.slice(-4).map(x=>x.height),text:document.querySelector('[data-role=assistant] .turn-content')?.textContent.length,capped:document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped'),now:performance.now()|0,hold:window.__mock?.hold,rel:!!window.__mock?.release,btn:document.getElementById('btn-send')?.dataset.mode})`).catch(() => 'n/a');
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
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };

  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  const text = '<Future-panel><h2>Heading</h2><p><strong>Bold</strong> and <mark>marked</mark></p><details><summary>More</summary>Details</details><table><tr><th>A</th></tr><tr><td>B</td></tr></table><Link href="https://example.com" title="Go"/><Cite refs={["turn1search0"]}/></Future-panel>\n\n`<Entity value="literal"/>`\n\n~~~\n<Cite ref="literal"/>\n~~~';
  await open('/', {settings:{v:4,animations:'off',autoDismiss:0},chats:{v:1,current:{key:'tags',conversationId:null,title:'Tags',lastActive:1,lastPrompt:'Hi',lastResponse:text,sources:[{id:'turn1search0',url:'https://example.com/source',title:'Source'}],createdAt:1},recent:[]}});
  await settle();
  const result = await evalJS(`(()=>{const c=document.querySelector('.bubble-zone .turn-content');return {heading:c.querySelector('h2')?.textContent,bold:c.querySelector('strong')?.textContent,mark:c.querySelector('mark')?.textContent,table:c.querySelector('td')?.textContent,details:c.querySelector('summary')?.textContent,code:[...c.querySelectorAll('code')].map(x=>x.textContent),raw:c.textContent.includes('Future-panel'),unsafe:!!c.querySelector('script,iframe,[onclick]'),link:!!c.querySelector('a[href="https://example.com/"]')};})()`);
  check('saved replies render semantic HTML and future wrappers',result.heading==='Heading' && result.bold==='Bold' && result.mark==='marked' && result.table==='B' && result.details==='More' && !result.raw,JSON.stringify(result));
  check('literal inline and fenced markup survives',result.code.some(x=>x.includes('<Entity value="literal"/>')) && result.code.some(x=>x.includes('<Cite ref="literal"/>')),JSON.stringify(result));
  check('links are safe and controls inert',result.link && !result.unsafe,JSON.stringify(result));
  const extra = '<Future label="&lt;img src=x onerror=alert(1)&gt;"/><u onclick="alert(2)">Underlined</u><table><tr><td><strong>Cell bold</strong></td></tr></table><ol start="3"><li>First</li><li>Second<ul><li>Nested</li></ul></li></ol>';
  await open('/', {settings:{v:4,animations:'off',autoDismiss:0,streamStyle:'word'}});
  await evalJS(`window.__tagLeaks=[];window.__tagObserver=new MutationObserver(()=>{for(const el of document.querySelectorAll('[data-role=assistant] .turn-content')){const c=el.cloneNode(true);c.querySelectorAll('pre,code').forEach(n=>n.remove());if(/<(?:Future|Entity|Cite|box|table)\\b/.test(c.textContent))window.__tagLeaks.push(c.textContent)}});window.__tagObserver.observe(document.querySelector('.bubble-zone'),{subtree:true,childList:true,characterData:true});window.__mock.reply=${JSON.stringify('<box><title>Streaming</title><Entity value="Visible"/><Cite ref="unknown"/></box>\n\n' + extra)};window.__mock.interval=1`);
  await send('Tag regression'); await finishReply(); await settle();
  const streamed=await evalJS(`(()=>{window.__tagObserver.disconnect();const c=document.querySelector('[data-role=assistant] .turn-content');return {visible:c.textContent.includes('Visible'),leaks:window.__tagLeaks.length,unsafe:!!c.querySelector('img,script,iframe,[onclick]'),nested:!!c.querySelector('ol ul li'),start:c.querySelector('ol')?.start,cell:c.querySelector('td strong')?.textContent};})()`);
  check('streaming fragments stay readable without raw tags or active content',streamed.visible && !streamed.leaks && !streamed.unsafe,JSON.stringify(streamed));
  check('table emphasis and nested list numbering render correctly',streamed.nested && streamed.start===3 && streamed.cell==='Cell bold',JSON.stringify(streamed));
  const reviewed = '<p><b>Hello</b> <i>world</i> <code>a \` b</code></p>\n\n$x < y$\n\n$$a < b$$\n\n\\(a <b\\) and \\[x < y\\]\n\n<blockquote><pre><Entity value="literal"/></pre></blockquote>\n\nAn Array<object> keeps the rest of this reply.';
  await open('/',{settings:{v:4,animations:'off',autoDismiss:0,streamStyle:'instant'}});
  await evalJS('window.__mock.reply='+JSON.stringify(reviewed)+';window.__mock.interval=1');
  await send('Reviewed tag edge cases'); await finishReply();
  await until("document.querySelectorAll('.bubble-zone .katex').length===4",'four inequalities render',1200);
  const reviewedState=await evalJS("(()=>{const c=document.querySelector('[data-role=assistant] .turn-content');return {words:c.textContent.includes('Hello world'),math:c.querySelectorAll('.katex').length,raw:c.querySelectorAll('.math-raw,.katex-error').length,inline:[...c.querySelectorAll('code')].some(x=>x.textContent==='a \` b'),quoted:c.querySelector('blockquote pre code')?.textContent.includes('<Entity value=\"literal\"/>'),tail:c.textContent.includes('Array<object> keeps the rest of this reply.')};})()");
  check('inequalities render with KaTeX after tag processing',reviewedState.math===4 && !reviewedState.raw,JSON.stringify(reviewedState));
  check('inline spaces, nested code and generic prose survive rendering',reviewedState.words && reviewedState.inline && reviewedState.quoted && reviewedState.tail,JSON.stringify(reviewedState));
  check('no runtime errors',problems.length===0,problems.slice(0,3).join(' | '));
  if (shotsDir) { await mkdir(shotsDir,{recursive:true}); const shot=await cdp('Page.captureScreenshot',{format:'png'}); await writeFile(path.join(shotsDir,'response-tags.png'),Buffer.from(shot.data,'base64')); }
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-history-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
