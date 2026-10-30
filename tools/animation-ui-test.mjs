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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

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
  const begin = async () => {
    await open('/', {settings:{animations:'on',autoDismiss:0}});
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
  await begin();
  const burst='abcdefghijklmnopqrstuvwxyz'.repeat(4);
  const frames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(burst)}});`,650);
  const lengths=[...new Set(frames.map(f=>f.text.length))];
  const steps=frames.slice(1).map((f,i)=>f.text.length-frames[i].text.length).filter(n=>n>0);
  check('one backend chunk reveals through many character steps',lengths.length>12 && steps.filter(n=>n<=2).length>=8,JSON.stringify({lengths,steps}));
  const final=burst+' Final characters continue at the same pace.';
  const doneFrames=await capture(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(final)},conversationId:'animation-fixture'});`,140);
  check('DONE keeps revealing its tail instead of dumping the final chunk',doneFrames[0].text.length<final.length && new Set(doneFrames.map(f=>f.text)).size>2,JSON.stringify(doneFrames.map(f=>f.text.length)));
  await finishReply();
  check('final displayed and saved response are exact',await evalJS(`(${plain})===${JSON.stringify(final)} && JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse===${JSON.stringify(final)}`));
  await emit('delta','late stale text');
  await sleep(80);
  check('late snapshots cannot restart completed responses',await evalJS(`(${plain})===${JSON.stringify(final)}`));

  await begin();
  const plainList='First item\nSecond item';
  const formattedList='1. **First item**\n2. **Second item**';
  await emit('delta',plainList);
  await until(`(${plain}).includes('First item') && (${plain}).includes('Second item')`, 'plain list fully visible');
  const formattedFrames=await capture(`
    __mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(formattedList)}});
    __mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(formattedList)},conversationId:'animation-fixture'});
  `,350);
  check('final Markdown formatting never removes or replays the visible list',formattedFrames.every(f=>f.text.includes('First item') && f.text.includes('Second item')) && new Set(formattedFrames.map(f=>f.text)).size===1,JSON.stringify(formattedFrames.map(f=>f.text)));
  await finishReply();
  check('formatted list renders and saves the exact raw Markdown',await evalJS(`document.querySelectorAll('[data-role=assistant] .turn-content ol li strong').length===2 && JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse===${JSON.stringify(formattedList)}`));

  await begin();
  const unicode='A👩‍💻B🇳🇿Ce\u0301D👍🏽'.repeat(6);
  const boundaries=new Set([0]);
  let chars=0;
  for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(unicode)){chars+=part.segment.length;boundaries.add(chars);}
  const unicodeFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(unicode)}});`,850);
  check('character reveal never splits emoji or combining graphemes',unicodeFrames.every(f=>boundaries.has(f.text.length) && unicode.startsWith(f.text)),JSON.stringify(unicodeFrames.map(f=>f.text)));
  await emit('done',unicode);await finishReply();

  for(const [prefix,extended] of [['Ae','Ae\u0301'],['A👩','A👩‍💻']]) {
    await begin();
    await emit('delta',prefix);
    await until(`(${plain})===${JSON.stringify(prefix)}`, 'grapheme prefix visible');
    const extensionFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(extended)}});`,120);
    check(`visible grapheme extension replaces atomically (${extended})`,extensionFrames.every(f=>f.text===extended),JSON.stringify(extensionFrames.map(f=>f.text)));
    await emit('done',extended);await finishReply();
  }

  await begin();
  const lines=Array.from({length:12},(_,i)=>`Line ${i+1}`).join('\n\n');
  const lineFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(lines)}});`,1600);
  const lineSizes=lineFrames.filter(f=>f.h>0 && f.t>350);
  check('explicit newlines grow smoothly without bouncing',lineSizes.length>8 && lineSizes.at(-1).h>lineSizes[0].h && lineSizes.slice(1).every((f,i)=>f.h>=lineSizes[i].h-1 && (f.h-lineSizes[i].h)/Math.max(1,f.t-lineSizes[i].t)<1),JSON.stringify(lineSizes.map(f=>Math.round(f.h))));
  await emit('done',lines);await finishReply();

  await begin();
  const words=Array.from({length:300},(_,i)=>`word${i}`).join(' ');
  const wrapped=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(words)}});`,3200);
  const shown=wrapped.filter(f=>f.h>0 && f.t>350);
  const drops=shown.slice(1).filter((f,i)=>f.h<shown[i].h-1);
  const speeds=shown.slice(1).map((f,i)=>(f.h-shown[i].h)/Math.max(1,f.t-shown[i].t));
  check('wrapped lines grow without height reversals',shown.length>8 && shown.at(-1).h>shown[0].h && drops.length===0,JSON.stringify(shown.map(f=>Math.round(f.h))));
  check('new lines ease through intermediate heights',speeds.every(v=>v<1),JSON.stringify({maxPixelsPerMs:Math.max(...speeds)}));
  check('stream wrapping keeps a stable text width',new Set(shown.map(f=>Math.round(f.w))).size===1,JSON.stringify([...new Set(shown.map(f=>Math.round(f.w)))]));
  check('line growth uses bounded native window resizes',await evalJS(`__mock.fits.length<10`));
  await emit('done',words);await finishReply();await settle();
  await until(`document.querySelector('[data-role=assistant]').hasAttribute('data-capped')`);
  check('capped stream follows the latest line',await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3;})()`));

  await begin();
  await emit('delta','Old phrase with a buffered ending.');
  await until(`(${plain}).length>=4`, 'correction has visible text and a pending tail');
  const corrected='Corrected phrase 🌿 with a new ending.';
  const correctionFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(corrected)}});`,180);
  check('visible correction replaces once and cancels the old reveal callback',correctionFrames.every(f=>f.text===corrected),JSON.stringify(correctionFrames.map(f=>f.text)));
  const appended=corrected+' Subsequent characters still arrive at the normal streaming pace.';
  const appendFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(appended)}});`,160);
  check('appended text after a correction resumes pacing without replay',appendFrames.every(f=>f.text.startsWith(corrected)) && appendFrames[0].text.length<appended.length && new Set(appendFrames.map(f=>f.text)).size>2,JSON.stringify(appendFrames.map(f=>f.text.length)));
  await emit('done',appended);await finishReply();
  check('upstream correction and appended tail finish exactly',await evalJS(`(${plain})===${JSON.stringify(appended)}`));

  await begin();
  await emit('delta','Buffered response '.repeat(30));await sleep(80);
  await key('.',{ctrlKey:true});await sleep(150);
  const stopped=await evalJS(plain);await sleep(180);
  check('Stop cancels the character queue and leaves a stable partial reply',await evalJS(`(${plain})===${JSON.stringify(stopped)} && document.getElementById('btn-send').dataset.mode==='send'`));
  await key('n',{ctrlKey:true});await until(`!document.querySelector('.turn-row')`);
  check('new chat cancels pending reveal frames',await evalJS(`!document.querySelector('.turn-row')`));

  await open('/',{settings:{animations:'off',autoDismiss:0}});
  await evalJS(`__mock.hold=true`);await send('Reduced motion');await until(`__mock.last('chat_send')`);
  await emit('delta',burst);await sleep(30);
  check('reduced motion displays snapshots without a typing delay',await evalJS(`(${plain})===${JSON.stringify(burst)}`));
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
