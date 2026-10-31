// Hidden isolated WebView2. Real provider reload/offline recovery, fixture data
// only: no account messages, OS input, clipboard access or network settings.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-reconnect-native-'));
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const app=spawn(path.join(root,'src-tauri','target','debug','qchat.exe'),[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
let launchError,ui,site,failed=0;app.on('error',error=>{launchError=error});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(name,ok,detail='')=>{console.log(`${ok?'PASS':'FAIL'} ${name}${!ok&&detail?' :: '+detail:''}`);if(!ok)failed++};
function cdp(url){
  const ws=new WebSocket(url),pending=new Map();let serial=0;
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connection timeout')),10000);ws.onopen=()=>{clearTimeout(timer);resolve()};ws.onerror=()=>{clearTimeout(timer);reject(Error('CDP connection failed'))}});
  ws.onmessage=event=>{const result=JSON.parse(event.data);if(result.id){pending.get(result.id)?.(result);pending.delete(result.id)}};
  ws.onclose=()=>{for(const callback of pending.values())callback({error:{message:'CDP closed'}});pending.clear()};
  const call=async(method,params={})=>{await ready;const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,result=>{clearTimeout(timer);result.error?reject(Error(result.error.message)):resolve(result.result)});ws.send(JSON.stringify({id,method,params}))})};
  const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error('Page evaluation failed');return result.result?.value};
  return {ready,call,evaluate,close:()=>ws.close()};
}
function ownsEndpoint(){
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000,windowsHide:true});return result.status===0&&result.stdout.trim()==='owned';
}
async function until(connection,expression,label,timeout=40000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){try{if(await connection.evaluate(`!!(${expression})`))return}catch{}await sleep(100)}
  throw Error('Timed out: '+label);
}
const invoke=(command,args={})=>ui.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const ready="/Ready|Guest/.test(document.getElementById('status-label')?.textContent||'')";
try{
  let pages=[];
  for(let i=0;i<100;i++){
    if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Isolated app exited early');
    try{pages=await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(700)})).json()}catch{}
    if(pages.some(page=>page.url.startsWith('https://chatgpt.com/'))&&pages.some(page=>page.url.includes('tauri.localhost')))break;
    await sleep(200);
  }
  if(!ownsEndpoint())throw Error('Debug endpoint is not owned by the spawned isolated app');
  const main=pages.find(page=>page.url.includes('tauri.localhost')&&!page.url.includes('settings'));
  const provider=pages.find(page=>page.url.startsWith('https://chatgpt.com/'));
  if(!main||!provider)throw Error('WebView2 targets unavailable');
  ui=cdp(main.webSocketDebuggerUrl);site=cdp(provider.webSocketDebuggerUrl);await Promise.all([ui.ready,site.ready]);
  await until(ui,ready,'initial guest ready');await until(site,'!!window.__qchat','provider bridge ready');
  const transcript=[{id:'reconnect-u',role:'user',text:'Fixture earlier prompt'},{id:'reconnect-a',role:'assistant',text:'Fixture earlier reply'}];
  const chat={key:'reconnect-fixture',provider:'chatgpt',title:'Reconnect fixture',createdAt:1,lastActive:1,lastPrompt:transcript[0].text,lastResponse:transcript[1].text,transcript,draft:'Draft before reconnect 🌏'};
  await ui.evaluate(`QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0});localStorage.setItem('qchat.chats',${JSON.stringify(JSON.stringify({v:1,current:chat,recent:[]}))});true`);
  await ui.call('Page.reload');await until(ui,"document.getElementById('prompt-input')?.value==='Draft before reconnect 🌏'",'draft restored');await until(ui,ready,'restored UI ready');
  const generation=(await invoke('launch_info')).uploadGeneration;
  const meta=await invoke('attachment_begin',{name:'native-draft.txt',mime:'text/plain',size:13,uploadGeneration:generation});
  await invoke('attachment_chunk',{id:meta.id,offset:0,data:Buffer.from('fixture bytes').toString('base64')});await invoke('attachment_finish',{id:meta.id});
  await ui.evaluate("(()=>{const data=new DataTransfer();data.items.add(new File(['composer fixture'],'composer-draft.txt',{type:'text/plain'}));const input=document.getElementById('attachment-input');input.files=data.files;input.dispatchEvent(new Event('change'))})()");
  await until(ui,"!!document.querySelector('#attachments [data-state=ready]')",'composer file ready');
  const providerUrl=await site.evaluate('location.href');
  await site.evaluate("window.__reconnectDocumentMarker=true;window.__QCHAT_EMIT__({type:'status',ready:false,loggedIn:true,url:location.href})");
  await ui.evaluate("window.dispatchEvent(new Event('online'))");
  await until(ui,ready,'signed-in-state recovery ready');await until(site,'!!window.__qchat','bridge after reload');
  check('online recovery reloads the provider document',await site.evaluate('window.__reconnectDocumentMarker===undefined'));
  check('signed-in-state recovery retains actual native staged bytes',(await invoke('attachment_finish',{id:meta.id})).id===meta.id&&String(await readFile(path.join(profile,'qchat-cache','media-session','uploads',meta.id,'native-draft.txt')))==='fixture bytes');
  check('recovery preserves provider URL, draft, visible file and transcript',await site.evaluate('location.href')===providerUrl&&await ui.evaluate(`document.getElementById('prompt-input').value==='Draft before reconnect 🌏'&&document.getElementById('attachments').textContent.includes('composer-draft.txt')&&JSON.stringify(JSON.parse(localStorage.getItem('qchat.chats')).current.transcript)===${JSON.stringify(JSON.stringify(transcript.map(item=>({...item,selectionTexts:[],hasMedia:false,media:[],hadAttachments:false,stopped:false,sources:[]}))))}`).catch(()=>false));
  // Only this disposable provider WebView goes offline. No PC connection changes.
  await site.evaluate("window.__QCHAT_EMIT__({type:'status',ready:false,loggedIn:false,url:location.href})");
  await site.call('Network.enable');await site.call('Network.setCacheDisabled',{cacheDisabled:true});
  await site.call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await site.call('Page.reload',{ignoreCache:true});await sleep(800);
  check('isolated provider really fails to load while offline',await site.evaluate('!window.__qchat'));
  await ui.evaluate("(async()=>{await window.__TAURI__.event.emit('bridge',{type:'status',provider:'chatgpt',ready:false,loggedIn:false});await window.__TAURI__.event.emit('bridge',{type:'error',provider:'chatgpt',code:'offline'})})()");
  await until(ui,"!document.getElementById('global-error').hidden",'offline notice shown');
  // Signal recovery first so Chromium's own error-page auto reload cannot clear
  // the notice before the app receives the event. Only the provider is offline.
  await sleep(3100);await ui.evaluate("window.dispatchEvent(new Event('online'))");
  await site.call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await until(ui,ready,'real offline/online recovery ready');await until(site,'!!window.__qchat','real provider bridge restored');
  const recoveryState=await ui.evaluate("({draft:document.getElementById('prompt-input').value,file:!!document.querySelector('#attachments [data-state=ready]'),errorHidden:document.getElementById('global-error').hidden,feedback:document.getElementById('command-feedback').textContent,status:document.getElementById('status-label').textContent})");
  check('real offline page recovers on online without clearing the draft files',(await invoke('attachment_finish',{id:meta.id})).id===meta.id&&recoveryState.draft==='Draft before reconnect 🌏'&&recoveryState.file&&recoveryState.errorHidden&&recoveryState.feedback.includes('Reconnected'),JSON.stringify(recoveryState));
  check('recovery sends no fixture prompts',await ui.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.transcript.length===2&&!document.querySelector('#bubble-zone [data-status=streaming]')"));
  const rejected=async args=>{try{await invoke('chat_status',args);return false}catch{return true}};
  check('native recovery rejects a stale provider target',await rejected({reconnect:true,provider:'gemini'}));
  await site.evaluate('window.__qchat.send=()=>{}');await invoke('chat_send',{id:'busy-reconnect',prompt:'fixture'});
  check('native recovery refuses to interrupt an active turn',await rejected({reconnect:true,provider:'chatgpt'}));await invoke('chat_stop');
  check('busy rejection leaves retained file available',(await invoke('attachment_finish',{id:meta.id})).id===meta.id);
}catch(error){console.error('FAIL harness :: '+error.message);failed++}
finally{
  if(ui)void invoke('quit_app').catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  ui?.close();site?.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  const resolved=path.resolve(profile);if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-reconnect-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
