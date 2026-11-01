// Bubble UI checks and screenshots in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input. `--shots <dir>` also captures review PNGs.
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('animation-ui', { problems });
  const { cdp, evalJS } = browserPage;
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
    await cdp('Page.navigate', { url: `${base}/__blank` });
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
  const frames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(burst)}});`,300);
  check('unfinished backend chunk stays hidden on every frame',frames.length>5 && frames.every(f=>f.text===''));
  const final=burst+' Final characters arrive together.';
  const doneFrames=await capture(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(final)},conversationId:'animation-fixture'});`,140);
  check('DONE displays its complete final snapshot without a character queue',doneFrames.every(f=>f.text===final),JSON.stringify(doneFrames.map(f=>f.text.length)));
  await finishReply();
  check('final displayed and saved response are exact',await evalJS(`(${plain})===${JSON.stringify(final)} && JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse===${JSON.stringify(final)}`));
  await emit('delta','late stale text'); await sleep(80);
  check('late snapshots cannot restart completed responses',await evalJS(`(${plain})===${JSON.stringify(final)}`));

  await begin();
  const plainList='First item\nSecond item';
  const formattedList='1. **First item**\n2. **Second item**';
  await emit('delta',plainList); await sleep(100);
  check('unfinished list snapshot stays buffered',await evalJS(`(${plain})===''`));
  const formattedFrames=await capture(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(formattedList)},conversationId:'animation-fixture'});`,200);
  check('final list appears completely formatted in every visible frame',formattedFrames.every(f=>f.text.includes('First item') && f.text.includes('Second item')) && new Set(formattedFrames.map(f=>f.text)).size===1);
  await finishReply();
  check('formatted list renders and saves the exact raw Markdown',await evalJS(`document.querySelectorAll('[data-role=assistant] .turn-content ol li strong').length===2 && JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse===${JSON.stringify(formattedList)}`));

  await begin();
  const unicode='A👩‍💻B🇳🇿Ce\u0301D👍🏽'.repeat(6);
  const unicodeFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(unicode+'\n\n')}});`,180);
  check('finished Unicode block never splits emoji or combining graphemes',unicodeFrames.every(f=>f.text===unicode));
  await emit('done',unicode); await finishReply();
  for(const [prefix,extended] of [['Ae','Ae\u0301'],['A👩','A👩‍💻']]) {
    await begin(); await emit('delta',prefix+'\n\n');
    await until(`(${plain})===${JSON.stringify(prefix)}`,'completed Unicode prefix');
    const extensionFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(extended+'\n\n')}});`,120);
    check(`completed grapheme correction replaces atomically (${extended})`,extensionFrames.every(f=>f.text===extended));
    await emit('done',extended); await finishReply();
  }

  await begin();
  const lines=Array.from({length:12},(_,i)=>`Line ${i+1}`).join('\n\n');
  const lineFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(lines+'\n\n')}});`,800);
  const lineSizes=lineFrames.filter(f=>f.h>0 && f.t>350);
  check('finished multiline block appears atomically',lineFrames.every(f=>f.text.includes('Line 12') && f.text.includes('Line 1')));
  check('completed block viewport settles without height reversals',lineSizes.length>8 && lineSizes.slice(1).every((f,i)=>f.h>=lineSizes[i].h-1));
  await emit('done',lines); await finishReply();

  await begin();
  const words=Array.from({length:300},(_,i)=>`word${i}`).join(' ');
  const wrapped=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(words+'\n\n')}});`,1000);
  const shown=wrapped.filter(f=>f.h>0 && f.t>350);
  check('large paragraph arrives without partial word frames',wrapped.every(f=>f.text===words));
  check('wrapped block has no height reversals',shown.length>8 && shown.slice(1).every((f,i)=>f.h>=shown[i].h-1));
  check('stream wrapping keeps a stable text width',new Set(shown.map(f=>Math.round(f.w))).size===1);
  check('block arrival uses bounded native window resizes',await evalJS(`__mock.fits.length<10`));
  await emit('done',words); await finishReply(); await settle();
  await until(`document.querySelector('[data-role=assistant]').hasAttribute('data-capped')`);
  check('capped stream follows the latest block',await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3;})()`));

  await begin();
  await emit('delta','Old phrase.\n\nA buffered ending');
  await until(`(${plain})==='Old phrase.'`,'correction has a completed prefix');
  const corrected='Corrected phrase 🌿 with a new ending.';
  const correctionFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(corrected+'\n\nUnfinished tail')}});`,180);
  check('completed upstream correction replaces once and keeps its tail hidden',correctionFrames.every(f=>f.text===corrected));
  const appended=corrected+'\n\nSubsequent paragraph arrives completely.';
  const appendFrames=await capture(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(appended+'\n\nIncomplete')}});`,160);
  check('appending a complete block keeps the corrected prefix and hides the new tail',appendFrames.every(f=>f.text.startsWith(corrected) && f.text.endsWith('arrives completely.') && !f.text.includes('Incomplete')));
  await emit('done',appended); await finishReply();
  check('upstream correction and appended tail finish exactly',await evalJS(`(()=>{const p=[...document.querySelectorAll('[data-role=assistant] .turn-content p')];return p.length===2 && p[0].textContent===${JSON.stringify(corrected)} && p[1].textContent==='Subsequent paragraph arrives completely.' && JSON.parse(localStorage.getItem('qchat.chats')).current.lastResponse===${JSON.stringify(appended)};})()`));

  await begin();
  const stoppedText='Buffered response '.repeat(30);
  await emit('delta',stoppedText); await sleep(80);
  check('Stop fixture starts with a buffered reply',await evalJS(`(${plain})===''`));
  await key('.',{ctrlKey:true}); await sleep(150);
  await emit('delta','stale text after Stop'); await sleep(180);
  check('Stop flushes all received text and ignores later snapshots',await evalJS(`(${plain})===${JSON.stringify(stoppedText.trimEnd())} && document.getElementById('btn-send').dataset.mode==='send'`));
  await key('n',{ctrlKey:true}); await until(`!document.querySelector('.turn-row')`);
  check('new chat has no pending reveal frames',await evalJS(`!document.querySelector('.turn-row')`));

  // Completed blocks must preserve the reader's position while new blocks arrive.
  const paragraphs=Array.from({length:80},(_,i)=>`Paragraph ${i}: `+Array.from({length:12},(_,j)=>`word${i}_${j}`).join(' '));
  const replyWords=paragraphs.join('\n\n');
  await begin('fade');
  await emit('delta',paragraphs.slice(0,40).join('\n\n')+'\n\n');
  await until(`document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped')`,'reply reaches its cap',900);
  await settle();
  await until(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<3;})()`,'following the end',300);
  const notch=await evalJS(`new Promise(done=>{const s=document.querySelector('.bubble-scroll');const from=s.scrollTop;s.dispatchEvent(new WheelEvent('wheel',{deltaY:-12,bubbles:true}));s.scrollTop=from-12;const after=s.scrollTop;let n=0;const look=()=>{if(++n<24)requestAnimationFrame(look);else done({from,after,now:s.scrollTop,height:s.scrollHeight});};requestAnimationFrame(look);})`);
  check('one small wheel notch stops following at once',Math.abs(notch.now-notch.after)<2,JSON.stringify(notch));
  check('the jump chip offers the way back',await evalJS(`!document.querySelector('.jump-chip').hidden`));
  await emit('delta',replyWords+'\n\n'); await sleep(500);
  const held=await evalJS(`document.querySelector('.bubble-scroll').scrollTop`);
  check('new completed blocks do not pull a reader back down',Math.abs(held-notch.after)<2,`${notch.after} -> ${held}`);
  await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');s.scrollTop=s.scrollHeight;})()`); await sleep(60);
  await emit('delta',replyWords+'\n\nMore text arrives after the reader returned.\n\n'); await sleep(700);
  const resume=await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return {gap:s.scrollHeight-s.scrollTop-s.clientHeight,chip:document.querySelector('.jump-chip').hidden};})()`);
  check('reaching the end resumes following',resume.gap<80 && resume.chip,JSON.stringify(resume));
  await evalJS(`document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true}))`); await sleep(500);
  check('Page Up reads the reply from the composer',await evalJS(`!document.querySelector('.jump-chip').hidden && (()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight>40;})()`));
  await emit('done',replyWords); await finishReply();

  await begin('fade');
  const prose='The quick brown fox jumps over the lazy dog.';
  const fadeSeen=await evalJS(`(async()=>{__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(prose+'\n\nUnfinished')}});for(let i=0;i<40;i++){for(const n of ['qchat-fade-0','qchat-fade-1','qchat-fade-2'])if(CSS.highlights.get(n)?.size)return true;await new Promise(requestAnimationFrame);}return false;})()`);
  check('completed blocks still use paint-only fade highlights',fadeSeen);
  check('fade adds no wrapper elements or unfinished words',await evalJS(`!document.querySelector('.turn-content span') && (${plain})===${JSON.stringify(prose)}`));
  await emit('done',prose); await finishReply();
  check('highlights clear when the reply is done',await evalJS(`!CSS.highlights.has('qchat-fade-0')`));

  await begin('paragraph');
  await emit('delta','First paragraph is done.\n\nSecond paragraph is still being wri');
  await until(`(${plain}).includes('First paragraph is done.')`,'first finished paragraph');
  await sleep(100);
  check('an unfinished paragraph stays hidden',await evalJS(`(${plain})==='First paragraph is done.'`));
  await emit('delta','First paragraph is done.\n\nSecond paragraph is now finished.\n\nThird sta');
  await until(`(${plain}).includes('now finished.')`,'second finished paragraph');
  check('the next one appears only once finished',!(await evalJS(plain)).includes('Third'));
  await emit('done','First paragraph is done.\n\nSecond paragraph is now finished.\n\nThird starts and ends here.');
  await finishReply();
  check('the end of the reply is exact',await evalJS(`(${plain}).endsWith('Third starts and ends here.')`));
  await begin('paragraph');
  const entityReply='The **<Entity category="vehicle" value="Nissan Skyline GT-R R34" disambig="1999-2002 coupe"/>** is great.\n\nMore text';
  await emit('delta',entityReply);
  await until(`(${plain}).includes('is great.')`,'entity paragraph');
  check('completed site markup becomes its visible value',await evalJS(`(()=>{const t=${plain};return t==='The Nissan Skyline GT-R R34 is great.' && !t.includes('Entity') && !t.includes('disambig');})()`));
  await emit('done',entityReply.replace('More text','More text here.')); await finishReply();
  check('site markup stays rendered once finished',await evalJS(`!(${plain}).includes('Entity') && (${plain}).includes('More text here.')`));
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
  check('motion off keeps unfinished word-mode snapshots hidden',await evalJS(`(${plain})===''`));
  await emit('delta',burst+'\n\n'); await sleep(80);
  check('motion off releases a finished block at once',await evalJS(`(${plain})===${JSON.stringify(burst)}`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
