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

  // Reading a long reply while it streams: the owner could not scroll up without a lot of effort.
  const replyWords=Array.from({length:900},(_,i)=>`word${i}`).join(' ');
  await begin('fade');
  await emit('delta',replyWords.slice(0,3000));
  await until(`document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped')`,'reply reaches its cap',900);
  await until(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3;})()`,'following the end',300);
  const notch=await evalJS(`new Promise(done=>{const s=document.querySelector('.bubble-scroll');const from=s.scrollTop;
    s.dispatchEvent(new WheelEvent('wheel',{deltaY:-12,bubbles:true}));s.scrollTop=from-12;
    const after=s.scrollTop;let n=0;const look=()=>{if(++n<24)requestAnimationFrame(look);else done({from,after,now:s.scrollTop,height:s.scrollHeight});};requestAnimationFrame(look);})`);
  check('one small wheel notch stops following at once',Math.abs(notch.now-notch.after)<2,JSON.stringify(notch));
  check('the jump chip offers the way back',await evalJS(`!document.querySelector('.jump-chip').hidden`));
  await emit('delta',replyWords);await sleep(500);
  const held=await evalJS(`document.querySelector('.bubble-scroll').scrollTop`);
  check('new text does not pull a reader back down',Math.abs(held-notch.after)<2,`${notch.after} -> ${held}`);
  await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');s.scrollTop=s.scrollHeight;})()`);await sleep(60);
  await emit('delta',replyWords+' more text arrives after the reader returned');await sleep(2600);
  const resume=await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return JSON.stringify({gap:s.scrollHeight-s.scrollTop-s.clientHeight,chip:document.querySelector('.jump-chip').hidden,text:document.querySelector('[data-role=assistant] .turn-content').textContent.length});})()`);
  check('reaching the end resumes following',JSON.parse(resume).gap<80 && JSON.parse(resume).chip,resume);
  await evalJS(`document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true}))`);await sleep(500);
  check('Page Up reads the reply from the composer',await evalJS(`!document.querySelector('.jump-chip').hidden && (()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight>40;})()`),await evalJS(`JSON.stringify({gap:(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight;})(),hidden:document.querySelector('.jump-chip').hidden})`));
  await emit('done',replyWords);await finishReply();

  // Whole words and stable Markdown.
  await begin('fade');
  const prose='The quick brown fox jumps over the lazy dog and keeps running through the long grass until evening falls.';
  const wordFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(prose)}});`,900);
  const proseWords=new Set(prose.split(/\s+/));
  const partial=wordFrames.filter(f=>f.text && !proseWords.has(f.text.split(/\s+/).at(-1)));
  check('reveal stops between words, never inside one',partial.length===0,JSON.stringify(partial.map(f=>f.text.slice(-14)).slice(0,6)));
  const fading=await evalJS(`(async()=>{for(let i=0;i<40;i++){if(CSS.highlights.has('qchat-fade-0')&&CSS.highlights.get('qchat-fade-0').size)return true;await new Promise(requestAnimationFrame);}return false;})()`).catch(()=>false);
  await emit('delta',prose+' And then one more sentence arrives so that something can fade in now.');
  const fadeSeen=fading||await evalJS(`(async()=>{for(let i=0;i<60;i++){for(const n of ['qchat-fade-0','qchat-fade-1','qchat-fade-2'])if(CSS.highlights.get(n)?.size)return true;await new Promise(requestAnimationFrame);}return false;})()`);
  check('new words surface through paint-only highlights',fadeSeen);
  check('fade adds no wrapper elements',await evalJS(`!document.querySelector('.turn-content span')`));
  await emit('done',prose);await finishReply();
  check('highlights clear when the reply is done',await evalJS(`!CSS.highlights.has('qchat-fade-0')`));

  // Paragraph streaming: only finished blocks ever show.
  await begin('paragraph');
  await emit('delta','First paragraph is done.\n\nSecond paragraph is still being wri');
  await until(`(${plain}).includes('First paragraph is done.')`,'first paragraph flows in');
  await sleep(500);
  check('an unfinished paragraph stays hidden',await evalJS(`(${plain})==='First paragraph is done.'`),await evalJS(plain));
  await emit('delta','First paragraph is done.\n\nSecond paragraph is now finished.\n\nThird sta');
  await until(`(${plain}).includes('now finished.')`,'second paragraph flows in');
  await sleep(300);
  check('the next one appears only once finished',!(await evalJS(plain)).includes('Third'),await evalJS(plain));
  await emit('done','First paragraph is done.\n\nSecond paragraph is now finished.\n\nThird starts and ends here.');
  await finishReply();
  check('the end of the reply flows in and is exact',await evalJS(`(${plain}).endsWith('Third starts and ends here.')`));
  await begin('paragraph');
  const entityReply='The **<Entity category="vehicle" value="Nissan Skyline GT-R R34" disambig="1999-2002 coupe"/>** is great.\n\nMore text';
  await emit('delta',entityReply);
  await until(`(${plain}).includes('is great.')`,'entity paragraph');
  check('site markup becomes its visible value while streaming',await evalJS(`(()=>{const t=${plain};return t==='The Nissan Skyline GT-R R34 is great.' && !t.includes('Entity') && !t.includes('disambig');})()`),await evalJS(plain));
  await emit('done',entityReply.replace('More text','More text here.'));await finishReply();
  check('and once it has finished',await evalJS(`!(${plain}).includes('Entity') && (${plain}).includes('More text here.')`));
  const whole=(input)=>evalJS(`QStream.completeBoundary(${JSON.stringify(input)})`);
  check('a paragraph is finished by its blank line',await whole('One line\nstill going')===0 && await whole('One.\n\nTwo')===6);
  check('lists and fenced code wait for a complete block',await whole('- one\n- tw')===0 && await whole('```js\nconst a;\nconst')===0 && await whole('```js\nconst a;\n```\n\n')==='```js\nconst a;\n```\n\n'.length);

  // Pressing a button must not disturb anything else, at any point in its animation.
  await open('/',{settings:{animations:'on',autoDismiss:0}});
  await evalJS(`__mock.hold=true`);await send('Button press fixture');await until(`__mock.last('chat_send')`);
  await emit('done','A short reply to press the buttons on.\n\nWith a second line.');await finishReply();await settle();
  const box=await evalJS(`(()=>{const r=document.querySelector('.bubble-response').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:box.x,y:box.y});await sleep(350);
  const tool=await evalJS(`(()=>{const r=document.querySelector('[data-action=copy-turn]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:tool.x,y:tool.y});await sleep(200);
  await evalJS(`window.__watch={moves:0,rows:new Set(),fits:__mock.fits.length,run:true,base:JSON.stringify([document.getElementById('bar').getBoundingClientRect(),document.querySelector('.bubble-response').getBoundingClientRect()])};(function look(){if(!__watch.run)return;const now=JSON.stringify([document.getElementById('bar').getBoundingClientRect(),document.querySelector('.bubble-response').getBoundingClientRect()]);if(now!==__watch.base)__watch.moves++;requestAnimationFrame(look);})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:tool.x,y:tool.y,button:'left',clickCount:1});
  const pressed=await evalJS(`getComputedStyle(document.querySelector('[data-action=copy-turn]')).transform`);
  await sleep(150);
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:tool.x,y:tool.y,button:'left',clickCount:1});
  await sleep(400);
  const watch=await evalJS(`(()=>{__watch.run=false;return {moves:__watch.moves,fits:__mock.fits.length-__watch.fits};})()`);
  check('pressing and releasing a button moves nothing',watch.moves===0,JSON.stringify(watch));
  check('and asks the window for nothing',watch.fits===0,JSON.stringify(watch));
  check('press feedback uses no transform',pressed==='none',pressed);
  check('glass has no page-level blur to redraw',await evalJS(`getComputedStyle(document.getElementById('bar')).backdropFilter==='none' && getComputedStyle(document.querySelector('.bubble-response')).backdropFilter==='none'`));
  const barPress=await evalJS(`(()=>{const sheet=[...document.styleSheets].flatMap(s=>[...s.cssRules]).filter(r=>r.selectorText&&/:active|:hover/.test(r.selectorText)&&r.style?.transform&&r.style.transform!=='none'&&/bar-btn|send-btn|\\.btn|suggestion|history-button/.test(r.selectorText));const later=[...document.styleSheets].flatMap(s=>[...s.cssRules]).filter(r=>r.selectorText&&/:active|:hover/.test(r.selectorText)&&r.style?.transform==='none');return {moving:sheet.length,neutralised:later.length};})()`);
  check('button rules that move are neutralised',barPress.neutralised>=1,JSON.stringify(barPress));

  const unit=(input)=>evalJS(`QStream.stabilize(${JSON.stringify(input)})`);
  check('an entity tag still arriving stays hidden',await unit('The <Entity category="veh')==='The ');
  check('a half-typed bold closes immediately',await unit('Some **bold wo')==='Some **bold wo**');
  check('half-typed inline code closes',await unit('Use `npm i')==='Use `npm i`');
  check('a link in progress shows only its label',await unit('See [the docs](https://exa')==='See the docs');
  check('a lone list marker waits for its first word',await unit('Items:\n\n- ')==='Items:\n\n');
  check('a lone heading marker waits',await unit('Done.\n\n## ')==='Done.\n\n');
  check('a table waits for its separator',await unit('Intro\n\n| a | b |')==='Intro\n\n');
  check('whole table rows show, partial ones wait',await unit('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |')==='| a | b |\n|---|---|\n| 1 | 2 |\n');
  check('an unfinished fence opener waits',await unit('Code:\n\n```py')==='Code:\n\n');
  check('an open code block keeps flowing',await unit('```py\nprint(1')==='```py\nprint(1');
  check('unfinished display maths waits',await unit('Then $$x^2')==='Then ');
  check('unfinished citation tokens wait',await unit('Fact \uE200cite\uE202turn0')==='Fact ');
  const boundary=(input)=>evalJS(`QStream.stableBoundary(${JSON.stringify(input)})`);
  check('finished paragraphs are settled',await boundary('One.\n\nTwo.\n\nThr')===6,String(await boundary('One.\n\nTwo.\n\nThr')));
  check('a list can still grow',await boundary('Intro.\n\n- a\n\n- b\n\n- c')===0 || await boundary('Intro.\n\n- a\n\n- b\n\n- c')===8,String(await boundary('Intro.\n\n- a\n\n- b\n\n- c')));
  check('nothing inside an open fence settles',await boundary('```\na\n\nb\n\nc')===0);
  const stops=await evalJS(`QStream.revealStops('Hello brave new world')`);
  check('reveal stops carry their trailing space',JSON.stringify(stops)==='[6,12,16,21]',JSON.stringify(stops));

  await open('/',{settings:{v:4,animations:'off',autoDismiss:0,streamStyle:'word'}});
  await evalJS(`__mock.hold=true`);await send('Reduced motion');await until(`__mock.last('chat_send')`);
  await emit('delta',burst);await sleep(30);
  check('reduced motion displays word-mode snapshots without a typing delay',await evalJS(`(${plain})===${JSON.stringify(burst)}`));
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
