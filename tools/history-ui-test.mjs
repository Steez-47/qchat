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

  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  await open('/', {settings:{animations:'off',autoDismiss:0,keepHistory:true}});
  await evalJS(`__mock.hold=true`);
  const reply = async (prompt, text) => {
    const before=await count('chat_send');
    await send(prompt);
    await until(`__mock.count('chat_send')>${before}`);
    await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(text)},conversationId:'history-fixture'})`);
    await finishReply();
    await sleep(100);
  };
  const longPrompt='Beginning of long prompt\n'+ 'long user line\n'.repeat(100)+'End of long prompt';
  const longReply='Beginning of long response\n\n'+'long response line\n\n'.repeat(3500)+'End of long response';
  await reply(longPrompt,longReply);await settle();
  const awayFromTop=`document.getElementById('history-controls').hasAttribute('data-away') && getComputedStyle(document.getElementById('btn-history')).pointerEvents==='none'`;
  check('button steps aside while reading further down a long reply',await evalJS(awayFromTop));
  await evalJS(`document.querySelector('.bubble-scroll').scrollTop=0`);await sleep(100);
  check('button returns at the top of a long reply',!await evalJS(awayFromTop));
  check('history button fits above an already scrollable long reply',await evalJS(`(()=>{const b=document.getElementById('btn-history').getBoundingClientRect(),r=document.querySelector('.bubble-scroll');return b.top>=0 && b.bottom<=r.getBoundingClientRect().top && r.scrollHeight>r.clientHeight && __mock.fit.height>=document.getElementById('stack').offsetHeight+56;})()`));
  const textTop=`(()=>{const p=[...document.querySelectorAll('.turn-content p')].find(x=>x.textContent==='Beginning of long response'&&x.offsetParent);return p.getBoundingClientRect().top;})()`;
  const beforeOpen=await evalJS(textTop);
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  const afterOpen=await evalJS(textTop);
  check('opening history from the top of a long reply does not jump',Math.abs(beforeOpen-afterOpen)<4,`${beforeOpen} -> ${afterOpen}`);
  await evalJS(`document.getElementById('history-panel').scrollTop-=60`);await sleep(60);
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  check('Latest hands back at the end of the long reply',await evalJS(`document.getElementById('history-panel').hidden && (()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3;})()`));
  await reply('Second prompt','Second answer');
  await until(`document.getElementById('btn-history') && !document.getElementById('btn-history').hidden`);
  await evalJS(`document.getElementById('btn-history').click()`);
  await until(`!document.getElementById('history-panel').hidden`);
  await settle();
  check('opens at the latest message, not the oldest',await evalJS(`(()=>{const p=document.getElementById('history-panel');return p.scrollTop>0 && p.scrollHeight-p.scrollTop-p.clientHeight<2;})()`));
  check('history messages are the normal bubbles',await evalJS(`(()=>{const rows=[...document.querySelectorAll('#history-panel .turn-row')],u=rows.find(r=>r.dataset.role==='user')?.querySelector('.bubble.bubble-user.glass'),a=rows.find(r=>r.dataset.role==='assistant')?.querySelector('.bubble.bubble-response.glass');const radius=e=>parseFloat(getComputedStyle(e).borderTopLeftRadius);return rows.length===4 && !!u && !!a && radius(u)===radius(a) && radius(a)>=12 && !document.querySelector('#history-panel .history-role');})()`));
  check('short messages hug their text instead of filling the column',await evalJS(`(()=>{const rows=[...document.querySelectorAll('#history-panel .turn-row')],last=rows.at(-1).querySelector('.bubble'),prompt=rows.at(-2).querySelector('.bubble');const stack=document.getElementById('stack').offsetWidth;return last.offsetWidth<stack*0.6 && prompt.offsetWidth<stack*0.6 && rows.at(-2).getBoundingClientRect().right>rows.at(-1).getBoundingClientRect().right;})()`));
  check('bubbles at rest are fully formed',await evalJS(`[...document.querySelectorAll('#history-panel .turn-row')].slice(-2).every(r=>parseFloat(getComputedStyle(r).opacity)>0.98)`));
  check('history contains full prompts and uncapped responses',await evalJS(`(()=>{const p=document.getElementById('history-panel'),t=p.textContent;return t.includes(${JSON.stringify(longPrompt)}) && t.includes('Beginning of long response') && t.includes('End of long response') && t.includes('Second prompt') && t.includes('Second answer') && p.querySelectorAll('[data-role=assistant] .turn-content p').length===3503;})()`));
  check('history uses a scrollable bounded viewport',await evalJS(`(()=>{const p=document.getElementById('history-panel');return p.scrollHeight>p.clientHeight && p.clientHeight>100 && getComputedStyle(p).overflowY==='auto';})()`));
  if (shotsDir) { await mkdir(shotsDir,{recursive:true}); const {data}=await cdp('Page.captureScreenshot',{format:'png'}); await writeFile(path.join(shotsDir,'history-latest.png'),Buffer.from(data,'base64')); }
  await evalJS(`document.getElementById('history-panel').scrollTop=0`);await sleep(50);
  check('oldest message is reachable',await evalJS(`document.getElementById('history-panel').scrollTop===0 && document.getElementById('history-panel').textContent.includes('Beginning of long prompt')`));
  check('history and controls stay in window',await evalJS(`(()=>{const p=document.getElementById('history-panel').getBoundingClientRect(),b=document.getElementById('btn-history').getBoundingClientRect();return p.top>=0 && p.bottom<=innerHeight && b.top>=0 && b.bottom<=innerHeight;})()`));
  if (shotsDir) { await mkdir(shotsDir,{recursive:true}); const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); await writeFile(path.join(shotsDir,'history.png'),Buffer.from(data,'base64')); }
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  check('Latest restores compact mode',await evalJS(`document.getElementById('history-panel').hidden && !!document.querySelector('.bubble-zone [data-role=assistant]')`));
  await open('/',{keep:true});await settle();
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  check('full transcript survives reload',await evalJS(`(()=>{const t=document.getElementById('history-panel').textContent;return t.includes('Beginning of long prompt') && t.includes('End of long response') && t.includes('Second answer');})()`));
  await evalJS(`document.getElementById('btn-history').click();__mock.hold=true`);
  await evalJS(`document.getElementById('prompt-input').focus()`);await send('Streaming third prompt');await until(`__mock.last('chat_send')?.args.prompt==='Streaming third prompt'`);
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Streaming first chunk'});document.getElementById('btn-history').click()`);await settle();
  await evalJS(`document.getElementById('history-panel').scrollTop=80`);await sleep(50);
  const scrollBefore=await evalJS(`document.getElementById('history-panel').scrollTop`);
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Streaming first chunk and more text'});`);await sleep(150);
  check('streaming does not move history reading position',await evalJS(`Math.abs(document.getElementById('history-panel').scrollTop-${scrollBefore})<2`));
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:'Streaming first chunk and more text',conversationId:'history-fixture'})`);await sleep(100);
  check('live response updates in history',await evalJS(`document.getElementById('history-panel').textContent.includes('Streaming first chunk and more text')`));
  await evalJS(`document.getElementById('btn-history').click()`);
  await key('n',{ctrlKey:true});await settle();
  check('new chat does not show previous transcript',await evalJS(`document.getElementById('history-panel').hidden`));
  await evalJS(`document.querySelector('#tabs .tab').click()`);await settle();
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  check('switching back restores the whole chat transcript',await evalJS(`document.getElementById('history-panel').textContent.includes('End of long response') && document.getElementById('history-panel').textContent.includes('Streaming third prompt')`));
  const chatsVersion=await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).v`);
  await open('/',{settings:{animations:'off',autoDismiss:0,keepHistory:true},chats:{v:chatsVersion,current:{key:'legacy-chat',conversationId:'legacy-conversation',title:'Latest',lastActive:1,lastPrompt:'Latest prompt',lastResponse:'Latest **reply**',createdAt:1},recent:[]}});await settle();
  await evalJS(`document.getElementById('btn-history').click()`);await settle();
  await until(`__mock.count('chat_read_transcript')===1`,'backfill request',800);
  check('backfill asks the page for the conversation',true);
  check('shows that earlier messages are loading',await evalJS(`document.getElementById('history-status').textContent==='Loading earlier messages' && !document.getElementById('history-status').hidden`));
  const pageMessages=[{role:'user',text:'Way older prompt'},{role:'assistant',text:'Way older **reply**'},{role:'user',text:'Latest prompt'},{role:'assistant',text:'Latest reply'}];
  const emitTranscript=`__mock.emit('bridge',{type:'transcript',conversationId:'legacy-conversation',messages:${JSON.stringify(pageMessages)}})`;
  await evalJS(emitTranscript);await settle();
  check('loading status clears',await evalJS(`document.getElementById('history-status').hidden`));
  check('older ChatGPT messages appear above saved ones, once, as bubbles',await evalJS(`(()=>{const rows=[...document.querySelectorAll('#history-panel .turn-row')];return rows.length===4 && rows[0].textContent==='Way older prompt' && rows[1].querySelector('.bubble-response strong')?.textContent==='reply' && rows[3].querySelector('strong')?.textContent==='reply';})()`));
  await evalJS(emitTranscript);await settle();
  check('repeat page reads add nothing',await evalJS(`document.querySelectorAll('#history-panel .turn-row').length===4`));
  check('backfilled history is saved',await evalJS(`localStorage.getItem('qchat.chats').includes('Way older prompt')`));
  await evalJS(`__mock.emit('bridge',{type:'transcript',conversationId:'another-conversation',messages:[{role:'user',text:'Wrong chat'}]})`);await sleep(100);
  await evalJS(`__mock.emit('bridge',{type:'transcript',conversationId:'legacy-conversation',messages:null})`);await sleep(60);
  check('a failed read says so instead of staying silent',await evalJS(`document.getElementById('history-status').textContent.includes("Couldn't load")`));
  check('another conversation is ignored',await evalJS(`!document.getElementById('history-panel').textContent.includes('Wrong chat')`));
  // Motion on, with a realistic conversation: the pop itself and the look of the bubbles.
  const talk=[['Can you explain what a monad is?','A **monad** is a way to chain operations that carry some extra context.\n\nThink of it as a pipeline where each step decides how to pass its result along.'],['Short example?','```js\nconst r = Some(2).map(x => x + 1);\n```'],['Thanks!','You are welcome.'],['What about functors?','A functor is the simpler idea: anything you can `map` over.\n\n- Lists\n- Promises\n- Optionals'],['And applicatives?','They sit in between, letting you apply a wrapped function to a wrapped value.'],['Which should I learn first?','Start with functors, then applicatives, then monads. Each one builds on the one before, so the order makes the later ones feel obvious rather than magical.'],['ok','Have fun with it.']];
  const transcript=talk.flatMap(([q,a],i)=>[{id:`q${i}`,role:'user',text:q},{id:`a${i}`,role:'assistant',text:a}]);
  await open('/',{settings:{autoDismiss:0,keepHistory:true},chats:{v:chatsVersion,current:{key:'talk',conversationId:null,title:'Monads',lastActive:1,lastPrompt:'ok',lastResponse:'Have fun with it.',transcript,createdAt:1},recent:[]}});await settle();
  const shot=async(name)=>{ if (!shotsDir) return; await mkdir(shotsDir,{recursive:true}); const {data}=await cdp('Page.captureScreenshot',{format:'png'}); await writeFile(path.join(shotsDir,name),Buffer.from(data,'base64')); };
  await shot('compact.png');
  check('the button sits above the live bubble',await evalJS(`document.getElementById('btn-history').getBoundingClientRect().bottom<=document.querySelector('.bubble-zone .bubble').getBoundingClientRect().top`));
  const liveBottom=await evalJS(`document.querySelector('.bubble-zone .bubble').getBoundingClientRect().bottom`);
  const liveLeft=await evalJS(`document.querySelector('.bubble-zone .bubble').getBoundingClientRect().left`);
  await evalJS(`document.getElementById('btn-history').click()`);await settle();await sleep(400);
  await shot('history-open.png');
  check('the latest bubble stays exactly where it was',await evalJS(`(()=>{const b=[...document.querySelectorAll('#history-panel .bubble')].at(-1).getBoundingClientRect();return Math.abs(b.bottom-${liveBottom})<3 && Math.abs(b.left-${liveLeft})<3;})()`),await evalJS(`JSON.stringify([${liveBottom},${liveLeft},[...document.querySelectorAll('#history-panel .bubble')].at(-1).getBoundingClientRect()])`));
  check('with motion on, bubbles at rest are fully formed',await evalJS(`[...document.querySelectorAll('#history-panel .turn-row')].slice(-3).every(r=>parseFloat(getComputedStyle(r).opacity)>0.98)`));
  check('the panel fits its messages, up to the cap',await evalJS(`(()=>{const p=document.getElementById('history-panel');return p.clientHeight>100 && p.clientHeight<=p.scrollHeight;})()`));
  const edge=(side)=>`(()=>{const p=document.getElementById('history-panel'),rows=[...p.children],box=p.getBoundingClientRect();const r=rows.find(c=>{const b=c.getBoundingClientRect();return ${side==='top'?'b.top<box.top+14 && b.bottom>box.top':'b.bottom>box.bottom-2 && b.top<box.bottom'};});return r?parseFloat(getComputedStyle(r).opacity):null;})()`;
  const scan=async(side)=>{ let seen=null; const max=await evalJS(`document.getElementById('history-panel').scrollHeight`); for (let y=0;y<max;y+=9) { await evalJS(`new Promise(d=>{document.getElementById('history-panel').scrollTop=${y};requestAnimationFrame(()=>requestAnimationFrame(d));})`); const o=await evalJS(edge(side)); if (o!==null && o<0.9) { seen=o; break; } } return seen; };
  const topFade=await scan('top');
  check('bubbles pop out at the top edge',topFade!==null,String(topFade));
  await shot('history-mid.png');
  const bottomFade=await scan('bottom');
  check('bubbles pop in at the bottom edge',bottomFade!==null,String(bottomFade));
  await evalJS(`document.getElementById('history-panel').scrollTop=120`);await sleep(700);
  const lag=await evalJS(`new Promise(done=>{const p=document.getElementById('history-panel');p.dispatchEvent(new WheelEvent('wheel',{deltaY:80,clientY:p.getBoundingClientRect().bottom-10,bubbles:true}));p.scrollTop+=80;let seen=0,n=0;const look=()=>{for(const r of p.children){const m=/translate3d\\(0px, (-?[\\d.]+)px/.exec(r.style.transform);if(m)seen=Math.max(seen,Math.abs(parseFloat(m[1])));}if(++n<20)requestAnimationFrame(look);else done(seen);};requestAnimationFrame(look);})`);
  check('scrolling pushes and pulls the bubbles apart',lag>2,String(lag));
  await sleep(900);
  check('and the springs settle back to nothing',await evalJS(`[...document.getElementById('history-panel').children].every(r=>!r.style.transform||parseFloat(r.style.opacity)===0||/translate3d\\(0px, -?0\\.\\d+px/.test(r.style.transform))`));
  await evalJS(`document.getElementById('history-panel').scrollTop=0`);await sleep(500);
  const rubber=await evalJS(`new Promise(done=>{const p=document.getElementById('history-panel');p.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,clientY:p.getBoundingClientRect().top+200,bubbles:true}));let seen=0,n=0;const look=()=>{for(const r of p.children){const m=/translate3d\\(0px, (-?[\\d.]+)px/.exec(r.style.transform);if(m)seen=Math.max(seen,parseFloat(m[1]));}if(++n<14)requestAnimationFrame(look);else done(seen);};requestAnimationFrame(look);})`);
  check('pulling past the top stretches and springs back',rubber>2,String(rubber));
  await sleep(700);
  await evalJS(`document.getElementById('btn-history').click()`);
  await until(`document.getElementById('history-panel').hasAttribute('data-leaving')`,'glide to latest finishes',300);
  check('leaving history fades in place while the live bubble returns',await evalJS(`document.getElementById('history-panel').hasAttribute('data-leaving') && !!document.querySelector('.bubble-zone .bubble').offsetHeight`));
  await settle();
  check('leaving history finishes cleanly',await evalJS(`document.getElementById('history-panel').hidden && document.getElementById('history-panel').childElementCount===0 && document.getElementById('history-label').textContent==='History'`));
  await open('/',{settings:{animations:'off',autoDismiss:0,keepHistory:false}});
  await evalJS(`__mock.hold=true`);await reply('Private prompt','Private answer');
  check('disabled history does not persist transcript',await evalJS(`localStorage.getItem('qchat.chats')===null`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
  // Every command the UI calls must be allowed natively; the mock cannot catch a missing entry.
  const uiSource=await readFile(path.join(root,'ui/app.js'),'utf8');
  const manifest=await readFile(path.join(root,'src-tauri/build.rs'),'utf8');
  const capability=await readFile(path.join(root,'src-tauri/capabilities/main.json'),'utf8');
  const commands=[...new Set([...uiSource.matchAll(/invoke\("([a-z_]+)"/g)].map(m=>m[1]))];
  const denied=commands.filter(c=>!manifest.includes(`"${c}"`)||!capability.includes(`"allow-${c.replaceAll('_','-')}"`));
  check('every UI command is on the native allow-list',commands.includes('chat_read_transcript') && denied.length===0,denied.join());
  // The real bridge against a real DOM shaped like ChatGPT's conversation.
  await cdp('Page.navigate',{url:'about:blank'});await sleep(100);
  const bridgeSource=await readFile(path.join(root,'src-tauri/bridge/chatgpt-bridge.js'),'utf8');
  const pageDom=`<main><article data-turn="user"><div data-message-author-role="user" data-message-id="u1"><div data-user-message-bubble>First <b>question</b></div></div><button>Edit</button></article><article data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown"><h2>Title</h2><p>Some <strong>bold</strong> and <a href="https://example.com/x">link</a></p><ul><li><p>one</p></li><li>two</li></ul><pre><div>python<button>Copy</button></div><code class="language-python">print(1)\n</code></pre><table><tr><th>A</th></tr><tr><td>1</td></tr></table><button>Good</button></div></div></article><article data-turn="user"><div data-message-author-role="user"><div data-user-message-bubble>Second</div></div></article><article data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown"><p>Answer</p></div><img src="https://chatgpt.com/x.png"></div></article></main>`;
  await evalJS(`document.body.innerHTML=${JSON.stringify(pageDom)};window.__events=[];window.__QCHAT_EMIT__=e=>{window.__events.push(e)};`);
  await evalJS(`((location)=>{${bridgeSource}})({hostname:'chatgpt.com',href:'https://chatgpt.com/c/abcdefgh',pathname:'/c/abcdefgh',origin:'https://chatgpt.com'})`);
  await evalJS(`window.__qchat.readConversation('abcdefgh')`);await sleep(250);
  const read=await evalJS(`window.__events.find(e=>e.type==='transcript')`);
  check('bridge reads the rendered conversation in order',read?.conversationId==='abcdefgh' && read.messages.map(m=>m.role).join()==='user,assistant,user,assistant' && read.messages[0].text==='First question' && read.messages[2].text==='Second' && read.messages[3].hasMedia===true,JSON.stringify(read));
  check('bridge turns replies back into markdown without page buttons',read?.messages[1].text.startsWith('## Title\n\nSome **bold** and [link](https://example.com/x)\n\n- one\n- two\n\n```python\nprint(1)\n```\n\n| A |') && !read.messages[1].text.includes('Good') && !read.messages[1].text.includes('Copy'),read?.messages[1].text);
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
