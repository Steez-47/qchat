// Hidden real WebView2 edits during provider IPC. MutationObserver injects
// at the busy transition, before native completion. Own profile/provider stubs.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-provider-draft-native-'));
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
  const stubs=[];
  const stub=async(domain)=>{const page=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith(domain)),'provider target');const client=await connect(page);await waitFor(()=>client.evaluate('!!window.__qchat'),'provider bridge');await client.evaluate("window.__providerDraftSends=0;window.__providerDraftStatus=()=>window.__QCHAT_EMIT__({type:'status',ready:true,loggedIn:false,url:location.href});window.__qchat.send=()=>{window.__providerDraftSends++};window.__qchat.status=window.__providerDraftStatus;window.__qchat.newChat=window.__providerDraftStatus;window.__providerDraftStatus()");stubs.push(client);return client};
  site=await stub('https://chatgpt.com/');
  await main.evaluate("window.__TAURI__.event.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0,barWidth:340,replyWidth:340}))");
  const input=async text=>main.evaluate("(()=>{const input=document.getElementById('prompt-input');input.value="+JSON.stringify(text)+";input.dispatchEvent(new Event('input'));input.focus()})()");
  const choose=async(provider,action)=>{
    await main.evaluate("window.__providerObserver?.disconnect();window.__providerEditApplied=false;(()=>{const button=document.getElementById('btn-reasoning');const observer=new MutationObserver(()=>{if(!button.disabled)return;observer.disconnect();window.__providerEditApplied=true;"+action+"});observer.observe(button,{attributes:true,attributeFilter:['disabled']});window.__providerObserver=observer})()");
    await main.evaluate("document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))");
    await main.evaluate("document.querySelector('#slash-menu [data-command="+provider+"]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
    await waitFor(()=>main.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.provider==="+JSON.stringify(provider)),'provider result '+provider);
    check('native edit occurs while '+provider+' change is pending',await main.evaluate('window.__providerEditApplied===true'));
    check('native provider controls settle after '+provider+' change',await main.evaluate("!document.getElementById('btn-reasoning').disabled"));
  };
  await input('Older native draft');
  await main.evaluate("window.__TAURI__.event.emit('qchat://selection','Quoted native context')");await waitFor(()=>main.evaluate("!!document.querySelector('#attachments .selection-chip')"),'quoted context');
  await main.evaluate("(async()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle='#66aaff';context.fillRect(0,0,2,2);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'provider-context.png',{type:'image/png'}));const input=document.getElementById('attachment-input');input.files=transfer.files;input.dispatchEvent(new Event('change'))})()");
  await waitFor(()=>main.evaluate("!!document.querySelector('#attachments [data-state=ready]')"),'native staged image');
  const before=(await uploads())[0],preview=await main.evaluate("document.querySelector('#attachments img').src");
  const latest='Latest 🦊 draft\nSecond line';
  await choose('gemini',"const input=document.getElementById('prompt-input');input.value="+JSON.stringify(latest)+";input.dispatchEvent(new Event('input'));input.setSelectionRange(2,9,'backward');");
  check('native provider result keeps newer text and backward caret',await main.evaluate("(()=>{const input=document.getElementById('prompt-input');return input.value==="+JSON.stringify(latest)+"&&input.selectionStart===2&&input.selectionEnd===9&&input.selectionDirection==='backward'&&document.activeElement===input})()"));
  check('native provider result keeps captured context once',await main.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.selectionTexts.filter(text=>text==='Quoted native context').length===1&&document.querySelectorAll('#attachments .selection-chip').length===1"));
  const after=await uploads();
  check('native provider reset preserves the staged image bytes and preview',after.length===1&&after[0].id===before.id&&after[0].bytes.equals(before.bytes)&&await main.evaluate("document.querySelector('#attachments img').src==="+JSON.stringify(preview)+"&&document.querySelector('#attachments img').complete&&document.querySelector('#attachments img').naturalWidth===2"));
  const persisted=await main.evaluate("localStorage.getItem('qchat.chats')");
  check('native provider reset saves latest multiline text without file handles',JSON.parse(persisted).current.draft===latest&&!persisted.includes(before.id)&&!persisted.includes(preview));
  const shots=path.join(root,'.tmp','provider-draft-shots');await mkdir(shots,{recursive:true});await writeFile(path.join(shots,'native-provider-draft.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await stub('https://gemini.google.com/');
  await input('Native draft to delete');
  await choose('chatgpt',"const input=document.getElementById('prompt-input');input.value='';input.dispatchEvent(new Event('input'));input.setSelectionRange(0,0);document.querySelector('#attachments [aria-label=\"Remove selection\"]').click();");
  check('native provider result respects a deleted draft',await main.evaluate("document.getElementById('prompt-input').value===''") );
  check('native provider result respects removed quoted context',await main.evaluate("!document.querySelector('#attachments .selection-chip')&&JSON.parse(localStorage.getItem('qchat.chats')).current.selectionTexts.length===0"));
  await input('Old native chat draft');
  await choose('gemini',"window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));");
  check('native provider result does not resurrect a New chat draft',await main.evaluate("document.getElementById('prompt-input').value===''&&!document.querySelector('#attachments .selection-chip')"));
  await waitFor(async()=>(await uploads()).length===0,'New chat image cleanup');
  check('native New chat keeps its file clear through a provider result',await main.evaluate("!document.querySelector('#attachments .attachment-name')"));
  const fresh='A fresh native draft 🌱';
  await choose('chatgpt',"window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));const input=document.getElementById('prompt-input');input.value="+JSON.stringify(fresh)+";input.dispatchEvent(new Event('input'));input.setSelectionRange(3,3);");
  check('native provider result keeps edits after New chat',await main.evaluate("(()=>{const input=document.getElementById('prompt-input');return input.value==="+JSON.stringify(fresh)+"&&input.selectionStart===3&&input.selectionEnd===3})()"));
  await main.send('Page.reload');
  await waitFor(()=>main.evaluate("document.readyState==='complete'&&document.getElementById('prompt-input')?.value==="+JSON.stringify(fresh)),'provider draft reload');
  check('native provider draft survives a real main WebView reload',await main.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.draft==="+JSON.stringify(fresh)));
  await input('/temp');
  await main.evaluate("document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
  await waitFor(()=>main.evaluate("document.querySelector('.mode-chips').textContent.includes('Temporary')"),'temporary native chat');
  await input('Temporary native secret');
  await main.evaluate("window.__TAURI__.event.emit('qchat://selection','Private native quote')");
  await waitFor(()=>main.evaluate("!!document.querySelector('#attachments .selection-chip')"),'temporary native quote');
  const privateLatest='Newer temporary native secret';
  await choose('gemini',"const input=document.getElementById('prompt-input');input.value="+JSON.stringify(privateLatest)+";input.dispatchEvent(new Event('input'));input.setSelectionRange(1,4,'backward');");
  check('native provider change preserves temporary mode and latest draft',await main.evaluate("document.getElementById('prompt-input').value==="+JSON.stringify(privateLatest)+"&&document.querySelector('.mode-chips').textContent.includes('Temporary')&&!!document.querySelector('#attachments .selection-chip')"));
  check('native temporary provider draft and quote stay out of storage',await main.evaluate("(()=>{const saved=localStorage.getItem('qchat.chats')||'';return !saved.includes('temporary native secret')&&!saved.includes('Temporary native secret')&&!saved.includes('Private native quote')})()"));
  await choose('chatgpt',"window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));");
  check('native New chat during a provider change clears temporary mode and secrets',await main.evaluate("document.getElementById('prompt-input').value===''&&!document.querySelector('#attachments .selection-chip')&&!document.querySelector('.mode-chips').textContent.includes('Temporary')"));
  check('native provider-draft tests send no provider messages',(await Promise.all(stubs.map(client=>client.evaluate('window.__providerDraftSends===0')))).every(Boolean));
  check('native provider-draft preservation has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-provider-draft-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
