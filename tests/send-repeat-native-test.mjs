// Hidden native send-repeat guard checks with scoped CDP keys.
// Provider sends are stubbed and all attachment sends are blocked before native IPC.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-send-repeat-native-'));
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
  await site.evaluate('window.fixtureSends=[];window.fixtureSetups=[];window.fixtureErrorNext=false;window.fixtureTemporary=false;window.fixtureSetupId=null;window.fixtureStatus=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:false,temporary:fixtureTemporary,setupId:fixtureSetupId,url:fixtureTemporary?"https://chatgpt.com/?temporary-chat=true":location.href});window.__qchat.send=job=>{fixtureSends.push(job);if(fixtureErrorNext){fixtureErrorNext=false;window.__QCHAT_EMIT__({type:"error",id:job.id,code:"send_failed",message:"Synthetic failed send"});}};window.__qchat.newChat=(options={})=>{fixtureSetups.push(options);fixtureTemporary=!!options.temporary;fixtureSetupId=options.setupId||null;fixtureStatus();};window.__qchat.temporaryReady=()=>fixtureTemporary;window.__qchat.status=fixtureStatus;window.__qchat.attachmentInput=()=>{throw Error("Fixture blocks provider uploads");};window.__qchat.stageTemporaryFiles=()=>{throw Error("Fixture blocks provider uploads");};fixtureStatus();');
  await main.evaluate('window.fixtureSendRequests=[];window.fixtureStopCalls=0;window.fixtureOriginalInvoke=window.__TAURI__.core.invoke;window.fixtureInvoke=async(cmd,args)=>{if(cmd==="chat_stop")fixtureStopCalls++;if(cmd==="chat_send"){fixtureSendRequests.push(args);if(args?.attachmentIds?.length)throw Error("Fixture blocks remote attachment sends");}return fixtureOriginalInvoke(cmd,args);};window.__TAURI__.core={...window.__TAURI__.core,invoke:fixtureInvoke};if(window.__TAURI__.core.invoke!==fixtureInvoke)throw Error("Native send spy could not be installed");');
  const key=async(key,code,virtualKey,modifiers=0,extra={})=>{
    await main.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers,...(key==='Enter'?{text:'\r'}:{}),...extra});
    await main.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  };
  const enter=(repeat=false,modifiers=0)=>key('Enter','Enter',13,modifiers,{autoRepeat:repeat});
  const value=()=>main.evaluate('document.getElementById("prompt-input").value');
  const sends=()=>site.evaluate('fixtureSends.length');
  const requests=()=>main.evaluate('fixtureSendRequests.length');
  const flush=()=>main.evaluate('window.dispatchEvent(new Event("pagehide"))');
  const type=async text=>{await main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value='+JSON.stringify(text)+';input.dispatchEvent(new Event("input"));input.focus();})()');await waitFor(()=>main.evaluate('!document.getElementById("btn-send").disabled'),'ready native draft');};
  const boot=async(sendKey='enter',keepHistory=true)=>{
    const before=await site.evaluate('fixtureSetups.length');await main.evaluate('document.getElementById("prompt-input").focus()');await key('N','KeyN',78,2);
    await waitFor(async()=>(await site.evaluate('fixtureSetups.length'))>before&&await value()==='','native fresh composer');
    await site.evaluate('fixtureSends=[];fixtureErrorNext=false');await main.evaluate('fixtureSendRequests=[];fixtureStopCalls=0;window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340,sendKey:'+JSON.stringify(sendKey)+',keepHistory:'+keepHistory+'}))');
    await waitFor(()=>main.evaluate('QSettings.settings.sendKey==='+JSON.stringify(sendKey)+'&&QSettings.settings.keepHistory==='+keepHistory),'native send-key settings');
  };
  await boot();await type('Keep native held Enter draft');await main.evaluate('document.getElementById("prompt-input").setSelectionRange(2,9,"backward")');await enter(true);
  check('native repeated Enter submits no request and preserves the draft',await requests()===0&&await sends()===0&&await value()==='Keep native held Enter draft');
  check('native ignored send keeps the exact backward selection',await main.evaluate('(()=>{const input=document.getElementById("prompt-input");return input.selectionStart===2&&input.selectionEnd===9&&input.selectionDirection==="backward";})()'));
  await boot();await type('Recover native failed draft');await site.evaluate('fixtureErrorNext=true');await enter();await waitFor(()=>main.evaluate('document.getElementById("prompt-input").value==="Recover native failed draft"&&!document.getElementById("btn-send").disabled'),'native restored failed draft');
  await enter(true);const beforeFresh=await sends();const restoredReady=beforeFresh===1&&await requests()===1&&await value()==='Recover native failed draft';
  check('native held Enter cannot resend a restored failed draft',restoredReady);
  if(restoredReady){await enter();await waitFor(async()=>(await sends())===2,'native fresh retry');check('native fresh Enter retries the restored prompt once',await requests()===2&&await site.evaluate('fixtureSends[1].prompt==="Recover native failed draft"'));}
  else check('native fresh retry starts from one failed request',false);
  for(const [name,modifiers] of [['Ctrl',2],['Meta',4]]){
    await boot('ctrl');await type('Keep native '+name+' repeat draft');await enter(true,modifiers);
    check('native repeated '+name+'+Enter does not send',await requests()===0&&await sends()===0&&await value()==='Keep native '+name+' repeat draft');
  }
  await boot();await type('Native Shift newline');await enter(true,8);
  check('native repeated Shift+Enter inserts a newline without sending',await value()==='Native Shift newline\n'&&await requests()===0);
  await boot('ctrl');await type('Native ordinary newline');await enter(true);
  check('native repeated Enter in Ctrl-send mode inserts a newline',await value()==='Native ordinary newline\n'&&await requests()===0);
  await boot();await type('Explicit held stream');await enter();await waitFor(async()=>(await sends())===1,'native held stream');await type('Native stream editing');await enter(true);
  check('native repeated Enter during streaming keeps newline editing',await value()==='Native stream editing\n'&&await requests()===1&&await sends()===1);
  await boot();await type('IME native fixture');await main.evaluate('(()=>{const input=document.getElementById("prompt-input");for(const flags of [{isComposing:true},{keyCode:229}])input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",repeat:true,bubbles:true,cancelable:true,...flags}));})()');
  check('native simulated IME and 229 repeats leave the draft local',await value()==='IME native fixture'&&await requests()===0);
  await boot();await type('Fresh legacy IME fixture');await main.evaluate('document.getElementById("prompt-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:229,bubbles:true,cancelable:true}))');
  check('native fresh legacy IME confirmation does not submit',await requests()===0&&await value()==='Fresh legacy IME fixture');
  await boot();const fromSearch='Recovered from native search';await type(fromSearch);await flush();const oldKey=await main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")).current.key');
  const beforeSearchSetup=await site.evaluate('fixtureSetups.length');await key('N','KeyN',78,2);await waitFor(async()=>(await site.evaluate('fixtureSetups.length'))>beforeSearchSetup,'archive native search draft');await key('p','KeyP',80,2);
  await waitFor(()=>main.evaluate('!document.querySelector(".feature-list").hidden'),'native local search');await main.evaluate('(()=>{const field=document.querySelector(".feature-search");field.value='+JSON.stringify(fromSearch)+';field.dispatchEvent(new Event("input",{bubbles:true}));field.focus();})()');await waitFor(()=>main.evaluate('document.querySelectorAll(".feature-row").length===1'),'native search match');await enter();await waitFor(()=>main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")).current.key==='+JSON.stringify(oldKey)),'native search draft restore');await enter(true);
  check('native inherited held Enter after search cannot submit its draft',await requests()===0&&await sends()===0&&await value()===fromSearch);
  await boot();await type('Keep ready file and quote');await main.evaluate('window.__TAURI__.event.emit("qchat://selection","Keep quoted context 🦊");(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0,128,255,17])],"repeat-native.bin",{type:"application/octet-stream"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');await waitFor(()=>main.evaluate('!!document.querySelector("#attachments [data-state=ready]")'),'native repeat attachment');await enter(true);const bytes=await uploads();
  check('native ignored send preserves quote, ready chip and exact local bytes',await requests()===0&&await value()==='Keep ready file and quote'&&await main.evaluate('document.querySelectorAll("#attachments .selection-chip").length===1&&!!document.querySelector("#attachments [data-state=ready]")')&&bytes.length===1&&Array.from(bytes[0].bytes).join(',')==='0,128,255,17');
  await boot();await waitFor(async()=>(await uploads()).length===0,'native repeat file cleanup');await type('Explicit Retry allowed');await site.evaluate('fixtureErrorNext=true');await enter();await waitFor(()=>main.evaluate('document.getElementById("prompt-input").value==="Explicit Retry allowed"&&!document.getElementById("btn-send").disabled'),'native explicit Retry offer');
  await main.evaluate('document.querySelector(\'[data-action="retry-turn"]\').click()');await waitFor(async()=>(await sends())===2,'native explicit Retry');
  check('native explicit Retry remains usable after a send error',await requests()===2&&await site.evaluate('fixtureSends[1].prompt==="Explicit Retry allowed"'));
  await boot();await type('Explicit send button allowed');await enter(true);await main.evaluate('document.getElementById("btn-send").click()');await waitFor(async()=>(await sends())>=1,'native explicit Send button');
  check('native Send button remains usable after an ignored repeat',await requests()===1&&await sends()===1);
  await boot();const privateSetup=await site.evaluate('fixtureSetups.length');await key('N','KeyN',78,10);await waitFor(async()=>(await site.evaluate('fixtureSetups.length'))>privateSetup,'native private repeat setup');await type('NEVER-SAVE private held draft');await enter(true);await flush();
  check('native held Enter leaves a Temporary draft private and unsent',await requests()===0&&await value()==='NEVER-SAVE private held draft'&&await main.evaluate('!(localStorage.getItem("qchat.chats")||"").includes("NEVER-SAVE")'));
  await boot('enter',false);await type('NEVER-SAVE history-off held draft');await enter(true);await flush();
  check('native history-off repeat preserves text without storage or send',await requests()===0&&await value()==='NEVER-SAVE history-off held draft'&&await main.evaluate('localStorage.getItem("qchat.chats")===null'));
  await boot();await main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value="/clear";input.dispatchEvent(new Event("input"));input.focus();})()');await enter(true);
  check('native held Enter cannot activate a slash command',await value()==='/clear'&&await main.evaluate('document.getElementById("clear-confirm").hidden'));
  const clearFixture=async()=>{
    await boot();await type('Native clear-confirm history');const count=await site.evaluate('fixtureSetups.length');await key('N','KeyN',78,2);await waitFor(async()=>(await site.evaluate('fixtureSetups.length'))>count,'native clear history setup');
    await main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value="/clear";input.dispatchEvent(new Event("input"));input.focus();})()');await enter();await waitFor(()=>main.evaluate('!document.getElementById("clear-confirm").hidden'),'native clear confirmation');
    return main.evaluate('JSON.parse(localStorage.getItem("qchat.chats"))');
  };
  for(const [heldKey,code,virtual] of [['Enter','Enter',13],[' ','Space',32]]){
    const before=await clearFixture();await key(heldKey,code,virtual,0,{autoRepeat:true,text:heldKey==='Enter'?'\r':' '});
    check('native held '+code+' cannot confirm clearing history',await main.evaluate('!document.getElementById("clear-confirm").hidden&&JSON.stringify(JSON.parse(localStorage.getItem("qchat.chats")).recent)==='+JSON.stringify(JSON.stringify(before.recent))));
  }
  const clearBefore=await clearFixture();await enter();await waitFor(()=>main.evaluate('document.getElementById("clear-confirm").hidden'),'native explicit Clear');
  check('native fresh Enter still confirms Clear',await main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")).recent.length===0&&!!document.querySelector("#command-feedback button")'));
  await main.evaluate('document.querySelector("#command-feedback button").click()');
  check('native explicit Clear retains exact Undo recovery',await main.evaluate('JSON.stringify(JSON.parse(localStorage.getItem("qchat.chats")).recent)==='+JSON.stringify(JSON.stringify(clearBefore.recent))));
  await boot();await type('Native held Send button');await main.evaluate('document.getElementById("btn-send").focus()');await enter();await waitFor(async()=>(await sends())===1,'native focused Send button');await enter(true);
  check('native held Enter on Send returns to editing rather than Stop',await requests()===1&&await sends()===1&&await main.evaluate('fixtureStopCalls===0&&document.activeElement===document.getElementById("prompt-input")&&document.getElementById("btn-send").dataset.mode==="stop"'));
  check('native send-repeat checks have no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-send-repeat-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
