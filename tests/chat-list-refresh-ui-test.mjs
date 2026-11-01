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
  browserPage = await openPage('chat-list-refresh-ui', { problems });
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

  const data=seed();data.current.selectionTexts=[];data.recent=['A','B','C'].map((letter,index)=>({key:'chat-'+letter,provider:'chatgpt',title:'Chat '+letter,lastActive:300-index,createdAt:100,lastPrompt:'Question '+letter,lastResponse:'Reply '+letter,draft:'',selectionTexts:[],transcript:[]}));
  await open('/?mock=signedin',{settings:{animations:'off',keepHistory:true},chats:data});await key('p',{ctrlKey:true});await until('document.querySelectorAll(".feature-list .feature-row").length===3');
  await key('ArrowDown');check('keyboard initially highlights Chat B',await evalJS('document.querySelector(".feature-list [data-selected] .feature-title").textContent==="Chat B"'));
  const refresh=()=>evalJS('__mock.emit("bridge",{type:"conversations",provider:"chatgpt",items:[{id:"remote-chat",title:"Remote result"}],total:1})');
  await refresh();check('late account results preserve the highlighted chat',await evalJS('document.querySelector(".feature-list [data-selected] .feature-title").textContent==="Chat B"'));
  await evalJS('window.focusedChatAction=document.querySelectorAll(".feature-list .feature-row")[1].querySelector("button");focusedChatAction.focus()');
  await refresh();check('open button node remains identical',await evalJS('document.activeElement===focusedChatAction && focusedChatAction.isConnected'));check('refresh preserves focus on the same chat action',await evalJS('document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat B"&&document.activeElement.getAttribute("aria-label")!=="Remove chat"'));
  await evalJS('document.querySelectorAll(".feature-list .feature-row")[1].querySelector(\'[aria-label="Remove chat"]\').focus()');
  await evalJS('window.focusedRemove=document.activeElement');
  await refresh();check('remove button node remains identical',await evalJS('document.activeElement===focusedRemove && focusedRemove.isConnected'));check('refresh preserves focus on the same removal action',await evalJS('document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat B"&&document.activeElement.getAttribute("aria-label")==="Remove chat"'));
  await evalJS('window.searchField=document.querySelector(".feature-search");searchField.value="Chat B";searchField.dispatchEvent(new Event("input",{bubbles:true}));searchField.focus();searchField.setSelectionRange(1,4,"backward")');
  await refresh();check('refresh preserves the search query and backward selection',await evalJS('document.activeElement===searchField&&searchField.value==="Chat B"&&searchField.selectionStart===1&&searchField.selectionEnd===4&&searchField.selectionDirection==="backward"&&document.querySelectorAll(".feature-row").length===1'));
  await evalJS(`searchField.value='';searchField.dispatchEvent(new Event('input',{bubbles:true}));searchField.focus()`); await key('ArrowDown');
  await evalJS(`window.reorderedButton=document.querySelectorAll('.feature-row')[1].querySelector('button');reorderedButton.focus()`);
  await evalJS(`document.querySelectorAll('.feature-row')[0].querySelector('[aria-label="Remove chat"]').click()`);
  check('removing an earlier row preserves the selected chat identity',await evalJS(`document.querySelector('[data-selected] .feature-title')?.textContent==='Chat B'`));
  await evalJS(`document.querySelector('#command-feedback button').click()`);
  check('Undo reordering preserves the selected chat identity and focused button',await evalJS(`document.querySelector('[data-selected] .feature-title')?.textContent==='Chat B' && document.activeElement===reorderedButton && reorderedButton.isConnected`));
  await evalJS(`searchField.value="";searchField.dispatchEvent(new Event("input",{bubbles:true}));document.querySelectorAll(".feature-row")[1].querySelector('[aria-label="Remove chat"]').focus()`);
  await refresh(); await nativeKey('Enter','Enter',13);
  check('Enter on Remove deletes only Chat B and opens nothing',await evalJS(`(()=>{const c=JSON.parse(localStorage.getItem('qchat.chats'));return !c.recent.some(x=>x.key==='chat-B')&&c.recent.some(x=>x.key==='chat-A')&&c.recent.some(x=>x.key==='chat-C')&&__mock.count('chat_open')===0&&__mock.count('chat_send')===0})()`));
  check('removed focused action returns focus to search with nearest selection',await evalJS(`document.activeElement===searchField&&document.querySelector('.feature-list [data-selected] .feature-title')?.textContent==='Chat C'`));
  await evalJS(`searchField.value='nothing matches';searchField.dispatchEvent(new Event('input',{bubbles:true}))`); await refresh();
  check('empty filtered results stay safe on refresh and arrow navigation',await evalJS(`document.querySelectorAll('.feature-row').length===0&&document.activeElement===searchField`));
  await key('ArrowDown');
  check('background list refresh opens or sends no chat',await evalJS('__mock.count("chat_send")===0&&__mock.count("chat_open")===0'));
  await evalJS(`document.querySelector('#command-feedback button').click()`);
  await evalJS(`searchField.value='Chat B';searchField.dispatchEvent(new Event('input',{bubbles:true}))`);
  check('Undo restores the removed chat to filtered results',await evalJS(`document.querySelectorAll('.feature-row').length===1&&document.querySelector('.feature-title').textContent==='Chat B'`));
  await evalJS(`__mock.emit('bridge',{type:'conversations',provider:'chatgpt',items:[],total:0,error:'offline'})`);
  check('empty error batch preserves restored selection and query',await evalJS(`searchField.value==='Chat B'&&document.querySelector('[data-selected] .feature-title')?.textContent==='Chat B'`));
  await evalJS(`searchField.value='';searchField.dispatchEvent(new Event('input',{bubbles:true}));__mock.emit('bridge',{type:'conversations',provider:'chatgpt',items:Array.from({length:30},(_,i)=>({id:'remote-'+i,title:'Duplicate'})),total:31})`);
  await evalJS(`window.resultBox=document.querySelector('.feature-results');resultBox.scrollTop=120;window.savedScroll=resultBox.scrollTop;window.lastDuplicate=[...document.querySelectorAll('.feature-row')].findLast(x=>x.querySelector('.feature-title')?.textContent==='Duplicate').querySelector('button');lastDuplicate.focus({preventScroll:true})`);
  await evalJS(`__mock.emit('bridge',{type:'conversations',provider:'chatgpt',items:[],total:31})`);
  check('repeated empty batch retains duplicate identity, focused node and scroll',await evalJS(`document.activeElement===lastDuplicate&&lastDuplicate.isConnected&&resultBox.scrollTop===savedScroll`));
  await nativeKey('Enter','Enter',13); await sleep(50);
  check('Enter opens the exact duplicate account chat',await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.conversationId==='remote-29'`));
  const reopen=async()=>{await open('/?mock=signedin',{settings:{animations:'off',keepHistory:true},chats:data});await key('p',{ctrlKey:true});await until('document.querySelectorAll(".feature-row").length===3');};
  await reopen();await evalJS('document.querySelectorAll(".feature-row")[1].querySelector(".feature-choice").focus()');await nativeKey('ArrowDown','ArrowDown',40);
  check('ArrowDown from Open moves actual focus with the highlight',await evalJS('document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat C"&&document.querySelector("[data-selected] .feature-title")?.textContent==="Chat C"'));
  await nativeKey('Enter','Enter',13);await until('JSON.parse(localStorage.getItem("qchat.chats")).current.key!=="rename-current"');
  check('Enter after action arrow navigation opens the highlighted chat',await evalJS('JSON.parse(localStorage.getItem("qchat.chats")).current.key==="chat-C"'));
  await reopen();await evalJS('document.querySelectorAll(".feature-row")[1].querySelector(\'[aria-label="Remove chat"]\').focus()');await nativeKey('ArrowDown','ArrowDown',40);
  check('ArrowDown from Remove moves the same action to the highlighted chat',await evalJS('document.activeElement.getAttribute("aria-label")==="Remove chat"&&document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat C"&&document.querySelector("[data-selected] .feature-title")?.textContent==="Chat C"'));
  await nativeKey('Enter','Enter',13);await until('JSON.parse(localStorage.getItem("qchat.chats")).recent.length===2');
  check('Enter after removal arrow navigation removes only the highlighted chat',await evalJS('(()=>{const state=JSON.parse(localStorage.getItem("qchat.chats"));return state.current.key==="rename-current"&&state.recent.some(chat=>chat.key==="chat-B")&&!state.recent.some(chat=>chat.key==="chat-C");})()'));
  await reopen();await refresh();await evalJS('Array.from(document.querySelectorAll(".feature-row")).find(row=>row.querySelector(".feature-title")?.textContent==="Chat C").querySelector(\'[aria-label="Remove chat"]\').focus()');await nativeKey('ArrowDown','ArrowDown',40);
  check('action arrows fall back to Open on an account result without Remove',await evalJS('document.activeElement.classList.contains("feature-choice")&&document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Remote result"'));
  await nativeKey('ArrowDown','ArrowDown',40);
  check('action arrow navigation wraps with matching focus and highlight',await evalJS('document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat A"&&document.querySelector("[data-selected] .feature-title")?.textContent==="Chat A"'));
  await reopen();await evalJS('__mock.emit("bridge",{type:"conversations",items:[{id:"repeat-id",title:"Repeated account"},{id:"repeat-id",title:"Repeated account"},{id:"tail-id",title:"Tail account"}],total:2})');await nativeKey('ArrowDown','ArrowDown',40);await nativeKey('ArrowDown','ArrowDown',40);await nativeKey('ArrowDown','ArrowDown',40);
  check('duplicate IDs in one batch create one keyboard stop per account',await evalJS('document.querySelectorAll(".feature-row").length===5&&document.querySelector("[data-selected] .feature-title")?.textContent==="Repeated account"'));
  const pagesBefore=await count('chat_list_conversations');await evalJS('__mock.emit("bridge",{type:"conversations",items:[{id:"repeat-id",title:"Repeated account"}],total:99})');await sleep(650);
  check('a duplicate-only batch does not keep requesting more pages',await count('chat_list_conversations')===pagesBefore);
  check('chat-list refresh probe has no runtime errors',problems.length===0,problems.join(' | '));
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
