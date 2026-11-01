// Hidden native attachment control stability using real staged bytes.
// Image copying and provider submission are stubbed; no OS clipboard/input.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-attachment-focus-native-'));
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
  await site.evaluate('window.fixtureSends=0;window.fixtureStatus=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:false,url:location.href});window.__qchat.send=()=>{fixtureSends++;};window.__qchat.newChat=fixtureStatus;window.__qchat.status=fixtureStatus;fixtureStatus();');
  await main.evaluate('window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340}))');
  await main.evaluate('window.fixtureReader=FileReader;window.fixtureHoldRead=false;window.fixtureFailRead=false;window.fixtureReadRelease=null;window.FileReader=class extends fixtureReader{readAsDataURL(blob){if(fixtureFailRead){fixtureFailRead=false;queueMicrotask(()=>this.onerror?.(new Event("error")));return;}if(fixtureHoldRead){fixtureHoldRead=false;window.fixtureReadRelease=()=>{window.fixtureReadRelease=null;super.readAsDataURL(blob);};return;}return super.readAsDataURL(blob);}};window.fixtureCopyCalls=0;window.fixtureCopyArgs=null;window.fixtureNativeInvoke=window.__TAURI__.core.invoke;window.fixtureInvoke=async(cmd,args)=>{if(cmd==="image_copy"){fixtureCopyCalls++;fixtureCopyArgs=args;await new Promise(resolve=>{window.fixtureCopyRelease=resolve;});return null;}return fixtureNativeInvoke(cmd,args);};window.__TAURI__.core={...window.__TAURI__.core,invoke:fixtureInvoke};if(window.__TAURI__.core.invoke!==fixtureInvoke)throw Error("Clipboard stub could not be installed");');
  const prompt='Native draft 🌏';
  const clear=async()=>{
    await main.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"n",ctrlKey:true,bubbles:true,cancelable:true}))');
    await waitFor(()=>main.evaluate('document.querySelectorAll("#attachments .attachment-chip").length===0'),'clear UI attachments');
    await waitFor(async()=>(await uploads()).length===0,'clear native bytes');
    await main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value='+JSON.stringify(prompt)+';input.dispatchEvent(new Event("input"));input.setSelectionRange(2,7,"backward");input.focus();})()');
  };
  const add=(name,size)=>main.evaluate('(()=>{const bytes=new Uint8Array('+size+');for(let index=0;index<bytes.length;index++)bytes[index]=(index*37+191)%256;const transfer=new DataTransfer();transfer.items.add(new File([bytes],'+JSON.stringify(name)+',{type:"application/octet-stream"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');
  const readyCount=count=>waitFor(()=>main.evaluate('document.querySelectorAll("#attachments [data-state=ready]").length==='+count),'ready attachment count '+count);
  const heldProgress=async(name)=>{await main.evaluate('fixtureHoldRead=true');await add(name,1048587);await waitFor(()=>main.evaluate('typeof fixtureReadRelease==="function"'),'held native FileReader');};
  const release=()=>main.evaluate('fixtureReadRelease()');
  for(const control of ['ready','selection','retry']) {
    await clear();
    if(control==='ready'){await add('existing-native.bin',37);await readyCount(1);}
    if(control==='selection'){await main.evaluate('window.__TAURI__.event.emit("qchat://selection","Quoted native focus fixture")');await waitFor(()=>main.evaluate('!!document.querySelector("#attachments .selection-chip button")'),'selection chip');}
    if(control==='retry'){await main.evaluate('fixtureFailRead=true');await add('failed-native.bin',41);await waitFor(()=>main.evaluate('!!document.querySelector("#attachments [data-state=error]")'),'failed native chip');}
    await heldProgress('progress-native.bin');
    const selector=control==='ready'?'[aria-label="Remove existing-native.bin"]':control==='selection'?'.selection-chip button':'[data-action="retry-attachment"]';
    await main.evaluate('window.fixtureFocus=document.querySelector('+JSON.stringify('#attachments '+selector)+');fixtureFocus.focus()');
    check('native '+control+' control is keyboard reachable',await main.evaluate('document.activeElement===fixtureFocus'));
    await release();await readyCount(control==='ready'?2:1);
    check('native '+control+' focus survives real chunk progress',await main.evaluate('fixtureFocus.isConnected&&document.activeElement===fixtureFocus'));
  }
  await clear();await add('same-native.bin',37);await readyCount(1);await add('same-native.bin',38);await readyCount(2);await heldProgress('same-progress.bin');
  await main.evaluate('window.fixtureSame=Array.from(document.querySelectorAll("#attachments button[aria-label]")).filter(button=>button.getAttribute("aria-label")==="Remove same-native.bin")[1];fixtureSame.focus()');
  await release();await readyCount(3);
  check('native same-name focus stays on its original item',await main.evaluate('fixtureSame.isConnected&&document.activeElement===fixtureSame'));
  await main.evaluate('Array.from(document.querySelectorAll("#attachments button[aria-label]")).filter(button=>button.getAttribute("aria-label")==="Remove same-native.bin")[1].focus()');
  await main.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});await main.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await readyCount(2);await waitFor(async()=>(await uploads()).length===2,'native same-name removal');
  const remaining=await uploads();
  check('native keyboard removal discards the correct same-name bytes',remaining.some(file=>file.bytes.length===37)&&!remaining.some(file=>file.bytes.length===38));
  await clear();
  await main.evaluate('(async()=>{const canvas=document.createElement("canvas");canvas.width=2;canvas.height=2;const context=canvas.getContext("2d");context.fillStyle="#66aaff";context.fillRect(0,0,2,2);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const transfer=new DataTransfer();transfer.items.add(new File([blob],"copy-native.png",{type:"image/png"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');
  await readyCount(1);await heldProgress('copy-progress-native.bin');
  await main.evaluate('window.fixtureCopyButton=document.querySelector("#attachments .image-copy");fixtureCopyButton.focus()');
  check('native image-copy control is keyboard reachable',await main.evaluate('document.activeElement===fixtureCopyButton'));
  await main.evaluate('fixtureCopyButton.click()');
  try { await waitFor(()=>main.evaluate('typeof window.fixtureCopyRelease==="function"'),'stubbed native image copy'); }
  catch(error) { throw Error(error.message+' :: '+JSON.stringify(await main.evaluate('({text:fixtureCopyButton.textContent,connected:fixtureCopyButton.isConnected,disabled:fixtureCopyButton.disabled,focused:document.activeElement===fixtureCopyButton,calls:fixtureCopyCalls,src:document.querySelector("#attachments img")?.src,complete:document.querySelector("#attachments img")?.complete,width:document.querySelector("#attachments img")?.naturalWidth})'))); }
  await release();await readyCount(2);
  check('native pending image copy keeps its disabled DOM control',await main.evaluate('fixtureCopyButton.isConnected&&document.querySelector("#attachments .image-copy")===fixtureCopyButton&&fixtureCopyButton.disabled&&fixtureCopyCalls===1'));
  await main.evaluate('fixtureCopyRelease()');await waitFor(()=>main.evaluate('!fixtureCopyButton.disabled'),'copy completion');
  check('native image-copy feedback remains visible',await main.evaluate('document.querySelector("#attachments .image-copy").textContent==="Copied"'));
  check('native copy fixture receives exact pixels without OS clipboard access',await main.evaluate('fixtureCopyCalls===1&&fixtureCopyArgs.width===2&&fixtureCopyArgs.height===2&&atob(fixtureCopyArgs.rgba).length===16&&Array.from(atob(fixtureCopyArgs.rgba)).every((character,index)=>character.charCodeAt(0)===[102,170,255,255][index%4])'));
  const shotDirectory=path.join(root,'.tmp','attachment-focus-shots');await mkdir(shotDirectory,{recursive:true});await writeFile(path.join(shotDirectory,'native-copy-340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  check('native background progress preserves the draft and backward range',await main.evaluate('(()=>{const input=document.getElementById("prompt-input");return input.value==='+JSON.stringify(prompt)+'&&input.selectionStart===2&&input.selectionEnd===7&&input.selectionDirection==="backward";})()'));
  await clear();check('native attachment focus fixture clears its local cache',(await uploads()).length===0);
  check('native focus checks submit no provider messages',await site.evaluate('fixtureSends===0'));
  check('native attachment focus has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-attachment-focus-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
