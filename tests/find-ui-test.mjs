// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('find-ui', { problems });
  const { cdp, evalJS } = browserPage;
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
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await waitFor(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(70);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const inputValue = () => evalJS(`document.getElementById('prompt-input').value`);
  const until = async (expr) => { if (!await waitFor(expr)) throw new Error(`Timed out: ${expr}`); };
  const oldAnswer = ['Older NEEDLE answer.', ...Array.from({length:55},(_,i)=>`Paragraph ${i} keeps the older conversation scrollable.`), 'hel**lo** world and [literal.*]', 'BlockOne', 'BlockTwo'].join('\n\n');
  const code = '```js\nconst veryLongLine = "'+'x'.repeat(180)+'HORIZONTAL_TARGET";\n```';
  const transcript = [
    {id:'old-u',role:'user',text:'Needle in an older question.',selectionTexts:['Hidden selection needle']},
    {id:'old-a',role:'assistant',text:oldAnswer},
    {id:'unicode-u',role:'user',text:'Kia ora 🌏'},
    {id:'unicode-a',role:'assistant',text:'Ātaahua Māori 🌏\n\n'+code},
    {id:'latest-u',role:'user',text:'Latest question'},
    {id:'latest-a',role:'assistant',text:'Latest answer'}
  ];
  const seed = (key, turns=transcript, provider='chatgpt') => ({key,provider,title:key,conversationId:null,lastActive:Date.now(),createdAt:Date.now(),lastPrompt:turns.findLast(t=>t.role==='user')?.text||'',lastResponse:turns.findLast(t=>t.role==='assistant')?.text||'',draft:'',transcript:turns});
  const show = async (prefs={}, turns=transcript) => {
    await open('/',{settings:{animations:'off',autoDismiss:0,streamStyle:'instant',codeWrap:false,look:'midnight',...prefs},chats:{v:1,current:seed('search',turns),recent:[seed('other',[{id:'other-u',role:'user',text:'Other provider private phrase'},{id:'other-a',role:'assistant',text:'Different answer'}],'gemini')]}});
    await evalJS("window.copyWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>copyWrites.push(text)}});document.execCommand=()=>false");
  };
  const countText = () => evalJS("document.getElementById('find-count').textContent.replace(/\\s/g,'')");
  const query = async text => {
    await evalJS(`(()=>{const input=document.getElementById('find-input');input.focus();input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(90);
  };
  const find = async text => {
    await key('f',{ctrlKey:true});
    await until("document.getElementById('find-bar')&&!document.getElementById('find-bar').hidden");
    if (text!==undefined) await query(text);
  };
  const ranges = () => evalJS("Array.from(CSS.highlights.get('qchat-find')||[],range=>range.toString())");
  const active = () => evalJS("Array.from(CSS.highlights.get('qchat-find-current')||[])[0]?.startContainer.parentElement.closest('.history-row')?.dataset.id");
  const clean = () => evalJS("(()=>{const bar=document.getElementById('find-bar');return bar.hidden&&getComputedStyle(bar).display==='none'&&bar.getClientRects().length===0&&!CSS.highlights.has('qchat-find')&&!CSS.highlights.has('qchat-find-current')})()");
  const shot = async name => {
    const dir=path.join(root,'.tmp','find-shots');await mkdir(dir,{recursive:true});
    const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(path.join(dir,name+'.png'),Buffer.from(data,'base64'));
  };
  const browserKey = async (key,code,windowsVirtualKeyCode,modifiers=0) => {
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers});
  };

  await open('/',{settings:{animations:'off',autoDismiss:0}}); await key('f',{ctrlKey:true});
  check('empty chat gives useful feedback without opening history',await evalJS("document.getElementById('history-panel').hidden&&/no messages|nothing|empty/i.test(document.getElementById('command-feedback').textContent)"));
  await show();await type('keep this draft');await evalJS("document.getElementById('prompt-input').setSelectionRange(2,7)");await find('needle');
  check('Ctrl+F opens the full conversation with older matches',await countText()==='1/2'&&await evalJS("!document.getElementById('history-panel').hidden&&document.activeElement.id==='find-input'"),await countText());
  check('opening find preserves composer draft and caret range',await evalJS("(()=>{const i=document.getElementById('prompt-input');return i.value==='keep this draft'&&i.selectionStart===2&&i.selectionEnd===7})()"));
  check('case-insensitive highlights use actual message text',(await ranges()).join('|')==='Needle|NEEDLE',JSON.stringify(await ranges()));
  const oldId=await active();await key('Enter');
  check('Enter advances without sending',await countText()==='2/2'&&await count('chat_send')===0);
  await key('F3');check('F3 wraps forward',await countText()==='1/2');
  await key('Enter',{shiftKey:true});check('Shift+Enter wraps backward',await countText()==='2/2');
  await key('F3',{shiftKey:true});check('Shift+F3 moves backward',await countText()==='1/2'&&await active()===oldId);
  await evalJS("document.getElementById('find-next').click()");check('next button navigates',await countText()==='2/2');
  await evalJS("document.getElementById('find-prev').click()");check('previous button navigates',await countText()==='1/2');
  await key('f',{ctrlKey:true});
  check('repeated Ctrl+F selects the current query',await evalJS("(()=>{const i=document.getElementById('find-input');return document.activeElement===i&&i.selectionStart===0&&i.selectionEnd===i.value.length})()"));
  await evalJS("window.savedContent=[...document.querySelectorAll('#history-panel .turn-content')].map(node=>({node,html:node.innerHTML}))");
  await query('hello');check('matches span inline formatting',await countText()==='1/1'&&(await ranges())[0]==='hello',JSON.stringify(await ranges()));
  check('highlights leave message DOM and code nodes intact',await evalJS("savedContent.every(({node,html},i)=>node===document.querySelectorAll('#history-panel .turn-content')[i]&&node.innerHTML===html)"));
  await evalJS("(()=>{document.getElementById('history-panel').focus({preventScroll:true});const node=document.querySelector('#history-panel strong').firstChild;const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);window.heldSelection=range;document.querySelector('#history-panel .turn-content').append(document.createTextNode(' appended words'));})()");await sleep(90);
  check('observer rescanning preserves a selected message range',await evalJS("heldSelection.toString()==='lo'&&getSelection().toString()==='lo'"));
  await query('[literal.*]');check('regex punctuation is literal',await countText()==='1/1');
  await query('BlockOneBlockTwo');check('separate paragraphs are not concatenated',await countText()==='0/0');
  await query('ĀTAAHUA');check('Unicode case matching',await countText()==='1/1');
  await query('🌏');check('emoji matches preserve UTF-16 range boundaries',await countText()==='1/2'&&(await ranges()).every(t=>t==='🌏'));
  await query('Copy');check('code-toolbar labels are excluded',await countText()==='0/0');
  await query('Selection');check('selection-chip labels are excluded',await countText()==='0/0');
  check('no-match controls are disabled',await evalJS("document.getElementById('find-next').disabled&&document.getElementById('find-prev').disabled"));
  await evalJS("(()=>{const hidden=document.createElement('span');hidden.hidden=true;hidden.textContent='HiddenFindToken';document.querySelector('#history-panel .turn-content').append(hidden)})()");
  await query('HiddenFindToken');check('hidden message content is excluded',await countText()==='0/0');
  await query('HORIZONTAL_TARGET');
  check('code match scrolls into horizontal view',await evalJS("(()=>{const p=document.querySelector('#history-panel pre');const r=Array.from(CSS.highlights.get('qchat-find-current'))[0]?.getBoundingClientRect();const b=p?.getBoundingClientRect();return p?.scrollLeft>0&&r&&r.left>=b.left-2&&r.right<=b.right+2})()"));
  await evalJS("document.querySelector('#history-panel .code-copy-btn').click()");await sleep(40);
  check('code copying survives find highlights',await evalJS("copyWrites.some(text=>text.includes('HORIZONTAL_TARGET'))"));
  await key('Escape');
  check('Escape closes find before history or app',await clean()&&await evalJS("!document.getElementById('history-panel').hidden&&__mock.count('hide_main')===0&&document.activeElement.id==='prompt-input'"));
  await type('/find');await key('Enter');await until("!document.getElementById('find-bar').hidden");
  check('/find is a normal command and never sends',await count('chat_send')===0&&await inputValue()==='');
  await evalJS("document.getElementById('find-close').click()");check('close button clears highlights and restores composer focus',await clean()&&await evalJS("document.activeElement.id==='prompt-input'"));
  await find('needle');await key('k',{ctrlKey:true});
  check('command palette replaces find cleanly',await clean()&&await evalJS("!document.getElementById('slash-menu').hidden"));await key('Escape');
  await find('needle');await key('p',{ctrlKey:true});
  check('chat picker replaces find cleanly',await clean()&&await evalJS("!document.querySelector('.feature-list').hidden"));await key('Escape');
  await find('needle');await type('/');
  check('typing slash commands replaces find cleanly',await clean()&&await evalJS("!document.getElementById('slash-menu').hidden"));await key('Escape');
  await show();await find('needle');
  const immediateNavigation=await evalJS("new Promise(resolve=>{document.querySelector('#history-panel [data-id=\"old-u\"] .selection-prompt').firstChild.data='Changed question.';queueMicrotask(()=>{document.getElementById('find-next').click();resolve({count:document.getElementById('find-count').textContent.replace(/\\s/g,''),ranges:CSS.highlights.get('qchat-find').size,current:Array.from(CSS.highlights.get('qchat-find-current'))[0]?.toString()})})})");
  check('navigation flushes pending message mutations',immediateNavigation.count==='1/1'&&immediateNavigation.ranges===1&&immediateNavigation.current==='NEEDLE',JSON.stringify(immediateNavigation));

  await show();await evalJS("__mock.hold=true");await send('Stream with prior history');await until("__mock.last('chat_send')");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Streaming tail.\\n\\n'})");await sleep(80);await find('needle');
  await evalJS("document.getElementById('history-panel').scrollTop=80");await sleep(60);
  const heldTop=await evalJS("document.getElementById('history-panel').scrollTop"),heldId=await active();
  const streamed='Streaming tail.\n\n'+Array.from({length:45},(_,i)=>`Growing text ${i}.`).join('\n\n')+'\n\nNew needle tail.\n\n';
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(streamed)}})`);
  await until("document.getElementById('find-count').textContent.replace(/\\s/g,'').endsWith('/3')");
  check('stream updates refresh match count without scrolling',Math.abs(await evalJS("document.getElementById('history-panel').scrollTop")-heldTop)<3&&await active()===heldId);
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(streamed)},conversationId:'find-live'})`);
  await until("!document.querySelector('[data-status=streaming]')");
  const remoteTranscript=transcript.map(item=>({role:item.role,text:item.role==='user'&&item.selectionTexts?.length?[item.text,...item.selectionTexts.map(text=>text.split('\n').map(line=>'> '+line).join('\n'))].join('\n\n'):item.text}));
  const messages=[{role:'user',text:'Remote needle record'},...remoteTranscript,{role:'user',text:'Stream with prior history'},{role:'assistant',text:streamed}];
  await evalJS(`__mock.emit('bridge',{type:'transcript',conversationId:'find-live',complete:true,messages:${JSON.stringify(messages)}})`);
  await until("document.getElementById('find-count').textContent.replace(/\\s/g,'').endsWith('/4')");
  check('account transcript refresh retains active message match',await active()===heldId);
  await key('n',{ctrlKey:true});check('new chat removes all find state',await clean());
  await show();await find('needle');await type('next question');await evalJS("__mock.hold=true;document.getElementById('prompt-input').focus()");await key('Enter');await until("__mock.last('chat_send')");
  check('sending closes find and clears ranges',await clean());
  await show();await find('needle');await evalJS("document.querySelector('#tabs [data-key=other]').click()");await until("__mock.provider==='gemini'");
  check('switching provider chat clears old matches',await clean());
  await find('private');check('new provider searches only its own conversation',await countText()==='1/1'&&(await ranges()).join('')==='private');

  await show();await key('p',{ctrlKey:true});await until("document.querySelector('[aria-label=\"Remove chat\"]')");
  await evalJS("document.querySelector('[aria-label=\"Remove chat\"]').click()");await find('needle');
  check('opening find closes the chat menu without dismissing undo',await evalJS("document.querySelector('.feature-list').hidden&&!!document.querySelector('#command-feedback button')&&!document.getElementById('command-feedback').hidden"));
  await query('');
  await cdp('Input.insertText',{text:'typed query'});await browserKey('a','KeyA',65,2);await browserKey('Backspace','Backspace',8);await browserKey('z','KeyZ',90,2);await sleep(70);
  check('editing an empty find field keeps native text undo',await evalJS("document.getElementById('find-input').value==='typed query'&&!!document.querySelector('#command-feedback button')&&!document.getElementById('command-feedback').hidden&&!JSON.parse(localStorage.getItem('qchat.chats')).recent.some(chat=>chat.key==='other')"));
  await query('needle');await key('Escape');
  check('find Escape has priority over pending chat undo',await clean()&&await evalJS("!!document.querySelector('#command-feedback button')&&!document.getElementById('command-feedback').hidden"));

  for(const look of ['midnight','frost']) {
    await cdp('Emulation.setDeviceMetricsOverride',{width:416,height:700,deviceScaleFactor:1.5,mobile:false,screenWidth:1920,screenHeight:1080});
    await show({barWidth:340,replyWidth:360,look});await find('needle');
    check(look+' search controls fit minimum width at 150% pixel density',await evalJS("(()=>{const b=document.getElementById('find-bar').getBoundingClientRect(),i=document.getElementById('find-input').getBoundingClientRect(),c=document.getElementById('find-close').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&i.width>=70&&i.right<=c.left&&c.right<=b.right+1})()"));
    await shot('find-'+look+'-narrow');
  }
  await show({replyWidth:360},[{id:'big-u',role:'user',text:'Long history'},{id:'big-a',role:'assistant',text:Array.from({length:3500},(_,i)=>`Record ${i}: target text.`).join('\n\n')}]);await find();
  const largeSearch=await evalJS("(()=>{const input=document.getElementById('find-input'),start=performance.now();input.value='target';input.dispatchEvent(new Event('input',{bubbles:true}));return {ms:performance.now()-start,count:document.getElementById('find-count').textContent.replace(/\\s/g,''),ranges:CSS.highlights.get('qchat-find')?.size}})()");
  check('large history searches all 3500 paragraphs within 750ms',largeSearch.ms<750&&largeSearch.count==='1/3500'&&largeSearch.ranges===3500,JSON.stringify(largeSearch));
  console.log('INFO large history search '+Math.round(largeSearch.ms)+'ms');
  await show();await key('f',{ctrlKey:true,isComposing:true});
  check('IME composition does not trigger the find shortcut',await evalJS("document.getElementById('find-bar').hidden"));
  await evalJS("window.Highlight=undefined");await find('needle');
  check('missing Highlight API retains count and navigation',await evalJS("typeof Highlight==='undefined'")&&await countText()==='1/2');await key('Enter');check('fallback navigation still advances',await countText()==='2/2');
  check('no runtime errors',problems.length===0,problems.slice(0,5).join(' | '));
} catch (e) {
  console.error(e);if(problems.length)console.error('console:',problems.slice(0,5).join(' | '));failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
