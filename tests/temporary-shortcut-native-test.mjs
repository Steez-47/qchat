// Hidden native Temporary shortcut checks using scoped CDP keys.
// Provider sends are stubbed; no OS keyboard or clipboard interaction.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-temporary-shortcut-native-'));
const uploadRoot=path.join(profile,'qchat-cache','media-session','uploads');
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
async function uploads(){
  const result=[];
  const directories=await readdir(uploadRoot,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error});
  for(const directory of directories){
    if(!directory.isDirectory())continue;
    const parent=path.join(uploadRoot,directory.name);
    const files=await readdir(parent,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error});
    for(const file of files){if(!file.isFile())continue;try{result.push({id:directory.name,name:file.name,bytes:await readFile(path.join(parent,file.name))})}catch(error){if(error.code!=='ENOENT')throw error}}
  }
  return result;
}

try{
  const target=await waitFor(async()=>(await pages()).find(page=>page.url.includes('tauri.localhost')&&!page.url.includes('settings')),'main target');
  if(!ownsEndpoint())throw Error('Debug endpoint does not belong to the spawned isolated QChat');
  main=await connect(target);await main.send('Page.enable');
  await waitFor(()=>main.evaluate("document.readyState==='complete'&&!!window.QSettings"),'main ready');
  const providerTarget=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith('https://chatgpt.com/')),'isolated provider');
  site=await connect(providerTarget);await waitFor(()=>site.evaluate('!!window.__qchat'),'provider bridge');
  await site.evaluate('window.fixtureSetups=[];window.fixtureSends=[];window.fixtureTemporary=false;window.fixtureSetupId=null;window.fixtureStatus=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:false,temporary:fixtureTemporary,setupId:fixtureSetupId,url:fixtureTemporary?"https://chatgpt.com/?temporary-chat=true":location.href});window.__qchat.send=job=>{fixtureSends.push(job);};window.__qchat.newChat=(options={})=>{fixtureSetups.push(options);fixtureTemporary=!!options.temporary;fixtureSetupId=options.setupId||null;fixtureStatus();};window.__qchat.temporaryReady=()=>fixtureTemporary;window.__qchat.status=fixtureStatus;fixtureStatus();');
  await main.evaluate('window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340}))');
  const type=text=>main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value='+JSON.stringify(text)+';input.dispatchEvent(new Event("input"));input.focus();})()');
  const key=async(key,code,virtualKey,modifiers=0,extra={})=>{
    await main.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers,...extra});
    await main.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  };
  const chord=flags=>key('N','KeyN',78,10,flags);
  const setups=()=>site.evaluate('fixtureSetups.length');
  const latestTemporary=()=>site.evaluate('fixtureSetups.at(-1)?.temporary===true');
  const value=()=>main.evaluate('document.getElementById("prompt-input").value');
  await type('Ordinary seed conversation');await key('Enter','Enter',13,0,{text:'\r'});await waitFor(()=>site.evaluate('fixtureSends.length===1'),'seed ordinary conversation');
  await site.evaluate('(()=>{const id=fixtureSends.at(-1).id;window.__QCHAT_EMIT__({type:"start",id});window.__QCHAT_EMIT__({type:"done",id,text:"Seed fixture answer"});})()');
  await waitFor(()=>main.evaluate('document.getElementById("bubble-zone").textContent.includes("Seed fixture answer")'),'seed fixture response');
  await type('Keep native ordinary draft');const first=await setups();await chord();await waitFor(async()=>(await setups())>first,'native Temporary shortcut');
  check('native CDP shortcut requests Temporary setup',await latestTemporary());
  check('native Temporary shortcut sends no additional message',await site.evaluate('fixtureSends.length===1'));
  check('native Temporary shortcut creates an empty focused composer',await main.evaluate('document.getElementById("prompt-input").value===""&&document.activeElement===document.getElementById("prompt-input")'));
  check('native Temporary shortcut retains the ordinary draft',await main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")).recent.some(chat=>chat.draft==="Keep native ordinary draft")'));
  await type('Native keyboard private draft');await main.evaluate('window.dispatchEvent(new Event("pagehide"))');
  check('native shortcut keeps its private draft out of saved history',await main.evaluate('!(localStorage.getItem("qchat.chats")||"").includes("Native keyboard private draft")'));
  await key('Enter','Enter',13,0,{text:'\r'});await waitFor(()=>site.evaluate('fixtureSends.length===2'),'stubbed native send');
  check('native shortcut send carries explicit Temporary intent',await site.evaluate('fixtureSends[1].temporary===true&&fixtureSends[1].prompt==="Native keyboard private draft"'));
  const streaming=await setups();await chord();await waitFor(async()=>(await setups())>streaming,'native shortcut stops active turn');
  check('native shortcut stops the held turn without resending',await latestTemporary()&&await site.evaluate('fixtureSends.length===2')&&await value()==='');
  const beforeRepeat=await setups();await type('Keep native repeat draft');await chord({autoRepeat:true});await sleep(60);
  check('native repeated chord keeps its draft and chat',await setups()===beforeRepeat&&await value()==='Keep native repeat draft');
  await key('N','KeyN',78,11);await sleep(60);
  check('native Alt chord keeps its draft and chat',await setups()===beforeRepeat&&await value()==='Keep native repeat draft');
  await key('n','KeyN',78,2);await waitFor(async()=>(await setups())>beforeRepeat,'native normal New chat');
  check('native Ctrl+N remains ordinary New chat',await site.evaluate('!fixtureSetups.at(-1).temporary')&&await main.evaluate('document.getElementById("mode-chip").hidden'));
  await type('Native ordinary prompt');await key('Enter','Enter',13,0,{text:'\r'});await waitFor(()=>site.evaluate('fixtureSends.length===3'),'second stubbed native send');
  await site.evaluate('(()=>{const id=fixtureSends.at(-1).id;window.__QCHAT_EMIT__({type:"start",id});window.__QCHAT_EMIT__({type:"done",id,text:"Native fixture answer"});})()');
  await waitFor(()=>main.evaluate('document.getElementById("bubble-zone").textContent.includes("Native fixture answer")'),'native fixture response');
  for(const editor of ['rename','find','chat-search']) {
    if(editor==='rename'){await type('/rename');await key('Enter','Enter',13,0,{text:'\r'});}else await key(editor==='find'?'f':'p',editor==='find'?'KeyF':'KeyP',editor==='find'?70:80,2);
    const selector=editor==='rename'?'.rename-input':editor==='find'?'#find-input':'.feature-search';
    await waitFor(()=>main.evaluate('!!document.querySelector('+JSON.stringify(selector)+')&&!document.querySelector('+JSON.stringify(selector)+').closest("[hidden]")'),'native '+editor+' editor');
    await main.evaluate('window.fixtureEditor=document.querySelector('+JSON.stringify(selector)+');fixtureEditor.value="Keep native edit";fixtureEditor.focus()');
    const before=await setups();await chord();await sleep(60);
    check('native shortcut leaves '+editor+' editing intact',await setups()===before&&await main.evaluate('fixtureEditor.value==="Keep native edit"&&document.activeElement===fixtureEditor'));
    await key('Escape','Escape',27);
  }
  await main.evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([1,128,255,0])],"old-native-shortcut.bin",{type:"application/octet-stream"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));document.getElementById("prompt-input").focus();})()');
  await waitFor(()=>main.evaluate('!!document.querySelector("#attachments [data-state=ready]")'),'native staged file');
  const staged=await uploads();check('native shortcut fixture staged exact local bytes',staged.length===1&&Array.from(staged[0].bytes).join(',')==='1,128,255,0');
  const beforeFile=await setups();await chord();await waitFor(async()=>(await setups())>beforeFile&&(await uploads()).length===0,'native shortcut discards file');
  check('native shortcut discards the old chip and bytes without sending',await latestTemporary()&&await main.evaluate('!document.querySelector("#attachments .attachment-chip")')&&await site.evaluate('fixtureSends.length===3'));
  await type('/keys');await key('Enter','Enter',13,0,{text:'\r'});
  await waitFor(()=>main.evaluate('document.querySelector(".feature-list").textContent.includes("Keyboard shortcuts")'),'native keyboard help');
  check('native keyboard help lists Temporary shortcut',await main.evaluate('document.querySelector(".feature-list").textContent.includes("Ctrl+Shift+N")'));
  await main.evaluate('Array.from(document.querySelectorAll(".feature-list .key")).find(node=>node.textContent==="Ctrl+Shift+N")?.scrollIntoView({block:"center"})');
  const shotDirectory=path.join(root,'.tmp','temporary-shortcut-shots');await mkdir(shotDirectory,{recursive:true});await writeFile(path.join(shotDirectory,'native-help-340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  check('native Temporary shortcut has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-temporary-shortcut-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
