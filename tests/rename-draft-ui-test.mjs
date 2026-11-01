// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('rename-chat-ui', { problems });
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
  const until=async(expression)=>{if(!await waitFor(expression))throw Error('Timed out: '+expression)};
  const seed=()=>({v:1,current:{key:'rename-current',provider:'chatgpt',title:'Original title',lastActive:1000,createdAt:500,lastPrompt:'Earlier question',lastResponse:'Earlier reply',draft:'Keep this draft 🌏',selectionTexts:['Quoted selection'],transcript:[{id:'u',role:'user',text:'Earlier question'},{id:'a',role:'assistant',text:'Earlier reply'}]},recent:[{key:'older',provider:'chatgpt',title:'Older chat',createdAt:200,lastActive:300,lastPrompt:'Other question',lastResponse:'Other reply'},{key:'gemini-chat',provider:'gemini',title:'Gemini chat',createdAt:100,lastActive:200,lastPrompt:'Gemini question',lastResponse:'Gemini reply'}]});
  const setup=async(settings={})=>{await open('/?mock=1',{settings:{animations:'off',autoDismiss:0,keepHistory:true,showTabs:true,...settings},chats:seed()});await until(`document.getElementById('prompt-input').value==='Keep this draft 🌏'`)};
  const state=()=>evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const command=async name=>{await key('k',{ctrlKey:true});await until(`!!document.querySelector('#slash-menu [data-command="${name}"]')`);await evalJS(`document.querySelector('#slash-menu [data-command="${name}"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`)};
  const rename=async()=>{await command('rename');await until(`!document.getElementById('rename-chat').hidden`)};
  const setName=text=>evalJS(`(()=>{const input=document.getElementById('rename-chat-input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const save=()=>evalJS(`document.getElementById('rename-chat').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
  const nativeKey=async(value,code,virtual,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:virtual,modifiers});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:virtual,modifiers})};

  await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});await type('First 🌏 line\nSecond');await command('rename');
  check('draft opens rename with preview',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').value==='First 🌏 line'&&document.getElementById('prompt-input').value==='First 🌏 line\\nSecond'`));
  if(await evalJS(`!document.getElementById('rename-chat').hidden`)){await setName('Draft name');await save();check('name saved without send',(await state()).current.title==='Draft name'&&await count('chat_send')===0);}
  await cdp('Page.reload');await until(`document.getElementById('prompt-input')?.value==='First 🌏 line\\nSecond'`);
  check('draft name survives reload',(await state()).current.title==='Draft name');
  await type('Changed draft');await command('rename');
  check('explicit title overrides changed draft',await evalJS(`document.getElementById('rename-chat-input').value==='Draft name'`));
  await setName('   ');await save();check('blank name rejected',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').getAttribute('aria-invalid')==='true'`));
  await key('Escape');check('escape cancels',(await state()).current.title==='Draft name');
  await command('gemini');await until(`document.getElementById('prompt-input')?.value==='Changed draft'`);
  check('draft name follows provider change',(await state()).current.title==='Draft name');
  const namedKey=(await state()).current.key;await key('n',{ctrlKey:true});await until(`!!document.querySelector('.tab[data-key="${namedKey}"]')`);
  check('a named pristine draft stays recoverable after New chat',(await state()).recent.some(chat=>chat.key===namedKey&&chat.title==='Draft name'&&chat.draft==='Changed draft'));
  await evalJS(`document.querySelector('.tab[data-key="${namedKey}"]').click()`);await until(`document.getElementById('prompt-input').value==='Changed draft'`);
  check('tab navigation restores the named draft without sending',(await state()).current.title==='Draft name'&&await evalJS(`__mock.count('chat_send')===0`));
  await evalJS('__mock.hold=true');await type('Actual first message after naming');await key('Enter');await until(`__mock.count('chat_send')===1`);
  check('the first explicit send keeps the chosen local name',(await state()).current.title==='Draft name'&&await evalJS(`__mock.last('chat_send').args.prompt==='Actual first message after naming'`));
  await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});const exact='Keep e\u0301 and 🌏\nSecond exact line';await type(exact);await evalJS(`__mock.emit('qchat://selection','Exact quoted context 🦊');document.getElementById('prompt-input').setSelectionRange(2,7,'backward')`);await command('rename');await setName('Context preserved');await save();
  check('unsent Rename preserves exact multiline text, quoted context and caret',await evalJS(`(()=>{const input=document.getElementById('prompt-input'),chat=JSON.parse(localStorage.getItem('qchat.chats')).current;return input.value===${JSON.stringify(exact)}&&input.selectionStart===2&&input.selectionEnd===7&&input.selectionDirection==='backward'&&chat.selectionTexts.length===1&&chat.selectionTexts[0]==='Exact quoted context 🦊';})()`));
  await open('/?mock=1',{settings:{animations:'off',keepHistory:true},chats:seed()});await command('gemini');await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='gemini'`);
  check('a transcript name stays on its old provider chat',(await state()).current.title===''&&(await state()).recent.some(chat=>chat.key==='rename-current'&&chat.title==='Original title'&&!chat.draft&&!chat.selectionTexts.length));
  const startupDraft={key:'startup-named',provider:'gemini',title:'Startup draft name',draft:'Startup draft text',lastActive:Date.now(),createdAt:Date.now(),lastPrompt:'',lastResponse:'',selectionTexts:[],transcript:[]};
  await open('/?mock=1&failProvider=1',{settings:{animations:'off',keepHistory:true,defaultProvider:'gemini'},chats:{v:1,current:startupDraft,recent:[]}});await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='chatgpt'&&document.getElementById('prompt-input').value==='Startup draft text'`);
  check('startup provider fallback preserves the unsent local name once',(await state()).current.title==='Startup draft name'&&(await state()).recent.length===0);
  await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});await evalJS(`__mock.emit('qchat://selection','secret quoted words')`);await command('rename');
  check('quote only rename hides quote from title',await evalJS(`!document.getElementById('rename-chat').hidden&&document.getElementById('rename-chat-input').value==='Untitled chat'&&!!document.querySelector('#attachments .selection-chip')`));
  for(const draft of ['', '   ', '/ren']) {await open('/?mock=1',{settings:{animations:'off',keepHistory:true}});await type(draft);await command('rename');check('empty or command draft refused '+JSON.stringify(draft),await evalJS(`document.getElementById('rename-chat').hidden`));}
  for(const mode of ['temporary','history-disabled']) {
    await open('/?mock=1',{settings:{animations:'off',keepHistory:mode!=='history-disabled'}});
    if(mode==='temporary') await command('temp');
    await type('PRIVATE DRAFT');await command('rename');await setName('PRIVATE NAME');await save();
    check(mode+' keeps draft and name off disk',await evalJS(`!String(localStorage.getItem('qchat.chats')).includes('PRIVATE DRAFT')&&!String(localStorage.getItem('qchat.chats')).includes('PRIVATE NAME')`));
  }
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e);
  if (problems.length) console.error('console:', problems.slice(0, 5).join(' | '));
  failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
