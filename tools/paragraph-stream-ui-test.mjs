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
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-animation-ui-'));
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
  const cssVar = (name) => evalJS(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const chat = (key, conv, ago, title = key) => ({ key, conversationId: conv, title, lastActive: Date.now() - ago, lastPrompt: `prompt ${key}`, lastResponse: `Cached **reply** for ${key}`, createdAt: Date.now() - ago });
  const seeded = (current, ...recent) => ({ v: 1, current, recent });


  const plain = `document.querySelector('[data-role=assistant] .turn-content')?.textContent.trimEnd()||''`;
  const emit = (type, text) => evalJS(`__mock.emit('bridge',{type:${JSON.stringify(type)},id:__mock.last('chat_send').args.id,text:${JSON.stringify(text)},conversationId:'animation-fixture'})`);
  const QCHAT_SETTINGS_V = 4;
  const begin = async (style = 'type') => {
    await open('/', {settings:{v:QCHAT_SETTINGS_V,animations:'on',autoDismiss:0,streamStyle:style}});
    await evalJS(`__mock.hold=true`);
    await send('Animation fixture');
    await until(`__mock.last('chat_send')`);
  };
  const capture = async (action, ms) => evalJS(`new Promise(resolve=>{
    const frames=[];const start=performance.now();${action}
    function sample(now){const b=document.querySelector('.bubble-response');const r=b?.getBoundingClientRect();
      frames.push({t:now-start,text:${plain},h:r?.height||0,w:r?.width||0,status:b?.closest('.turn-row').dataset.status});
      if(now-start<${ms})requestAnimationFrame(sample);else resolve(frames);}
    requestAnimationFrame(sample);
  })`);

  for (const motion of ['on','off']) {
    await open('/',{settings:{v:4,animations:motion,autoDismiss:0,streamStyle:'paragraph'}});
    await evalJS(`__mock.hold=true`); await send('Paragraph fixture'); await until(`__mock.last('chat_send')`);
    await emit('delta','First **rich** paragraph'); await sleep(100);
    check(`${motion}: unfinished paragraph buffered`,await evalJS(`(${plain})===''`));
    await emit('delta','First **rich** paragraph.\n\nSecond unfinished'); await sleep(100);
    check(`${motion}: complete rich paragraph`,await evalJS(`document.querySelector('.turn-content strong')?.textContent==='rich' && (${plain})==='First rich paragraph.'`));
    if (motion==='off') check('motion off adds no fade highlights',await evalJS(`!CSS.highlights.has('qchat-fade-0') && !CSS.highlights.has('qchat-fade-1') && !CSS.highlights.has('qchat-fade-2')`));
    await evalJS(`window.saved=document.querySelector('.turn-content p');window.savedText=saved.firstChild;const r=document.createRange();r.selectNodeContents(saved);getSelection().removeAllRanges();getSelection().addRange(r)`);
    const snapshot='First **rich** paragraph.\n\nSecond complete.\n\n';
    const frames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(snapshot)}});`,150);
    check(`${motion}: no word frames`,frames.every(f=>!f.text.includes('Second')||f.text.endsWith('Second complete.')));
    await emit('done','First **rich** paragraph.\n\nSecond complete.\n\nFinal tail'); await finishReply();
    check(`${motion}: final tail flushed`,await evalJS(`(${plain}).endsWith('Final tail')`));
    check(`${motion}: DOM and selection preserved`,await evalJS(`saved===document.querySelector('.turn-content p') && savedText===saved.firstChild && getSelection().toString()==='First rich paragraph.'`));
  }

  await begin('paragraph');
  for (const source of ['```js\na\n\nb\n','$$\nx\n\ny\n','<section><div>one\n\ntwo</div>\n\n','| a | b |\n|---|---|\n| x | y |\n']) {
    await emit('delta',source); await sleep(50);
    check('unfinished compound block buffered',await evalJS(`(${plain})===''`));
  }
  await emit('delta','Stopped final prose');
  await evalJS(`document.getElementById('btn-send').click()`); await sleep(100);
  check('Stop flushes unfinished prose',await evalJS(`(${plain})==='Stopped final prose'`));
  await begin('paragraph'); await emit('delta','Interrupted final prose');
  await evalJS(`__mock.emit('bridge',{type:'error',id:__mock.last('chat_send').args.id,code:'stream_failed'})`); await sleep(80);
  check('an error flushes the buffered partial reply',await evalJS(`(${plain})==='Interrupted final prose' && document.querySelector('[data-role=assistant]').dataset.status==='error'`));
  await begin('paragraph');
  const formatted=['## Streamed formatting','','<box><text>A **complete** paragraph with an <Entity value="inline label"/> and a [link](https://example.com/).</text></box>','','```js','const example = "<Entity value=\"literal\"/>";','```','','| Item | State |','| --- | --- |','| Paragraph | **Ready** |','','$$x^2 = 4$$','',''].join('\n');
  await emit('delta',formatted+'Unfinished next paragraph'); await sleep(100);
  check('completed tags, code, table and math render during the stream',await evalJS(`(()=>{const c=document.querySelector('[data-role=assistant] .turn-content');return c.querySelector('h2')?.textContent==='Streamed formatting' && c.querySelector('strong')?.textContent==='complete' && c.textContent.includes('inline label') && c.querySelector('pre code')?.textContent.includes('<Entity') && c.querySelector('td strong')?.textContent==='Ready' && !!c.querySelector('.katex') && !c.textContent.includes('Unfinished next');})()`));
  if (shotsDir) { await mkdir(shotsDir,{recursive:true}); const shot=await cdp('Page.captureScreenshot',{format:'png'}); await writeFile(path.join(shotsDir,'paragraph-streaming.png'),Buffer.from(shot.data,'base64')); }
  await emit('done',formatted+'Final paragraph.'); await finishReply();
  await begin('paragraph');
  const long=Array.from({length:65},(_,i)=>`Paragraph ${i} with enough words to fill the response area.`).join('\n\n')+'\n\n';
  await emit('delta',long); await sleep(700);
  await evalJS(`window.reader=document.querySelector('.bubble-scroll');reader.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));reader.scrollTop=100;window.readTop=reader.scrollTop;window.firstBlock=document.querySelector('.turn-content p')`);
  await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:true,url:'https://chatgpt.com/'})`);
  await emit('done',long+'Tail'); await finishReply(); await sleep(900);
  check('reader position survives completion',await evalJS(`reader===document.querySelector('.bubble-scroll') && Math.abs(reader.scrollTop-readTop)<2 && firstBlock===document.querySelector('.turn-content p')`));
  const record=long+'Tail\n\nSaved <mark>correction</mark>.';
  await evalJS(`__mock.emit('bridge',{type:'transcript',conversationId:'animation-fixture',complete:true,messages:[{role:'user',text:'Animation fixture'},{role:'assistant',text:${JSON.stringify(record)},media:[{file:'file_saved_image',kind:'image',name:'Saved image',before:true}],hasMedia:true}]})`);
  await sleep(200);
  check('saved corrections and images refresh in the existing bubble',await evalJS(`document.querySelector('.turn-content mark')?.textContent==='correction' && !!document.querySelector('.stored-media') && reader===document.querySelector('.bubble-scroll')`));
  check('a real delayed transcript event preserves the reader and finished DOM',await evalJS(`Math.abs(reader.scrollTop-readTop)<2 && firstBlock===document.querySelector('.turn-content p') && !document.querySelector('.jump-chip').hidden`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-animation-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
