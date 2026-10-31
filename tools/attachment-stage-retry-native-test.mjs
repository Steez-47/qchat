// Hidden native staging/Retry checks. Synthetic FileReader faults, real native
// upload bytes and cleanup; isolated profile, provider stubs, no OS input/send.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-stage-retry-native-'));
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
  const provider=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith('https://chatgpt.com/')),'provider target');
  site=await connect(provider);await waitFor(()=>site.evaluate('!!window.__qchat'),'provider fixture');
  await site.evaluate("window.__stageSendCount=0;window.__stageNewCount=0;window.__stageStatus=()=>window.__QCHAT_EMIT__({type:'status',ready:true,loggedIn:false,url:location.href});window.__qchat.send=()=>{window.__stageSendCount++};window.__qchat.status=window.__stageStatus;window.__qchat.newChat=async()=>{window.__stageNewCount++;await window.__stageStatus()};window.__stageStatus()");
  await main.evaluate("window.__TAURI__.event.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0,barWidth:340,replyWidth:340}))");
  await waitFor(()=>main.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bar-w').trim()==='340px'"),'minimum bar width');
  const draft='Draft stays here\nCafé 🦊';
  await main.evaluate(`(()=>{const input=document.getElementById('prompt-input');input.value=${JSON.stringify(draft)};input.dispatchEvent(new Event('input'));input.focus();input.setSelectionRange(3,9)})()`);
  await main.evaluate("window.__TAURI__.event.emit('qchat://selection','Keep this quoted context')");
  const retry="document.querySelector('#attachments [data-action=retry-attachment]')";
  const installFault=()=>main.evaluate("window.__stageOriginalRead??=FileReader.prototype.readAsDataURL;window.__stageRead={count:0,holdAt:2,held:false,release:null};FileReader.prototype.readAsDataURL=function(blob){const probe=window.__stageRead;probe.count++;if(probe.count===probe.holdAt){probe.held=true;probe.release=(succeed=false)=>{probe.held=false;if(succeed)return window.__stageOriginalRead.call(this,blob);this.onerror?.(new Event('error'))};return}return window.__stageOriginalRead.call(this,blob)}");
  const addFile=(name,size)=>main.evaluate(`(()=>{const bytes=Uint8Array.from({length:${size}},(_,i)=>i%251);const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:'application/octet-stream'}));const input=document.getElementById('attachment-input');input.files=transfer.files;input.dispatchEvent(new Event('change'))})()`);
  const ready=()=>main.evaluate("!!document.querySelector('#attachments .attachment-chip[data-state=ready]')");
  const release=(succeed=false)=>main.evaluate(`window.__stageRead.release(${JSON.stringify(succeed)})`);
  const nativeSize=1024*1024+173,filename='原本 🦊.bin';
  const expected=Buffer.from(Uint8Array.from({length:nativeSize},(_,i)=>i%251));
  await installFault();await addFile(filename,nativeSize);
  await waitFor(()=>main.evaluate('window.__stageRead.held'),'second read held');
  const partial=await uploads();
  check('native first attempt contains the exact first chunk',partial.length===1&&partial[0].bytes.length===512*1024&&partial[0].bytes.equals(expected.subarray(0,512*1024)));
  const oldId=partial[0]?.id;
  await release();await waitFor(()=>main.evaluate(`!!(${retry})`),'failed chip Retry');
  await waitFor(async()=>(await uploads()).length===0,'failed partial cleanup');
  check('native failed preparation removes its partial upload',!await ready()&&(await uploads()).length===0);
  const geometry=await main.evaluate(`(()=>{const button=${retry},chip=button.closest('.attachment-chip'),box=chip.getBoundingClientRect();return {left:box.left,right:box.right,viewport:innerWidth,buttonFits:button.scrollWidth<=button.clientWidth+1,label:button.getAttribute('aria-label')}})()`);
  check('native failed chip has a usable Retry at340px',geometry.left>=0&&geometry.right<=geometry.viewport+1&&geometry.buttonFits&&geometry.label?.includes(filename),JSON.stringify(geometry));
  const shots=path.join(root,'.tmp','stage-retry-shots');await mkdir(shots,{recursive:true});await writeFile(path.join(shots,'native-error340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await main.evaluate(`(()=>{const input=document.getElementById('prompt-input');input.focus();input.setSelectionRange(3,9);const button=${retry};button.click();button.click()})()`);
  await waitFor(ready,'retried file ready');
  const retried=await uploads();
  check('native Retry writes the original bytes under one fresh ID',retried.length===1&&retried[0].id!==oldId&&retried[0].name===filename&&retried[0].bytes.equals(expected));
  check('native Retry preserves draft, caret and quoted context',await main.evaluate(`(()=>{const input=document.getElementById('prompt-input');return document.activeElement===input&&input.value===${JSON.stringify(draft)}&&input.selectionStart===3&&input.selectionEnd===9&&!!document.querySelector('#attachments .selection-chip')})()`));
  check('native Retry keeps pending upload metadata out of saved chats',await main.evaluate(`!String(localStorage.getItem('qchat.chats')).includes(${JSON.stringify(retried[0]?.id)})&&!String(localStorage.getItem('qchat.chats')).includes(${JSON.stringify(filename)})`));

  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");
  await waitFor(async()=>(await uploads()).length===0,'ready file removed');
  await installFault();await addFile('cancelled.bin',nativeSize);await waitFor(()=>main.evaluate('window.__stageRead.held'),'cancel fixture initial read');await release();
  await waitFor(()=>main.evaluate(`!!(${retry})`),'cancel fixture Retry');
  await main.evaluate(`window.__stageRead.holdAt=window.__stageRead.count+1;(${retry}).click()`);
  await waitFor(()=>main.evaluate('window.__stageRead.held'),'retry read held');
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");await release();
  await main.evaluate('FileReader.prototype.readAsDataURL=window.__stageOriginalRead');
  await addFile('queue-barrier.bin',23);await waitFor(ready,'queue after removed Retry');
  let files=await uploads();
  check('native removal during Retry leaves no orphan or revived chip',files.length===1&&files[0].name==='queue-barrier.bin'&&await main.evaluate("!document.getElementById('attachments').textContent.includes('cancelled.bin')"));
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");await waitFor(async()=>(await uploads()).length===0,'barrier removed');

  await installFault();await addFile('new-chat-cancel.bin',nativeSize);await waitFor(()=>main.evaluate('window.__stageRead.held'),'new-chat initial read');await release();await waitFor(()=>main.evaluate(`!!(${retry})`),'new-chat failed chip');
  await main.evaluate('window.__stageRead.holdAt=window.__stageRead.count+1');await addFile('blocking.bin',nativeSize);await waitFor(()=>main.evaluate('window.__stageRead.held'),'next file blocks queue');
  await main.evaluate(`(${retry}).click();window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await waitFor(()=>site.evaluate('window.__stageNewCount===1'),'native New chat fixture');await release();
  await main.evaluate('FileReader.prototype.readAsDataURL=window.__stageOriginalRead');await addFile('after-new.bin',29);await waitFor(ready,'new-chat queue barrier');
  files=await uploads();
  check('native New chat cancels a queued Retry and old staging files',files.length===1&&files[0].name==='after-new.bin'&&await main.evaluate("document.getElementById('prompt-input').value===''&&!document.getElementById('attachments').textContent.includes('new-chat-cancel.bin')&&!document.getElementById('attachments').textContent.includes('blocking.bin')"));
  check('native file preparation Retry sends no provider messages',await site.evaluate('window.__stageSendCount===0'));
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");await waitFor(async()=>(await uploads()).length===0,'new-chat barrier removed');
  await installFault();await main.evaluate('window.__stageRead.holdAt=1');await addFile('busy-retry.bin',47);await waitFor(()=>main.evaluate('window.__stageRead.held'),'busy fixture read');await release();
  await waitFor(()=>main.evaluate(`!!(${retry})`),'busy fixture error');await waitFor(async()=>(await uploads()).length===0,'busy fixture cleanup');
  await site.evaluate('window.__stageStatus()');
  await main.evaluate("FileReader.prototype.readAsDataURL=window.__stageOriginalRead;(()=>{const input=document.getElementById('prompt-input');input.value='Native busy fixture only';input.dispatchEvent(new Event('input'))})()");
  await waitFor(()=>main.evaluate("!document.getElementById('btn-send').disabled"),'controlled send enabled');await main.evaluate("document.getElementById('btn-send').click()");
  await waitFor(()=>site.evaluate('window.__stageSendCount===1'),'controlled stubbed send');await waitFor(()=>main.evaluate("document.getElementById('btn-send').dataset.mode==='stop'"),'busy UI');
  const disabledDuringSend=await main.evaluate(`(${retry}).disabled`);
  await main.evaluate(`(${retry}).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
  check('native preparation Retry is disabled and guarded during a reply',disabledDuringSend&&(await uploads()).length===0&&await main.evaluate("!!document.querySelector('#attachments .attachment-chip[data-state=error]')"));
  await main.evaluate("document.getElementById('btn-send').click()");await waitFor(()=>main.evaluate("document.getElementById('btn-send').dataset.mode==='send'"),'controlled Stop');
  check('native preparation Retry re-enables after Stop',await main.evaluate(`!(${retry}).disabled`));
  await main.evaluate(`(${retry}).click()`);await waitFor(ready,'Retry after Stop');files=await uploads();
  check('native Retry after Stop stages bytes and preserves the restored draft',files.length===1&&files[0].name==='busy-retry.bin'&&files[0].bytes.equals(expected.subarray(0,47))&&await main.evaluate("document.getElementById('prompt-input').value==='Native busy fixture only'"));
  check('native Retry adds no sends after the controlled busy fixture',await site.evaluate('window.__stageSendCount===1'));
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");await waitFor(async()=>(await uploads()).length===0,'busy fixture removed');
  await installFault();await addFile('portable-retry.bin',nativeSize);await waitFor(()=>main.evaluate('window.__stageRead.held'),'portable initial failure');await release();await waitFor(()=>main.evaluate(`!!(${retry})`),'portable Retry');await waitFor(async()=>(await uploads()).length===0,'portable failed cleanup');
  await main.evaluate(`window.__stageRead.holdAt=window.__stageRead.count+1;(${retry}).click()`);await waitFor(()=>main.evaluate('window.__stageRead.held'),'portable Retry held');
  const portableId=(await uploads())[0]?.id;
  await main.evaluate("document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))");
  await main.evaluate("document.querySelector('#slash-menu [data-command=gemini]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await waitFor(()=>main.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='gemini'"),'provider switch with pending file');
  check('native provider switch keeps the in-flight retrying file',await main.evaluate("!!document.querySelector('[aria-label=\"Remove portable-retry.bin\"]')&&document.getElementById('prompt-input').value==='Native busy fixture only'")&&(await uploads()).some(file=>file.id===portableId));
  await release(true);await waitFor(ready,'portable Retry ready');files=await uploads();
  check('native Retry completes exact bytes after switching providers',files.length===1&&files[0].id===portableId&&files[0].name==='portable-retry.bin'&&files[0].bytes.equals(expected));
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button[aria-label^=Remove]').click()");await waitFor(async()=>(await uploads()).length===0,'portable file removed');
  await main.evaluate("(async()=>{const invoke=window.__TAURI__.core.invoke;const generation=(await invoke('launch_info')).uploadGeneration;window.__quotaIds=[];for(let i=0;i<32;i++){const file=await invoke('attachment_begin',{name:'quota-'+i+'.bin',mime:'application/octet-stream',size:1,uploadGeneration:generation});__quotaIds.push(file.id);await invoke('attachment_chunk',{id:file.id,offset:0,data:'AA=='});await invoke('attachment_finish',{id:file.id})}})()");
  await addFile('quota.bin',1);
  await waitFor(()=>main.evaluate("!!document.querySelector('#attachments [data-state=error]')&&document.getElementById('command-feedback').textContent.includes('Attachment cache is full. Start a new chat to clear it.')"),'native quota guidance');
  check('native full staging quota gives the specific recovery guidance',(await uploads()).length===32);
  await writeFile(path.join(shots,'native-cache-full340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await main.evaluate("window.__TAURI__.core.invoke('attachment_remove',{id:window.__quotaIds[0]})");
  await main.evaluate(`(${retry}).click()`);await waitFor(ready,'Retry after freeing quota');files=await uploads();
  const quotaFile=files.find(file=>file.name==='quota.bin');
  check('native preparation Retry recovers when capacity becomes available',files.length===32&&quotaFile?.bytes.length===1&&quotaFile.bytes[0]===0);
  check('native file preparation Retry has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-stage-retry-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
