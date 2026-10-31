// Hidden native privacy preflight, payload and file-retention races.
// Provider methods are stubs; no account messages or remote file uploads.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-temporary-native-'));
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

  const provider=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith('https://chatgpt.com/')),'provider page');
  site=await connect(provider);await waitFor(()=>site.evaluate('!!window.__qchat'),'provider bridge');
  await site.evaluate('window.fixtureSends=[];window.fixtureAttachmentCalls=[];window.fixtureHoldAttachments=false;window.fixtureHoldSends=false;window.fixtureOriginalBridge=window.__qchat;fixtureOriginalBridge.temporaryReady=()=>false;fixtureOriginalBridge.send=job=>{fixtureSends.push(job);if(!fixtureHoldSends)window.__QCHAT_EMIT__({type:"done",id:job.id,text:"",finishReason:"stop"});};fixtureOriginalBridge.status=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:false,temporary:false,url:location.href});fixtureOriginalBridge.newChat=fixtureOriginalBridge.status;window.__qchat=new Proxy(fixtureOriginalBridge,{get(target,key){if(typeof key==="string"&&/attachment|upload|file/i.test(key))return(...args)=>{fixtureAttachmentCalls.push(key);if(fixtureHoldAttachments&&key==="attachmentInput")return new Promise(resolve=>{window.fixtureReleaseAttachment=()=>resolve("input[data-qchat-fixture-never]");});throw Error("QChat fixture blocks remote file selection");};return Reflect.get(target,key);}});fixtureOriginalBridge.status();');
  const invoke=(command,args={})=>main.evaluate('window.__TAURI__.core.invoke('+JSON.stringify(command)+','+JSON.stringify(args)+').then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))');
  const info=await invoke('launch_info');
  const bytes=Buffer.from([0,255,1,128,10,13,71,0]);
  const begin=await invoke('attachment_begin',{name:'private-boundary.bin',mime:'application/octet-stream',size:bytes.length,uploadGeneration:info.value?.uploadGeneration||0});
  if(!begin.ok||!begin.value?.id)throw Error('Could not stage isolated file: '+begin.error);
  const fileId=begin.value.id;
  const chunk=await invoke('attachment_chunk',{id:fileId,offset:0,data:bytes.toString('base64')});
  const finish=await invoke('attachment_finish',{id:fileId});
  if(!chunk.ok||!finish.ok)throw Error('Could not finish isolated file');
  const before=(await uploads()).find(file=>file.id===fileId);
  if(!before)throw Error('Staged fixture file is missing');
  for(const fixture of [{name:'false',files:[]},{name:'false with a file',files:[fileId]},{name:'missing',files:[]}]) {
    await site.evaluate(fixture.name==='missing'?'delete fixtureOriginalBridge.temporaryReady':'fixtureOriginalBridge.temporaryReady=()=>false');
    const result=await invoke('chat_send',{id:crypto.randomUUID(),prompt:'Private native fixture',provider:'chatgpt',temporary:true,attachmentIds:fixture.files});
    check('native '+fixture.name+' temporary confirmation fails closed',!result.ok&&result.error.includes('temporary_unavailable'),result.error||'native send resolved');
    check('native '+fixture.name+' confirmation reaches no provider send or file method',await site.evaluate('fixtureSends.length===0&&fixtureAttachmentCalls.length===0'));
  }
  const retained=(await uploads()).find(file=>file.id===fileId);
  check('native rejected temporary sends retain exact staged bytes',!!retained&&retained.bytes.equals(before.bytes)&&retained.bytes.equals(bytes));
  const normal=await invoke('chat_send',{id:crypto.randomUUID(),prompt:'Normal native fixture',provider:'chatgpt',attachmentIds:[]});
  await waitFor(()=>site.evaluate('fixtureSends.length===1'),'normal native dispatch');
  check('native rejected privacy checks release flight for a normal send',normal.ok);
  check('native ordinary send stays ordinary',await site.evaluate('fixtureSends[0].temporary!==true'));
  await site.evaluate('fixtureOriginalBridge.temporaryReady=()=>true');
  const confirmed=await invoke('chat_send',{id:crypto.randomUUID(),prompt:'Confirmed private native fixture',provider:'chatgpt',temporary:true,attachmentIds:[]});
  await waitFor(()=>site.evaluate('fixtureSends.length===2'),'confirmed native dispatch');
  check('native confirmed temporary send dispatches explicit privacy intent',confirmed.ok&&await site.evaluate('fixtureSends[1].temporary===true'));
  check('native acceptance never selected a provider file input',await site.evaluate('fixtureAttachmentCalls.length===0'));
  const racingId=crypto.randomUUID();
  await main.evaluate('(async()=>{window.fixtureTerminalSeen=false;await window.__TAURI__.event.listen("bridge",event=>{if(event.payload.id==='+JSON.stringify(racingId)+'&&event.payload.code==="temporary_unavailable")window.fixtureTerminalSeen=true;});})()');
  await site.evaluate('fixtureHoldAttachments=true');
  await main.evaluate('window.heldFixtureResult=null;window.__TAURI__.core.invoke("chat_send",'+JSON.stringify({id:racingId,prompt:'Held local attachment fixture',provider:'chatgpt',temporary:false,attachmentIds:[fileId]})+').then(value=>{window.heldFixtureResult={ok:true,value};},error=>{window.heldFixtureResult={ok:false,error:String(error)};});undefined');
  await waitFor(()=>site.evaluate('typeof window.fixtureReleaseAttachment==="function"'),'held pre-upload boundary');
  await site.evaluate('window.__QCHAT_EMIT__('+JSON.stringify({type:'error',id:racingId,code:'temporary_unavailable',message:'Synthetic late mode loss'})+');undefined');
  await waitFor(()=>main.evaluate('window.fixtureTerminalSeen===true'),'native privacy terminal');
  const afterTerminal=(await uploads()).find(file=>file.id===fileId);
  check('late native privacy terminal retains owned attachment bytes',!!afterTerminal&&afterTerminal.bytes.equals(bytes));
  await site.evaluate('fixtureHoldSends=true');
  const newerId=crypto.randomUUID();
  const newer=await invoke('chat_send',{id:newerId,prompt:'New reserved fixture',provider:'chatgpt',attachmentIds:[]});
  check('late privacy terminal releases its own reservation',newer.ok);
  await site.evaluate('fixtureReleaseAttachment();fixtureHoldAttachments=false');
  await waitFor(()=>main.evaluate('window.heldFixtureResult!==null'),'old attachment operation settles');
  const blocked=await invoke('chat_send',{id:crypto.randomUUID(),prompt:'Should stay busy',provider:'chatgpt',attachmentIds:[]});
  check('stale attachment failure does not clear a newer reservation',!blocked.ok&&blocked.error.includes('busy'));
  await site.evaluate('window.__QCHAT_EMIT__('+JSON.stringify({type:'done',id:newerId,text:'',finishReason:'stop'})+');undefined');
  await site.evaluate('fixtureHoldSends=false');
  check('native race fixture leaves provider file inputs empty',await site.evaluate('Array.from(document.querySelectorAll("input[type=file]")).every(input=>!input.files?.length)'));
  const removed=await invoke('attachment_remove',{id:fileId});
  await waitFor(async()=>(await uploads()).length===0,'fixture file removal');
  check('native privacy fixture cleanup releases its local bytes',removed.ok);
  check('native temporary preflight has no unexpected runtime errors',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-temporary-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
