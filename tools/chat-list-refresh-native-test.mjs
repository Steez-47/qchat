// Hidden native chat-list identity checks using scoped CDP keys.
// Provider sends are stubbed; no OS keyboard or clipboard interaction.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-chat-list-refresh-native-'));
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const app=spawn(exe,[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
let launchError;app.on('error',error=>{launchError=error});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clients=[],problems=[];let main,site,failed=0;
const check=(label,ok,detail='')=>{console.log(`${ok?'PASS':'FAIL'} ${label}${!ok&&detail?' :: '+detail:''}`);if(!ok)failed++};
const pages=async()=>{try{return await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(700)})).json()}catch{return[]}};
async function waitFor(fn,label){let transient;for(let i=0;i<120;i++){try{const result=await fn();if(result)return result}catch(error){if(!['ENOENT','EACCES','EPERM'].includes(error.code))throw error;transient=error.code}if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Isolated app exited');await sleep(70)}throw Error('Timed out: '+label+(transient?' ('+transient+')':''))}
function ownsEndpoint(){
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0&&result.stdout.trim()==='owned';
}
async function connect(page){
  const ws=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let serial=0;
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=event=>{const result=JSON.parse(event.data);if(result.id){pending.get(result.id)?.(result);pending.delete(result.id)}else if(result.method==='Runtime.exceptionThrown')problems.push(result.params.exceptionDetails.exception?.description||result.params.exceptionDetails.text)};
  ws.onclose=()=>{for(const done of pending.values())done({error:{message:'CDP closed'}});pending.clear()};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,result=>{clearTimeout(timer);result.error?reject(Error(result.error.message)):resolve(result.result)});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
  const client={ws,send,evaluate};clients.push(client);await send('Runtime.enable');return client;
}

try{
  const target=await waitFor(async()=>(await pages()).find(page=>page.url.includes('tauri.localhost')&&!page.url.includes('settings')),'main target');
  if(!ownsEndpoint())throw Error('Debug endpoint does not belong to the spawned isolated QChat');
  main=await connect(target);await main.send('Page.enable');
  await waitFor(()=>main.evaluate("document.readyState==='complete'&&!!window.QSettings"),'main ready');
  const providerTarget=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith('https://chatgpt.com/')),'isolated provider');
  site=await connect(providerTarget);await waitFor(()=>site.evaluate('!!window.__qchat'),'provider bridge');
  await site.evaluate('window.fixtureSends=[];window.fixtureOpened=[];window.fixtureLists=0;window.fixtureConversation=null;window.fixtureStatus=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:true,url:fixtureConversation?"https://chatgpt.com/c/"+fixtureConversation:location.href});window.__qchat.send=job=>{fixtureSends.push(job);};window.__qchat.newChat=()=>{fixtureConversation=null;fixtureStatus();};window.__qchat.listConversations=()=>{fixtureLists++;};window.__qchat.openConversation=id=>{fixtureOpened.push(id);fixtureConversation=id;fixtureStatus();};window.__qchat.readConversation=id=>window.__QCHAT_EMIT__({type:"transcript",conversationId:id,messages:[],complete:true});window.__qchat.status=fixtureStatus;fixtureStatus();');
  await main.evaluate('window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340,showTabs:true,keepHistory:true}))');
  const key=async(key,code,virtualKey,modifiers=0)=>{
    await main.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers,...(key==='Enter'?{text:'\r'}:{})});
    await main.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  };
  const saved=()=>main.evaluate('JSON.parse(localStorage.getItem("qchat.chats"))');
  const selected=()=>main.evaluate('document.querySelector(".feature-list [data-selected] .feature-title")?.textContent');
  const boot=async(duplicateTitles=false)=>{
    const now=Date.now();const chat=(key,title,index)=>({key,provider:'chatgpt',conversationId:null,title,createdAt:now-60000,lastActive:now-index*1000,lastPrompt:'Question '+key,lastResponse:'Reply '+key,draft:'Draft '+key,selectionTexts:[],transcript:[{id:key+'-u',role:'user',text:'Question '+key},{id:key+'-a',role:'assistant',text:'Reply '+key}]});
    const data={v:1,current:chat('native-current','Current native chat',0),recent:['A','B','C'].map((letter,index)=>chat('native-'+letter,duplicateTitles&&index<2?'Duplicate title':'Chat '+letter,index+1))};
    await main.evaluate('localStorage.setItem("qchat.chats",'+JSON.stringify(JSON.stringify(data))+')');await main.send('Page.reload');
    await waitFor(async()=>{try{return await main.evaluate('document.readyState==="complete"&&!!window.QSettings&&document.getElementById("prompt-input").value==="Draft native-current"')}catch{return false}},'native chat-list fixture reload');
    await site.evaluate('fixtureConversation=null;fixtureOpened=[];fixtureLists=0;fixtureStatus()');
    await main.evaluate('document.getElementById("prompt-input").focus()');await key('p','KeyP',80,2);
    await waitFor(()=>main.evaluate('!document.querySelector(".feature-list").hidden&&document.querySelectorAll(".feature-list .feature-row").length===3'),'native chat list');
  };
  const refresh=(items=[{id:'remote-00000001',title:'Remote result'}],extra={})=>site.evaluate('window.__QCHAT_EMIT__('+JSON.stringify({type:'conversations',items,total:items.length,...extra})+')');
  const focusedAction=(title,remove=false)=>main.evaluate('(()=>{const row=Array.from(document.querySelectorAll(".feature-row")).find(row=>row.querySelector(".feature-title")?.textContent==='+JSON.stringify(title)+');window.fixtureFocused=row.querySelector('+(remove?JSON.stringify('[aria-label="Remove chat"]'):JSON.stringify('.feature-choice'))+');fixtureFocused.focus();})()');
  await boot();await key('ArrowDown','ArrowDown',40);check('native keyboard initially highlights Chat B',await selected()==='Chat B');
  await refresh();await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-list .feature-row").length===4'),'native incoming account result');
  check('native late result preserves the selected chat',await selected()==='Chat B');
  await focusedAction('Chat B');await refresh([], {total:1});
  check('native Open action keeps the same connected focused node',await main.evaluate('fixtureFocused.isConnected&&document.activeElement===fixtureFocused'));
  await focusedAction('Chat B',true);await refresh([], {total:1});
  check('native Remove action keeps the same connected focused node',await main.evaluate('fixtureFocused.isConnected&&document.activeElement===fixtureFocused'));
  await boot(true);await main.evaluate('window.fixtureDuplicate=document.querySelectorAll(".feature-row")[1].querySelector(".feature-choice");fixtureDuplicate.focus()');await refresh();await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===4'),'native duplicate-title refresh');
  check('native duplicate titles retain the exact focused result node',await main.evaluate('fixtureDuplicate.isConnected&&document.activeElement===fixtureDuplicate'));
  // Refocus the second result for an independent activation check even on the old renderer.
  await main.evaluate('document.querySelectorAll(".feature-row")[1].querySelector(".feature-choice").focus()');await key('Enter','Enter',13);await waitFor(async()=>(await saved()).current.key==='native-B','native keyboard Open target');
  check('native Enter opens the intended duplicate-title chat',await main.evaluate('document.querySelector(".feature-list").hidden&&document.getElementById("prompt-input").value==="Draft native-B"'));
  await boot();await focusedAction('Chat B',true);await refresh();await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===4'),'native Remove refresh');
  await focusedAction('Chat B',true);await key('Enter','Enter',13);let state=await saved();const removed=!state.recent.some(chat=>chat.key==='native-B');
  check('native Enter on Remove deletes only its intended chat without opening',removed&&state.current.key==='native-current'&&state.recent.some(chat=>chat.key==='native-A')&&state.recent.some(chat=>chat.key==='native-C'));
  check('native removed action returns focus to search with a nearest highlight',removed&&await selected()==='Chat C'&&await main.evaluate('!document.querySelector(".feature-list").hidden&&document.activeElement===document.querySelector(".feature-search")'));
  const undoReady=await main.evaluate('!!document.querySelector("#command-feedback button")');check('native keyboard removal offers Undo',removed&&undoReady);
  if(removed&&undoReady){await main.evaluate('document.querySelector("#command-feedback button").click()');await waitFor(async()=>(await saved()).recent.some(chat=>chat.key==='native-B'),'native chat Undo');check('native Undo restores the row without changing the selected chat',await selected()==='Chat C');}
  await boot();const many=Array.from({length:80},(_,index)=>({id:'account-'+String(index).padStart(8,'0'),title:'Account result '+index}));await refresh(many);await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===83'),'native long chat list');
  await main.evaluate('window.fixtureSearch=document.querySelector(".feature-search");fixtureSearch.focus();fixtureSearch.setSelectionRange(0,0);document.querySelector(".feature-results").scrollTop=150;window.fixtureScroll=document.querySelector(".feature-results").scrollTop');
  await refresh([], {total:80,error:'unavailable'});
  check('native background error preserves query focus and reading scroll',await main.evaluate('document.activeElement===fixtureSearch&&Math.abs(document.querySelector(".feature-results").scrollTop-fixtureScroll)<=1&&fixtureScroll>0'));
  await main.evaluate('fixtureSearch.value="Chat B";fixtureSearch.dispatchEvent(new Event("input",{bubbles:true}));fixtureSearch.focus();fixtureSearch.setSelectionRange(1,4,"backward")');await refresh([], {total:80});
  check('native refresh preserves the search text and backward range',await main.evaluate('document.activeElement===fixtureSearch&&fixtureSearch.value==="Chat B"&&fixtureSearch.selectionStart===1&&fixtureSearch.selectionEnd===4&&fixtureSearch.selectionDirection==="backward"&&document.querySelectorAll(".feature-row").length===1'));
  const shotDirectory=path.join(root,'.tmp','chat-list-refresh-shots');await mkdir(shotDirectory,{recursive:true});await writeFile(path.join(shotDirectory,'native-search-340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await boot();const accounts=[{id:'duplicate-00000001',title:'Duplicate account'},{id:'duplicate-00000002',title:'Duplicate account'}];await refresh(accounts);await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===5'),'native account results');
  await main.evaluate('window.fixtureAccountOpen=Array.from(document.querySelectorAll(".feature-row")).filter(row=>row.querySelector(".feature-title")?.textContent==="Duplicate account")[1].querySelector(".feature-choice");fixtureAccountOpen.focus()');await refresh([], {total:2});
  check('native duplicate account result retains focused action identity',await main.evaluate('fixtureAccountOpen.isConnected&&document.activeElement===fixtureAccountOpen'));
  await main.evaluate('Array.from(document.querySelectorAll(".feature-row")).filter(row=>row.querySelector(".feature-title")?.textContent==="Duplicate account")[1].querySelector(".feature-choice").focus()');await key('Enter','Enter',13);await waitFor(()=>site.evaluate('fixtureOpened.length===1'),'native account open request');
  check('native Enter opens the correct account id through the stub',await site.evaluate('fixtureOpened[0]==="duplicate-00000002"'));
  await boot();await focusedAction('Chat B');await key('ArrowDown','ArrowDown',40);
  check('native action arrows move Open focus with its highlighted chat',await selected()==='Chat C'&&await main.evaluate('document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat C"'));
  await key('Enter','Enter',13);await waitFor(async()=>(await saved()).current.key!=='native-current','native arrow Open target');
  check('native Enter after an action arrow opens the highlighted chat',(await saved()).current.key==='native-C');
  await boot();await focusedAction('Chat B',true);await key('ArrowDown','ArrowDown',40);
  check('native action arrows move Remove focus with its highlighted chat',await selected()==='Chat C'&&await main.evaluate('document.activeElement.getAttribute("aria-label")==="Remove chat"&&document.activeElement.closest(".feature-row")?.querySelector(".feature-title").textContent==="Chat C"'));
  await key('Enter','Enter',13);await waitFor(async()=>(await saved()).recent.length===2,'native arrow Remove target');state=await saved();
  check('native Enter after a Remove arrow deletes only the highlighted chat',state.current.key==='native-current'&&state.recent.some(chat=>chat.key==='native-B')&&!state.recent.some(chat=>chat.key==='native-C'));
  await boot();await refresh([{id:'repeat-00000001',title:'Repeated account'},{id:'repeat-00000001',title:'Repeated account'},{id:'tail-00000001',title:'Tail account'}],{total:2});await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===5'),'native duplicate batch');
  await key('ArrowDown','ArrowDown',40);await key('ArrowDown','ArrowDown',40);await key('ArrowDown','ArrowDown',40);
  check('native duplicate account IDs make one selectable keyboard stop',await selected()==='Repeated account'&&await main.evaluate('document.querySelectorAll(".feature-row").length===5'));
  check('native background refresh never submits a provider message',await site.evaluate('fixtureSends.length===0'));
  check('native chat-list refresh checks have no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-chat-list-refresh-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
