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
  browserPage = await openPage('send-repeat-ui', { problems });
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
  const nativeKey=async(value,code,virtual,modifiers=0)=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:virtual,modifiers,text:value==='Enter'?'\r':undefined});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:virtual,modifiers})};

  const boot=async(sendKey='enter',keepHistory=true)=>{await open('/?mock=1',{settings:{animations:'off',keepHistory,sendKey}});await evalJS('__mock.hold=true');};
  const draft=async text=>{await type(text);await until('!document.getElementById("btn-send").disabled');};
  const enter=(flags={})=>evalJS('(()=>{const input=document.getElementById("prompt-input");input.focus();const event=new KeyboardEvent("keydown",'+JSON.stringify({key:'Enter',bubbles:true,cancelable:true,...flags})+');input.dispatchEvent(event);return event.defaultPrevented;})()');
  await boot();await draft('Do not send from a held Enter');await enter({repeat:true});
  check('a held Enter alone does not submit the draft',await count('chat_send')===0&&await inputValue()==='Do not send from a held Enter');
  await boot();await draft('One deliberate Enter');await enter();await until('__mock.count("chat_send")===1');check('a fresh Enter still submits once',await count('chat_send')===1);
  await boot();await draft('Recover this draft');await enter();await until('__mock.count("chat_send")===1');await evalJS('__mock.emit("bridge",{type:"error",id:__mock.last("chat_send").args.id,code:"send_failed"})');await until('document.getElementById("prompt-input").value==="Recover this draft"&&!document.getElementById("btn-send").disabled');await enter({repeat:true});
  check('held Enter cannot automatically resend a restored failed draft',await count('chat_send')===1&&await inputValue()==='Recover this draft');
  await enter();await until('__mock.count("chat_send")===2');check('a fresh Enter retries the restored draft exactly once',await count('chat_send')===2);
  await boot('ctrl');await draft('Do not send from held Ctrl+Enter');await enter({ctrlKey:true,repeat:true});
  check('held Ctrl+Enter also preserves the draft without sending',await count('chat_send')===0&&await inputValue()==='Do not send from held Ctrl+Enter');
  await enter({metaKey:true,repeat:true});check('held Meta+Enter preserves the draft',await count('chat_send')===0&&await inputValue()==='Do not send from held Ctrl+Enter');
  await boot();await draft('Selection stays intact');await evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(2,9,'backward')})()`);await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('CDP repeated Enter preserves backward selection and text',await evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value==='Selection stays intact'&&i.selectionStart===2&&i.selectionEnd===9&&i.selectionDirection==='backward'})()`)&&await count('chat_send')===0);
  await boot();await draft('Streaming');await enter();await until('__mock.count("chat_send")===1');const streaming=await enter({repeat:true});check('repeated Enter while streaming retains default editing',!streaming&&await count('chat_send')===1);
  await boot();await draft('Allow a repeated newline');const shifted=await enter({shiftKey:true,repeat:true});check('Shift+Enter repeats keep their default newline behavior',!shifted&&await count('chat_send')===0);
  await boot('ctrl');await draft('Allow ordinary repeated Enter');const ordinary=await enter({repeat:true});check('Enter repeats in Ctrl-send mode keep default editing behavior',!ordinary&&await count('chat_send')===0);
  await boot();await draft('IME text stays local');await enter({repeat:true,isComposing:true});check('IME Enter repeats stay local',await count('chat_send')===0&&await inputValue()==='IME text stays local');
  await boot();await draft('Legacy IME confirmation');await enter({keyCode:229});check('a fresh legacy IME confirmation stays local',await count('chat_send')===0&&await inputValue()==='Legacy IME confirmation');
  await boot();await draft('Legacy repeated IME confirmation');await enter({keyCode:229,repeat:true});check('a repeated legacy IME confirmation stays local',await count('chat_send')===0&&await inputValue()==='Legacy repeated IME confirmation');
  await boot();const restored='Draft restored from local search';await draft(restored);await key('n',{ctrlKey:true});await key('p',{ctrlKey:true});await until('!document.querySelector(".feature-list").hidden');await evalJS('(()=>{const field=document.querySelector(".feature-search");field.value='+JSON.stringify(restored)+';field.dispatchEvent(new Event("input",{bubbles:true}));field.focus();})()');await until('document.querySelectorAll(".feature-row").length===1');await nativeKey('Enter','Enter',13);await until('document.getElementById("prompt-input").value==='+JSON.stringify(restored));await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('inherited held Enter from search does not submit the restored draft',await count('chat_send')===0&&await inputValue()===restored);
  await boot();await draft('Keep file and quote');await evalJS('__mock.emit("qchat://selection","Exact quoted context 🦊");(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0,128,255,17])],"repeat-ready.bin",{type:"application/octet-stream"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');await until('!!document.querySelector("#attachments [data-state=ready]")');await enter({repeat:true});
  check('ignored repeats keep ready files and quoted context without cleanup',await count('chat_send')===0&&await inputValue()==='Keep file and quote'&&await evalJS('__mock.attachmentFiles.size===1&&__mock.count("attachment_remove")===0&&document.querySelectorAll("#attachments .selection-chip").length===1&&!!document.querySelector("#attachments [data-state=ready]")'));
  await boot();await draft('Explicit button sends');await enter({repeat:true});await evalJS('document.getElementById("btn-send").click()');await until('__mock.count("chat_send")===1');check('explicit Send remains available after a blocked repeat',await count('chat_send')===1&&await evalJS('__mock.last("chat_send").args.prompt==="Explicit button sends"'));
  await boot();await draft('Explicit Retry sends');await enter();await until('__mock.count("chat_send")===1');await evalJS('__mock.emit("bridge",{type:"error",id:__mock.last("chat_send").args.id,code:"send_failed"})');await until('document.getElementById("prompt-input").value==="Explicit Retry sends"&&!document.getElementById("btn-send").disabled');await evalJS('document.querySelector(\'[data-action="retry-turn"]\').click()');await until('__mock.count("chat_send")===2');check('explicit Retry remains available after the failure',await count('chat_send')===2&&await evalJS('__mock.last("chat_send").args.prompt==="Explicit Retry sends"'));
  for(const privateMode of ['temporary','history-disabled']){
    await boot('enter',privateMode!=='history-disabled');if(privateMode==='temporary'){await command('temp');await until('__mock.last("chat_new")?.args.temporary===true');}const secret='NEVER-SAVE held '+privateMode;await draft(secret);await enter({repeat:true});await evalJS('window.dispatchEvent(new Event("pagehide"))');
    check(privateMode+' repeats keep the private draft unsent and off disk',await count('chat_send')===0&&await inputValue()===secret&&await evalJS('!(localStorage.getItem("qchat.chats")||"").includes("NEVER-SAVE")'));
  }
  await boot();await type('/ne');const commandCount=await count('chat_new');await enter({keyCode:229});
  check('legacy IME confirmation cannot activate a slash command',await count('chat_new')===commandCount&&await inputValue()==='/ne');
  await boot();await type('/clear');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('a held Enter cannot activate a highlighted slash command',await inputValue()==='/clear'&&await evalJS('document.getElementById("clear-confirm").hidden'));
  const clearFixture=async()=>{await boot();await draft('Keep clear-confirm history');await key('n',{ctrlKey:true});await type('/clear');await nativeKey('Enter','Enter',13);await until('!document.getElementById("clear-confirm").hidden');return state();};
  for(const [heldKey,code,virtual] of [['Enter','Enter',13],[' ','Space',32]]){
    const before=await clearFixture();await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:heldKey,code,windowsVirtualKeyCode:virtual,text:heldKey==='Enter'?'\r':' ',autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:heldKey,code,windowsVirtualKeyCode:virtual});
    check('held '+code+' cannot confirm clearing local history',await evalJS('!document.getElementById("clear-confirm").hidden')&&JSON.stringify((await state()).recent)===JSON.stringify(before.recent));
  }
  const clearBefore=await clearFixture();await nativeKey('Enter','Enter',13);await until('document.getElementById("clear-confirm").hidden');
  check('a fresh Enter still confirms Clear once',(await state()).recent.length===0&&await evalJS('!!document.querySelector("#command-feedback button")'));
  await evalJS('document.querySelector("#command-feedback button").click()');
  check('explicit Clear still offers exact local-history recovery',JSON.stringify((await state()).recent)===JSON.stringify(clearBefore.recent));
  await boot();await draft('Held button keeps streaming');await evalJS('document.getElementById("btn-send").focus()');await nativeKey('Enter','Enter',13);await until('__mock.count("chat_send")===1');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',autoRepeat:true});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  check('Send returns focus to the composer so held Enter does not stop the reply',await count('chat_send')===1&&await count('chat_stop')===0&&await evalJS('document.activeElement===document.getElementById("prompt-input")&&document.getElementById("btn-send").dataset.mode==="stop"'));
  check('send-repeat probe has no runtime errors',problems.length===0,problems.join(' | '));
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
