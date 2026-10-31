// Hidden isolated WebView2 reading/tab navigation. Fixture provider methods only;
// no account messages or OS input. Clipboard is stubbed before copy feedback.
// --reading-only checks O14 without requiring the O15 keyboard implementation.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-navigation-native-'));
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const app=spawn(exe,[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
let launchError;
app.on('error',error=>{launchError=error;});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,failed=0,serial=0;
const pending=new Map(),problems=[];
const check=(label,ok,detail='')=>{console.log(`${ok?'PASS':'FAIL'} ${label}${!ok&&detail?' :: '+detail:''}`);if(!ok)failed++;};
async function command(method,params={}) {
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},10000);
    pending.set(id,message=>{clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for(let i=0;i<100;i++){if(await evaluate(`!!(${expression})`))return;await sleep(50);}
  throw Error('Timed out: '+expression);
}
const key=(value,extra={})=>evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({key:value,bubbles:true,cancelable:true,...extra})}))`);
function ownsEndpoint() {
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess; for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0&&result.stdout.trim()==='owned';
}
try {
  let page;
  for(let i=0;i<100&&!page;i++) {
    if(launchError)throw launchError;
    if(app.exitCode!==null)throw Error('Test app exited early: '+app.exitCode);
    try {page=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(600)})).json()).find(item=>item.url.includes('tauri.localhost')&&!item.url.includes('settings'));}catch{}
    if(!page)await sleep(100);
  }
  if(!page)throw Error('Main WebView2 target did not appear');
  if(!ownsEndpoint())throw Error('Debug endpoint is not owned by the spawned isolated QChat; refusing to attach');
  ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}else if(message.method==='Runtime.exceptionThrown')problems.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);};
  ws.onclose=()=>{for(const callback of pending.values())callback({error:{message:'CDP closed'}});pending.clear();};
  await command('Runtime.enable');await command('Page.enable');
  await until("document.readyState==='complete'&&window.QSettings&&document.getElementById('find-input')");
  const longReply=Array.from({length:55},(_,i)=>`Paragraph ${i+1}. ${'Readable fixture text. '.repeat(10)}`).join('\n\n');
  const makeChat=key=>{const transcript=Array.from({length:30},(_,i)=>({id:`${key}-${i}`,role:i%2?'assistant':'user',text:i===29?longReply:`${key} message ${i}. ${'Earlier fixture text. '.repeat(15)}`}));return{key,provider:'chatgpt',title:key,conversationId:`conversation-${key}`,createdAt:100,lastActive:100,lastPrompt:transcript[28].text,lastResponse:transcript[29].text,draft:`Draft ${key}`,transcript}};
  const fixtures=['nav-a','nav-b','nav-c'].map(makeChat);
  const fixtureMap=Object.fromEntries(fixtures.map(chat=>[chat.conversationId,chat.transcript]));
  // Keep native IPC/page synchronization real, while replacing provider methods
  // so fixture IDs never navigate or query an account conversation.
  let siteTarget;
  for(let i=0;i<100&&!siteTarget;i++){try{siteTarget=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(700)})).json()).find(page=>page.url.startsWith('https://chatgpt.com/'))}catch{}if(!siteTarget)await sleep(100)}
  if(!siteTarget)throw Error('Provider fixture target unavailable');
  const site=new WebSocket(siteTarget.webSocketDebuggerUrl);let siteSerial=0;const sitePending=new Map();
  await new Promise((resolve,reject)=>{site.onopen=resolve;site.onerror=reject});
  site.onmessage=event=>{const result=JSON.parse(event.data);if(result.id){sitePending.get(result.id)?.(result);sitePending.delete(result.id)}};
  const siteEvaluate=expression=>new Promise((resolve,reject)=>{const id=++siteSerial,timer=setTimeout(()=>{sitePending.delete(id);reject(Error('Provider fixture timeout'))},10000);sitePending.set(id,result=>{clearTimeout(timer);result.error||result.result.exceptionDetails?reject(Error('Provider fixture evaluation failed')):resolve(result.result.result?.value)});site.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))});
  try{
    for(let i=0;i<100;i++){if(await siteEvaluate('!!window.__qchat'))break;await sleep(100)}
    await siteEvaluate(`window.__navigationFixtures=${JSON.stringify(fixtureMap)};window.__qchat.openConversation=async id=>{await window.__QCHAT_EMIT__({type:'status',ready:true,loggedIn:false,conversationId:id,url:location.href})};window.__qchat.readConversation=async id=>{await window.__QCHAT_EMIT__({type:'transcript',conversationId:id,messages:window.__navigationFixtures[id],complete:true})};window.__qchat.newChat=async()=>{await window.__QCHAT_EMIT__({type:'status',ready:true,loggedIn:false,url:location.href})};window.__navigationSendCount=0;window.__qchat.send=payload=>{window.__navigationSendCount++;window.__navigationSendId=payload.id}`);
    await evaluate(`QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0,keepHistory:true,showTabs:true,barWidth:460,replyWidth:520});localStorage.setItem('qchat.chats',${JSON.stringify(JSON.stringify({v:1,current:fixtures[0],recent:fixtures.slice(1)}))});true`);
    await command('Page.reload');await until("document.getElementById('prompt-input')?.value==='Draft nav-a'");
    await until("/Ready|Guest/.test(document.getElementById('status-label').textContent)");
    await evaluate('document.fonts.ready');
    const switchTo=async key=>{await until(`!!document.querySelector('#tabs .tab[data-key="${key}"]')`);await evaluate(`document.querySelector('#tabs .tab[data-key="${key}"]').click()`);await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(key)}`);await sleep(100)};
    const nativeKey=async(value,code,virtual,modifiers=0)=>{await command('Input.dispatchKeyEvent',{type:'keyDown',key:value,code,windowsVirtualKeyCode:virtual,modifiers});await command('Input.dispatchKeyEvent',{type:'keyUp',key:value,code,windowsVirtualKeyCode:virtual,modifiers})};
    const anchorExpression="(()=>{const panel=document.getElementById('history-panel'),top=panel.getBoundingClientRect().top,row=[...panel.children].find(row=>row.dataset.id&&row.getBoundingClientRect().bottom>top);return row?{id:row.dataset.id,offset:top-row.getBoundingClientRect().top}:null})()";
    await evaluate("document.getElementById('btn-history').click()");await until("!document.getElementById('history-panel').hidden&&document.querySelectorAll('#history-panel [data-id]').length>=30");
    await evaluate("(()=>{const panel=document.getElementById('history-panel');panel.scrollTop=panel.scrollHeight*.35;panel.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}))})()");await sleep(100);
    const anchor=await evaluate(anchorExpression);if(!anchor)throw Error('History anchor unavailable');
    await switchTo('nav-b');await switchTo('nav-a');
    let restored=await evaluate(anchorExpression);
    check('native history reopens at the same partially visible row',await evaluate("!document.getElementById('history-panel').hidden")&&restored?.id===anchor.id&&Math.abs(restored.offset-anchor.offset)<3);
    const older=[{id:'backfilled-old-u',role:'user',text:'Older native fixture question'},{id:'backfilled-old-a',role:'assistant',text:'An older native fixture answer. '+longReply}];
    await siteEvaluate(`window.__navigationFixtures['conversation-nav-a']=${JSON.stringify([...older,...fixtures[0].transcript])};window.__QCHAT_EMIT__({type:'transcript',conversationId:'conversation-nav-a',messages:window.__navigationFixtures['conversation-nav-a'],complete:true})`);
    // New remote rows receive local IDs during merge; match their content while
    // the existing reading anchor must retain its original local ID and offset.
    await until("document.getElementById('history-panel').textContent.includes('Older native fixture question')");await sleep(100);restored=await evaluate(anchorExpression);
    check('native backfill keeps the held reading anchor',restored?.id===anchor.id&&Math.abs(restored.offset-anchor.offset)<3);
    await evaluate("document.getElementById('btn-history').click()");
    await until("document.getElementById('history-panel').hidden&&!!document.querySelector('#bubble-zone [data-role=assistant][data-capped]')");
    const scroller="document.querySelector('#bubble-zone [data-role=assistant]:not(.leaving) .bubble-scroll')";
    await evaluate(`(()=>{const scroller=${scroller};scroller.scrollTop=170;scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}))})()`);await sleep(100);
    await switchTo('nav-b');await switchTo('nav-a');
    check('native long reply restores its scroll position',await evaluate(`document.getElementById('history-panel').hidden&&Math.abs((${scroller}).scrollTop-170)<3`));
    await evaluate(`(()=>{const scroller=${scroller};scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll'))})()`);await sleep(100);
    await switchTo('nav-b');await switchTo('nav-a');
    check('native bottom reading resumes at the latest line',await evaluate(`(()=>{const scroller=${scroller};return scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<3})()`));
    check('reading state stays out of saved chat metadata',await evaluate("Object.keys(JSON.parse(localStorage.getItem('qchat.chats')).current).every(key=>!/reading|scroll|anchor/i.test(key))"));

    if(!process.argv.includes('--reading-only')){
      const draft='First native line\nSecond line 🦊\nLast line';
      const holdReply=()=>evaluate(`(()=>{const scroller=${scroller};scroller.scrollTop=0;scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}))})()`);
      const atBottom=()=>evaluate(`(()=>{const scroller=${scroller};return scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<3})()`);
      await holdReply();
      await evaluate(`(()=>{const input=document.getElementById('prompt-input');input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input'));input.focus();input.setSelectionRange(3,3)})()`);
      await nativeKey('End','End',35,2);
      check('native Ctrl+End first moves the composer caret without jumping',await evaluate(`document.activeElement.id==='prompt-input'&&document.activeElement.selectionStart===${draft.length}&&document.activeElement.selectionEnd===${draft.length}&&(${scroller}).scrollTop<3`));
      await nativeKey('End','End',35,2);
      check('native Ctrl+End at the composer end jumps and keeps the draft',await atBottom()&&await evaluate(`document.activeElement.id==='prompt-input'&&document.activeElement.value===${JSON.stringify(draft)}`));
      await holdReply();await evaluate("document.getElementById('prompt-input').setSelectionRange(3,3)");
      await nativeKey('End','End',35,10);
      check('native Ctrl+Shift+End selects draft text without jumping',await evaluate(`document.activeElement.selectionStart===3&&document.activeElement.selectionEnd===${draft.length}&&document.activeElement.value===${JSON.stringify(draft)}&&(${scroller}).scrollTop<3`));
      await evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='';input.dispatchEvent(new Event('input'))})()");
      await nativeKey('End','End',35,2);
      check('native Ctrl+End in an empty composer jumps to the latest reply',await atBottom());
      await evaluate("document.getElementById('btn-history').click()");await until("!document.getElementById('history-panel').hidden");
      await evaluate("(()=>{const panel=document.getElementById('history-panel');panel.scrollTop=0;panel.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}));document.getElementById('prompt-input').focus()})()");
      await nativeKey('End','End',35,2);
      check('native Ctrl+End jumps History while keeping it open',await evaluate("(()=>{const panel=document.getElementById('history-panel');return !panel.hidden&&panel.scrollHeight-panel.scrollTop-panel.clientHeight<3})()"));
      await key('f',{ctrlKey:true});await until("document.activeElement.id==='find-input'");
      await evaluate("(()=>{const input=document.getElementById('find-input');input.value='Paragraph';input.dispatchEvent(new Event('input'));input.setSelectionRange(0,0)})()");await sleep(100);
      await evaluate("(()=>{const panel=document.getElementById('history-panel');panel.scrollTop=0;panel.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}))})()");
      await nativeKey('End','End',35,2);
      check('native Ctrl+End keeps Find editing and its History position',await evaluate("document.activeElement.id==='find-input'&&document.activeElement.selectionStart===9&&document.activeElement.value==='Paragraph'&&document.getElementById('history-panel').scrollTop<3"));
      await evaluate("document.getElementById('find-close').click()");await key('k',{ctrlKey:true});await evaluate("document.querySelector('#slash-menu [data-command=rename]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
      await until("!document.getElementById('rename-chat').hidden");
      await evaluate("document.activeElement.setSelectionRange(0,0)");await nativeKey('End','End',35,2);
      check('native Ctrl+End keeps Rename editing without saving',await evaluate("!document.getElementById('rename-chat').hidden&&document.activeElement.tagName==='INPUT'&&document.activeElement.selectionStart===document.activeElement.value.length&&JSON.parse(localStorage.getItem('qchat.chats')).current.title==='nav-a'"));
      await nativeKey('Escape','Escape',27);await evaluate("document.getElementById('btn-history').click()");await until("document.getElementById('history-panel').hidden");
      await holdReply();await evaluate("document.querySelector('#tabs .tab').focus()");
      const focusedTab=await evaluate('document.activeElement.dataset.key');await nativeKey('End','End',35,2);
      check('native Ctrl+End from multiple recent tabs keeps the focused tab',await atBottom()&&await evaluate(`document.querySelectorAll('#tabs .tab').length>1&&document.activeElement.dataset.key===${JSON.stringify(focusedTab)}&&JSON.parse(localStorage.getItem('qchat.chats')).current.key==='nav-a'`));
      check('native jump shortcuts send no provider messages',await siteEvaluate('window.__navigationSendCount===0'));
      await evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='Draft nav-a';input.dispatchEvent(new Event('input'));input.focus()})()");
    }

    if(!process.argv.includes('--reading-only')){
      await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});window.nativeNavigationExec=document.execCommand;document.execCommand=function(command,...args){return command==='copy'?false:nativeNavigationExec.call(document,command,...args)}");
      await key('k',{ctrlKey:true});await evaluate("document.querySelector('#slash-menu [data-command=copy]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
      await until("!document.getElementById('command-feedback').hidden");
      await evaluate("document.querySelector('#tabs .tab').focus()");
      const tabKeys=await evaluate("[...document.querySelectorAll('#tabs .tab')].map(tab=>tab.dataset.key)");
      await nativeKey('ArrowRight','ArrowRight',39);
      check('native arrows focus visible recent tabs while copy feedback shows',await evaluate(`document.activeElement?.dataset.key===${JSON.stringify(tabKeys[1])}&&document.activeElement.getClientRects().length>0&&JSON.parse(localStorage.getItem('qchat.chats')).current.key==='nav-a'`));
      await nativeKey('Home','Home',36);const atHome=await evaluate(`document.activeElement?.dataset.key===${JSON.stringify(tabKeys[0])}`);
      await nativeKey('End','End',35);
      check('native Home and End navigate the recent-tab row',atHome&&await evaluate(`document.activeElement?.dataset.key===${JSON.stringify(tabKeys.at(-1))}`));
      const focusShots=path.join(root,'.tmp','navigation-shots');await mkdir(focusShots,{recursive:true});
      await writeFile(path.join(focusShots,'native-focused-tabs.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
      await nativeKey('Escape','Escape',27);
      check('native tab Escape returns to the composer without dismissing the reply',await evaluate("document.activeElement.id==='prompt-input'&&!!document.querySelector('#bubble-zone [data-role=assistant]:not(.leaving)')"));
      await evaluate("document.querySelector('#tabs .tab').focus()");await nativeKey('Tab','Tab',9);
      check('native Tab reaches the separate All chats button',await evaluate("document.activeElement===document.querySelector('#tabs .tab-all')"));
      await evaluate("document.querySelector('#tabs .tab').focus()");const target=await evaluate('document.activeElement.dataset.key');await nativeKey('Enter','Enter',13);
      await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(target)}`);
      check('native Enter activates the focused tab and preserves its draft',await evaluate(`document.getElementById('prompt-input').value===${JSON.stringify('Draft '+target)}&&document.activeElement.id==='prompt-input'`));
      await evaluate("document.querySelector('#tabs .tab').focus()");const spaceTarget=await evaluate('document.activeElement.dataset.key');await nativeKey(' ','Space',32);
      await until(`JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(spaceTarget)}`);
      check('native Space activates exactly the focused chat',await evaluate(`JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(spaceTarget)}`));
      await evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='Busy fixture only';input.dispatchEvent(new Event('input'));document.getElementById('btn-send').click()})()");
      await until("document.getElementById('btn-send').dataset.mode==='stop'");
      let fixtureStarted=false;
      for(let i=0;i<100;i++){if(await siteEvaluate('window.__navigationSendCount===1')){fixtureStarted=true;break}await sleep(50)}
      if(!fixtureStarted)throw Error('Busy fixture did not reach the provider send method');
      const busyKey=await evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.key");
      await evaluate("document.querySelector('#tabs .tab').focus()");await nativeKey('ArrowRight','ArrowRight',39);await nativeKey('Enter','Enter',13);await nativeKey(' ','Space',32);
      const busyState=await evaluate("({focused:document.activeElement.matches('#tabs .tab'),aria:document.activeElement.getAttribute('aria-disabled'),current:JSON.parse(localStorage.getItem('qchat.chats')).current.key,mode:document.getElementById('btn-send').dataset.mode})");
      const providerSendCount=await siteEvaluate('window.__navigationSendCount');
      check('native busy tabs retain keyboard focus but cannot activate',busyState.focused&&busyState.aria==='true'&&busyState.current===busyKey&&busyState.mode==='stop'&&providerSendCount===1,JSON.stringify({...busyState,providerSendCount}));
      await evaluate("document.getElementById('btn-send').click()");await until("document.getElementById('btn-send').dataset.mode==='send'");
      const recallPrompt="(()=>{const chat=JSON.parse(localStorage.getItem('qchat.chats')).current;return chat.transcript.filter(item=>item.role==='user'&&item.text?.trim()).at(-1)?.text||chat.lastPrompt})()";
      const ownPrompt=await evaluate(recallPrompt);
      await evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='';input.dispatchEvent(new Event('input'));input.focus()})()");await nativeKey('ArrowUp','ArrowUp',38);
      check('native recall uses the current chat after a cancelled send',await evaluate(`document.getElementById('prompt-input').value===${JSON.stringify(ownPrompt)}`));
      const nextChat=fixtures.find(chat=>chat.key!==busyKey).key;await switchTo(nextChat);
      const nextPrompt=await evaluate(recallPrompt);
      await evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='';input.dispatchEvent(new Event('input'));input.focus()})()");await nativeKey('ArrowUp','ArrowUp',38);
      check('native recall stays in the selected chat after switching',await evaluate(`document.getElementById('prompt-input').value===${JSON.stringify(nextPrompt)}`));
      const shots=path.join(root,'.tmp','navigation-shots');await mkdir(shots,{recursive:true});await writeFile(path.join(shots,'native-navigation.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
    }
    check('native navigation has no runtime exceptions',problems.length===0,problems.join(' | '));
  }finally{site.close()}
} catch(error) {console.error('FAIL harness ::',error.message);failed++;}
finally {
  if(ws?.readyState===WebSocket.OPEN)void evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  ws?.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-navigation-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
