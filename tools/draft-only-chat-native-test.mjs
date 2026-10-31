// Hidden native draft-only history checks using scoped CDP keys.
// Provider sends are stubbed; no OS keyboard or clipboard interaction.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-draft-only-native-'));
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
  const settings=keepHistory=>main.evaluate('window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340,showTabs:true,keepHistory:'+keepHistory+'}))');
  await settings(true);
  const type=text=>main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value='+JSON.stringify(text)+';input.dispatchEvent(new Event("input"));input.focus();})()');
  const value=()=>main.evaluate('document.getElementById("prompt-input").value');
  const saved=()=>main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")||"null")');
  const flush=()=>main.evaluate('window.dispatchEvent(new Event("pagehide"))');
  const newChat=async(temporary=false)=>{
    const before=await site.evaluate('fixtureSetups.length');
    const modifiers=temporary?10:2;
    await main.send('Input.dispatchKeyEvent',{type:'keyDown',key:'N',code:'KeyN',windowsVirtualKeyCode:78,modifiers});
    await main.send('Input.dispatchKeyEvent',{type:'keyUp',key:'N',code:'KeyN',windowsVirtualKeyCode:78,modifiers});
    await waitFor(async()=>(await site.evaluate('fixtureSetups.length'))>before,'native '+(temporary?'Temporary':'ordinary')+' new chat');
  };
  const restore=async chatKey=>{
    const selector='#tabs .tab[data-key="'+chatKey+'"]';
    await waitFor(()=>main.evaluate('!!document.querySelector('+JSON.stringify(selector)+')'),'draft tab');
    await main.evaluate('document.querySelector('+JSON.stringify(selector)+').click()');
    await waitFor(async()=>(await saved())?.current.key===chatKey,'restored draft chat');
  };
  const firstDraft='\n   \n  Draft 🌏 e\u0301 <b>plain text</b>\nSecond line keeps its spaces.  ';
  await type(firstDraft);await flush();const original=(await saved()).current.key;
  await newChat();let snapshot=await saved();
  const archived=snapshot.recent.find(chat=>chat.key===original);
  check('native New chat preserves a pristine ordinary draft',archived?.draft===firstDraft);
  check('native draft preservation creates no provider conversation',archived?.conversationId===null&&await site.evaluate('fixtureSends.length===0'));
  if(!archived)throw Error('Draft-only preservation is absent; restore checks require the retained chat');
  check('native draft tab has a meaningful safe text title',await main.evaluate('(()=>{const tab=document.querySelector(\'#tabs .tab[data-key="'+original+'"]\');const title=tab?.querySelector(".tab-title");return !!title&&title.textContent.includes("Draft")&&title.children.length===0&&!tab.querySelector("b");})()'));
  await restore(original);
  check('native draft tab restores exact multiline Unicode text',await value()===firstDraft);
  const edited='Edited unsent draft 🌙\nSecond exact line';await type(edited);await newChat();
  snapshot=await saved();check('native leaving the same draft updates one history entry',snapshot.recent.filter(chat=>chat.key===original).length===1&&snapshot.recent.find(chat=>chat.key===original)?.draft===edited);
  const secondKey=snapshot.current.key,secondDraft='Another pristine unsent draft';await type(secondDraft);await restore(original);snapshot=await saved();
  check('native switching tabs preserves the draft-only chat being left',snapshot.recent.some(chat=>chat.key===secondKey&&chat.draft===secondDraft)&&await value()===edited);
  await flush();await main.send('Page.reload');
  await waitFor(()=>main.evaluate('document.readyState==="complete"&&!!window.QSettings&&document.getElementById("prompt-input").value==='+JSON.stringify(edited)),'native draft reload');
  check('native reload restores draft-only current and recent text',await value()===edited&&(await saved()).recent.some(chat=>chat.key===secondKey&&chat.draft===secondDraft));
  const shotDirectory=path.join(root,'.tmp','draft-only-shots');await mkdir(shotDirectory,{recursive:true});await writeFile(path.join(shotDirectory,'native-drafts-340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await newChat();const beforeEmpty=(await saved()).recent.length;await type(' \n  \t ');await newChat();
  check('native whitespace-only drafts add no history entry',(await saved()).recent.length===beforeEmpty);
  await type('/te');await newChat();
  check('native known command prefixes add no history entry',(await saved()).recent.length===beforeEmpty);
  const ordinaryBeforePrivate='Keep ordinary text before private mode';await type(ordinaryBeforePrivate);await flush();const beforePrivate=(await saved()).current.key;await newChat(true);
  check('native Temporary transition retains only the preceding ordinary draft',(await saved()).recent.some(chat=>chat.key===beforePrivate&&chat.draft===ordinaryBeforePrivate));
  const secret='NEVER-SAVE-native-private-draft';await type(secret);await flush();await newChat();
  check('native Temporary draft never enters current or recent storage',!JSON.stringify(await saved()).includes(secret)&&await value()==='');
  await settings(false);await waitFor(()=>main.evaluate('localStorage.getItem("qchat.chats")===null'),'history disabled');
  const disabledSecret='NEVER-SAVE-native-history-disabled';await type(disabledSecret);await newChat();await flush();
  check('native history-disabled draft stays off disk',await main.evaluate('localStorage.getItem("qchat.chats")===null'));
  await settings(true);await flush();
  check('native enabling history cannot resurrect the discarded private draft',!JSON.stringify(await saved()).includes(disabledSecret)&&!JSON.stringify(await saved()).includes(secret));
  check('native draft-only acceptance sends no provider messages',await site.evaluate('fixtureSends.length===0'));
  check('native draft-only acceptance has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-draft-only-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
