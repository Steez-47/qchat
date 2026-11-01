// Actual native temporary navigation and guarded file handoff.
// Every provider request is fulfilled locally; no request is forwarded.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-temporary-attachment-native-'));
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
  const ws=new WebSocket(page.webSocketDebuggerUrl),pending=new Map(),handlers=new Set();let serial=0;
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=event=>{const result=JSON.parse(event.data);if(result.id){pending.get(result.id)?.(result);pending.delete(result.id)}else {if(result.method==='Runtime.exceptionThrown')problems.push(result.params.exceptionDetails.exception?.description||result.params.exceptionDetails.text);for(const handler of handlers)Promise.resolve(handler(result.method,result.params)).catch(error=>{if(ws.readyState===WebSocket.OPEN)problems.push(error.message)})}};
  ws.onclose=()=>{for(const done of pending.values())done({error:{message:'CDP closed'}});pending.clear()};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,result=>{clearTimeout(timer);result.error?reject(Error(result.error.message)):resolve(result.result)});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
  const client={ws,send,evaluate,onEvent:handler=>handlers.add(handler)};clients.push(client);await send('Runtime.enable');return client;
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
  const invoke=(command,args={})=>main.evaluate('window.__TAURI__.core.invoke('+JSON.stringify(command)+','+JSON.stringify(args)+').then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))');
  await main.evaluate('(async()=>{window.fixtureBridgeEvents=[];await window.__TAURI__.event.listen("bridge",event=>{fixtureBridgeEvents.push(event.payload);if(fixtureBridgeEvents.length>100)fixtureBridgeEvents.shift();});})()');
  const requests=[];let fulfilled=0;
  const fixtureHTML=provider=>`<!doctype html><html><head><meta charset="utf-8"><title>Isolated provider fixture</title><style>body{margin:20px}chat-window{display:block}#prompt-textarea,.ql-editor{display:block;min-height:70px;width:400px;border:1px solid black}button,a,input{min-height:24px}</style><script>sessionStorage.fixtureLoads=String(Number(sessionStorage.fixtureLoads||0)+1);if(location.hash.includes('strip-me'))history.replaceState(null,'',location.pathname+location.search);</script></head><body><div id="fixture-toolbar">${provider==='chatgpt'?'<button id="fixture-temp-control" aria-label="Turn off temporary chat">Temporary</button>':'<span id="fixture-temp-control">Fixture</span>'}</div><a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: QChat fixture">Account</a>${provider==='chatgpt'?'<form><div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox"></div><input id="fixture-file-input" type="file" multiple></form><button data-testid="send-button">Send</button>':'<chat-window class="is-temporary-chat"><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini"></div></rich-textarea><input id="fixture-file-input" type="file" multiple><button aria-label="Send message">Send</button><button data-test-id="reset-button" aria-label="New chat">New chat</button><button aria-label="Temporary chat">Temporary chat</button></chat-window>'}</body></html>`;
  const safeWait=async(client,expression,label)=>waitFor(async()=>{try{return await client.evaluate(expression)}catch{return false}},label);
  const install=async(provider)=>{
    const domain=provider==='chatgpt'?'https://chatgpt.com/':'https://gemini.google.com/';
    const target=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith(domain)),'fixture target '+provider);
    const client=await connect(target);await client.send('Page.enable');
    client.onEvent(async(method,params)=>{
      if(method!=='Fetch.requestPaused')return;
      requests.push({provider,url:params.request.url,method:params.request.method});
      const documentRequest=params.resourceType==='Document';
      const body=documentRequest?fixtureHTML(provider):JSON.stringify(params.request.url.includes('/api/auth/session')?{user:{}}:{});
      await client.send('Fetch.fulfillRequest',{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:documentRequest?'text/html; charset=utf-8':'application/json'}],body:Buffer.from(body).toString('base64')});
      fulfilled++;
    });
    await client.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    const url=provider==='chatgpt'?domain+'?temporary-chat=true#qchat-setup=first':domain+'app';
    await client.send('Page.navigate',{url});
    await safeWait(client,'document.readyState==="complete"&&!!window.__qchat?.stageTemporaryFiles'+(provider==='chatgpt'?'&&window.__qchat.temporaryReady()':''),'actual provider fixture '+provider);
    return client;
  };
  const info=await invoke('launch_info');
  const bytes=Buffer.alloc(259);for(let index=0;index<bytes.length;index++)bytes[index]=(index*37+191)%256;
  for(const provider of ['chatgpt']) {
    site=await install(provider);
    if(provider==='chatgpt') {
      const first=await site.evaluate('Number(sessionStorage.fixtureLoads)');
      await site.evaluate('window.fixtureOldDom=document.createElement("div");fixtureOldDom.id="old-chat-fixture";document.body.append(fixtureOldDom);window.__qchat.newChat({temporary:true,setupId:"second"});undefined');
      await safeWait(site,'location.hash.includes("qchat-setup=second")&&!!window.__qchat?.temporaryReady&&window.__qchat.temporaryReady()','second temporary setup');
      check('second native temporary setup performs a real document load',await site.evaluate('Number(sessionStorage.fixtureLoads)>'+first));
      check('second native temporary setup discards prior chat DOM',await site.evaluate('!document.getElementById("old-chat-fixture")'));
      await site.send('Page.navigate',{url:'https://chatgpt.com/?temporary-chat=true&fixture=strip#qchat-setup=strip-me'});
      await safeWait(site,'document.readyState==="complete"&&!!window.__qchat?.temporaryReady&&window.__qchat.temporaryReady()','router rewrite fixture');
      await site.evaluate('window.__qchat.status();undefined');
      await safeWait(main,'fixtureBridgeEvents.some(event=>event.type==="status"&&event.provider==="chatgpt"&&event.ready&&event.url.includes("fixture=strip"))','native setup status after router rewrite');
      check('native setup correlation survives a router clearing the hash',await main.evaluate('fixtureBridgeEvents.filter(event=>event.type==="status"&&event.provider==="chatgpt"&&event.ready&&event.url.includes("fixture=strip")).at(-1).setupId==="strip-me"'));
    }
    await site.evaluate('window.fixtureEvents=[];window.fixtureJobs=[];window.fixtureLoss=false;window.fixtureReplace=false;window.fixtureStage=null;window.fixtureOriginalStage=window.__qchat.stageTemporaryFiles;window.fixtureOriginalCommit=window.__qchat.commitTemporaryFiles;window.__qchat.stageTemporaryFiles=async id=>{const stage=await fixtureOriginalStage(id);window.fixtureStage=stage;return stage;};window.__qchat.commitTemporaryFiles=id=>{if(fixtureLoss){document.getElementById("fixture-temp-control").setAttribute("aria-label","Temporary chat");document.querySelector("chat-window")?.classList.remove("is-temporary-chat");}if(fixtureReplace){const old=document.getElementById("fixture-file-input");old.replaceWith(old.cloneNode(false));}return fixtureOriginalCommit(id);};window.__qchat.send=job=>{fixtureJobs.push(job);};');
    for(const mode of ['confirmed','mode-lost','input-replaced','pending']) {
      await site.evaluate('fixtureLoss='+JSON.stringify(mode==='mode-lost')+';fixtureReplace='+JSON.stringify(mode==='input-replaced')+';fixtureEvents=[];fixtureStage=null;document.getElementById("fixture-temp-control").setAttribute("aria-label","Turn off temporary chat");document.querySelector("chat-window")?.classList.add("is-temporary-chat");window.fixtureInput=document.getElementById("fixture-file-input");fixtureInput.value="";for(const type of ["input","change"])fixtureInput["on"+type]=event=>fixtureEvents.push({type:event.type,count:event.target.files.length});');
      if(mode==='pending')await site.evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File(["fixture"],"cancelled.bin"));fixtureInput.files=transfer.files;window.__qchat.cancelAttachmentSelection(1);fixtureInput.value="";})()');
      const begin=await invoke('attachment_begin',{name:provider+'-'+mode+'-🌏.bin',mime:'application/octet-stream',size:bytes.length,uploadGeneration:info.value?.uploadGeneration||0});
      if(!begin.ok||!begin.value?.id)throw Error('Fixture attachment begin failed: '+begin.error);
      const fileId=begin.value.id;
      const chunk=await invoke('attachment_chunk',{id:fileId,offset:0,data:bytes.toString('base64')});
      const finish=await invoke('attachment_finish',{id:fileId});if(!chunk.ok||!finish.ok)throw Error('Fixture upload staging failed');
      const id=crypto.randomUUID(),beforeJobs=await site.evaluate('fixtureJobs.length');
      const result=await invoke('chat_send',{id,prompt:'Isolated attachment fixture',provider,temporary:true,attachmentIds:[fileId]});
      if(mode==='confirmed') {
        check(provider+' native confirmed attachment dispatches with privacy intent',result.ok&&await site.evaluate('fixtureJobs.at(-1)?.temporary===true&&fixtureJobs.at(-1)?.attachmentCount===1'));
        check(provider+' actual handoff emits input/change once',await site.evaluate('fixtureEvents.length===2&&fixtureEvents[0].type==="input"&&fixtureEvents[1].type==="change"&&fixtureEvents.every(event=>event.count===1)'));
        check(provider+' actual handoff preserves exact native file bytes',await site.evaluate('(async()=>{const input=document.getElementById("fixture-file-input");const data=new Uint8Array(await input.files[0].arrayBuffer());return Array.from(data).join(",")==='+JSON.stringify(Array.from(bytes).join(','))+';})()'));
        check(provider+' committed quarantine is disconnected and cleared',await site.evaluate('fixtureStage&&!fixtureStage.isConnected&&fixtureStage.files.length===0&&document.getElementById("fixture-file-input").files.length===1'));
        await site.evaluate('document.getElementById("fixture-file-input").value="";window.__QCHAT_EMIT__('+JSON.stringify({type:'done',id,text:'',finishReason:'stop'})+');undefined');
        await safeWait(main,'fixtureBridgeEvents.some(event=>event.type==="done"&&event.id==='+JSON.stringify(id)+')','fixture terminal '+provider);
      } else {
        const code=mode==='pending'?'attachment_pending':'temporary_unavailable';
        check(provider+' native '+mode+' reports the precise failure',!result.ok&&result.error.includes(code),result.error||'send resolved');
        check(provider+' native '+mode+' causes no provider input or send',await site.evaluate('fixtureEvents.length===0&&document.getElementById("fixture-file-input").files.length===0&&fixtureJobs.length==='+beforeJobs));
        const retained=(await uploads()).find(file=>file.id===fileId);
        check(provider+' native '+mode+' retains exact local bytes',!!retained&&retained.bytes.equals(bytes));
        check(provider+' native '+mode+' cleans any detached files',await site.evaluate('!fixtureStage||fixtureStage.files.length===0'));
      }
      const removed=await invoke('attachment_remove',{id:fileId});if(!removed.ok)throw Error(removed.error);
    }
  }
  // Gemini has no Temporary chats: setup and a native Temporary send with a file are both refused.
  {
    const switched=await invoke('provider_set',{provider:'gemini'});if(!switched.ok)throw Error(switched.error);
    site=await install('gemini');
    await site.evaluate('window.fixtureGeminiEvents=[];window.fixtureGeminiEmit=window.__QCHAT_EMIT__;window.__QCHAT_EMIT__=event=>{fixtureGeminiEvents.push(event);fixtureGeminiEmit(event);};window.fixtureGeminiSends=[];window.__qchat.send=job=>{fixtureGeminiSends.push(job);};document.querySelector("chat-window")?.classList.add("is-temporary-chat");window.__qchat.newChat({temporary:true,setupId:"gemini-refused"});undefined');
    await safeWait(site,'fixtureGeminiEvents.some(event=>event.code==="temporary_unavailable"&&event.setupId==="gemini-refused")','Gemini Temporary setup refusal');
    check('Gemini Temporary setup is refused even with its old marker',await site.evaluate('!window.__qchat.temporaryReady()&&!fixtureGeminiEvents.some(event=>event.type==="status"&&event.setupId==="gemini-refused")'));
    const begin=await invoke('attachment_begin',{name:'gemini-refused-🌏.bin',mime:'application/octet-stream',size:bytes.length,uploadGeneration:info.value?.uploadGeneration||0});
    if(!begin.ok||!begin.value?.id)throw Error('Fixture attachment begin failed: '+begin.error);
    const fileId=begin.value.id;
    const chunk=await invoke('attachment_chunk',{id:fileId,offset:0,data:bytes.toString('base64')});
    const finish=await invoke('attachment_finish',{id:fileId});if(!chunk.ok||!finish.ok)throw Error('Fixture upload staging failed');
    const result=await invoke('chat_send',{id:crypto.randomUUID(),prompt:'Isolated attachment fixture',provider:'gemini',temporary:true,attachmentIds:[fileId]});
    check('Gemini native Temporary send is refused',!result.ok&&result.error.includes('temporary_unavailable'),result.error||'send resolved');
    check('Gemini native Temporary send reaches no provider input or send',await site.evaluate('fixtureGeminiSends.length===0&&(document.getElementById("fixture-file-input")?.files.length||0)===0'));
    const retained=(await uploads()).find(file=>file.id===fileId);
    check('Gemini native Temporary refusal retains exact local bytes',!!retained&&retained.bytes.equals(bytes));
    const removed=await invoke('attachment_remove',{id:fileId});if(!removed.ok)throw Error(removed.error);
  }
  await waitFor(()=>fulfilled===requests.length,'all fixture requests fulfilled locally');
  check('fixture transport fulfills every intercepted request locally',fulfilled===requests.length&&fulfilled>0);
  check('native guarded handoff has no unexpected runtime errors',problems.filter(message=>!message.includes('attachment_pending:')).length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-temporary-attachment-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
