// Hidden native unsent-chat rename checks using scoped CDP keys.
// Provider sends are stubbed; no OS keyboard or clipboard interaction.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-rename-draft-native-'));
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
  const providers=[];
  const stub=async provider=>{
    const domain=provider==='gemini'?'https://gemini.google.com/':'https://chatgpt.com/';
    const target=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith(domain)),'isolated '+provider);
    const client=await connect(target);await waitFor(()=>client.evaluate('!!window.__qchat'),'provider bridge');
    await client.evaluate('window.fixtureSends=[];window.fixtureSetups=[];window.fixtureTemporary=false;window.fixtureSetupId=null;window.fixtureStatus=()=>window.__QCHAT_EMIT__({type:"status",ready:true,loggedIn:false,temporary:fixtureTemporary,setupId:fixtureSetupId,url:location.href});window.__qchat.send=job=>{fixtureSends.push(job);};window.__qchat.newChat=(options={})=>{fixtureSetups.push(options);fixtureTemporary=!!options.temporary;fixtureSetupId=options.setupId||null;fixtureStatus();};window.__qchat.temporaryReady=()=>fixtureTemporary;window.__qchat.status=fixtureStatus;fixtureStatus();');
    providers.push(client);return client;
  };
  site=await stub('chatgpt');
  await main.evaluate('window.__TAURI__.core.invoke("provider_set",{provider:"gemini"})');await stub('gemini');
  await main.evaluate('window.__TAURI__.core.invoke("provider_set",{provider:"chatgpt"})');
  const settings=keepHistory=>main.evaluate('window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,barWidth:340,replyWidth:340,showTabs:true,keepHistory:'+keepHistory+'}))');
  await settings(true);
  const type=text=>main.evaluate('(()=>{const input=document.getElementById("prompt-input");input.value='+JSON.stringify(text)+';input.dispatchEvent(new Event("input"));input.focus();})()');
  const value=()=>main.evaluate('document.getElementById("prompt-input").value');
  const saved=()=>main.evaluate('JSON.parse(localStorage.getItem("qchat.chats")||"null")');
  const flush=()=>main.evaluate('window.dispatchEvent(new Event("pagehide"))');
  const key=async(key,code,virtualKey,modifiers=0)=>{
    await main.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
    await main.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,modifiers});
  };
  const command=async name=>{
    await main.evaluate('document.getElementById("prompt-input").focus()');await key('k','KeyK',75,2);
    const selector='#slash-'+name;
    await waitFor(()=>main.evaluate('!!document.querySelector('+JSON.stringify(selector)+')&&!document.querySelector('+JSON.stringify(selector)+').closest("[hidden]")'),'native '+name+' command');
    await main.evaluate('document.querySelector('+JSON.stringify(selector)+').dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
  };
  const renameVisible=()=>main.evaluate('!document.getElementById("rename-chat").hidden');
  const saveName=async name=>{await main.evaluate('document.getElementById("rename-chat-input").value='+JSON.stringify(name));await key('Enter','Enter',13);await waitFor(async()=>!await renameVisible(),'native rename save');};
  const setupCount=async()=>(await Promise.all(providers.map(client=>client.evaluate('fixtureSetups.length')))).reduce((total,count)=>total+count,0);
  const newChat=async(temporary=false)=>{
    const before=await setupCount();
    await main.evaluate('document.getElementById("prompt-input").focus()');await key('N','KeyN',78,temporary?10:2);
    await waitFor(async()=>(await setupCount())>before&&await value()===''&&await main.evaluate('document.getElementById("mode-chip").hidden===!'+temporary),'native New chat');
  };
  const choose=async provider=>{await command(provider);await waitFor(async()=>(await saved())?.current.provider===provider&&await main.evaluate('!document.getElementById("btn-reasoning").disabled'),'native provider change');};
  const draft='First native draft 🌏\nKeep this exact second line';
  await type(draft);await main.evaluate('document.getElementById("prompt-input").setSelectionRange(2,7,"backward")');
  await main.evaluate('window.__TAURI__.event.emit("qchat://selection","Keep the quoted context hidden")');await flush();
  await command('rename');
  check('native Rename accepts a pristine unsent draft',await renameVisible());
  if(!await renameVisible())throw Error('Rename still refuses an unsent draft; remaining checks require eligibility');
  check('native Rename prefills the draft preview without quoted context',await main.evaluate('document.getElementById("rename-chat-input").value==="First native draft 🌏"'));
  const shotDirectory=path.join(root,'.tmp','rename-draft-shots');await mkdir(shotDirectory,{recursive:true});await writeFile(path.join(shotDirectory,'native-rename-draft-340.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await saveName('Local unsent idea 🦊');await flush();let snapshot=await saved();const original=snapshot.current.key;
  check('native Rename stores the local name without changing draft or quote',snapshot.current.title==='Local unsent idea 🦊'&&await value()===draft&&await main.evaluate('document.querySelectorAll("#attachments .selection-chip").length===1'));
  check('native Rename keeps the draft selection range',await main.evaluate('(()=>{const input=document.getElementById("prompt-input");return input.selectionStart===2&&input.selectionEnd===7&&input.selectionDirection==="backward";})()'));
  await command('rename');await main.evaluate('document.getElementById("rename-chat-input").value="Discarded rename"');await key('Escape','Escape',27);
  check('native cancelling an unsent rename keeps name and exact text',(await saved()).current.title==='Local unsent idea 🦊'&&await value()===draft);
  await command('rename');await main.evaluate('document.getElementById("rename-chat-input").value="   "');await key('Enter','Enter',13);
  check('native empty-name validation keeps the unsent name and form',await renameVisible()&&(await saved()).current.title==='Local unsent idea 🦊'&&await main.evaluate('document.getElementById("rename-chat-input").getAttribute("aria-invalid")==="true"'));
  await key('Escape','Escape',27);await newChat();snapshot=await saved();
  check('native named unsent work survives New chat',snapshot.recent.some(chat=>chat.key===original&&chat.title==='Local unsent idea 🦊'&&chat.draft===draft));
  await main.evaluate('document.querySelector(\'#tabs .tab[data-key="'+original+'"]\').click()');await waitFor(async()=>(await saved()).current.key===original,'named draft restore');
  await main.send('Page.reload');await waitFor(()=>main.evaluate('document.readyState==="complete"&&!!window.QSettings&&document.getElementById("prompt-input").value==='+JSON.stringify(draft)),'named draft reload');
  check('native named draft reload restores name, text and context',(await saved()).current.title==='Local unsent idea 🦊'&&await value()===draft&&await main.evaluate('!!document.querySelector("#attachments .selection-chip")'));
  await choose('gemini');snapshot=await saved();
  check('native unsent name follows draft and quote across provider changes',snapshot.current.title==='Local unsent idea 🦊'&&snapshot.current.draft===draft&&snapshot.current.selectionTexts?.length===1&&[snapshot.current,...snapshot.recent].filter(chat=>chat.draft===draft).length===1);
  await main.evaluate('(()=>{const data=JSON.parse(localStorage.getItem("qchat.chats"));Object.assign(data.current,{title:"Existing conversation name",lastPrompt:"Earlier sent question",lastResponse:"Earlier sent answer",draft:"A new draft to move",selectionTexts:[],transcript:[{id:"fixture-user",role:"user",text:"Earlier sent question"},{id:"fixture-assistant",role:"assistant",text:"Earlier sent answer"}]});localStorage.setItem("qchat.chats",JSON.stringify(data));})()');
  await main.send('Page.reload');await waitFor(()=>main.evaluate('document.readyState==="complete"&&document.getElementById("prompt-input").value==="A new draft to move"'),'native transcript fixture reload');
  await choose('chatgpt');snapshot=await saved();
  check('native existing conversation name stays on its original transcript',!snapshot.current.title&&snapshot.current.draft==='A new draft to move'&&snapshot.recent.some(chat=>chat.title==='Existing conversation name'&&!chat.draft&&chat.transcript.length===2));
  await newChat(true);const secret='NEVER-SAVE-renamed-temporary-draft';await type(secret);await command('rename');await waitFor(renameVisible,'private draft rename');await saveName('NEVER-SAVE-temporary-name');await flush();
  check('native Temporary rename keeps its name and draft out of storage',!JSON.stringify(await saved()).includes(secret)&&!JSON.stringify(await saved()).includes('NEVER-SAVE-temporary-name'));
  await newChat();await main.evaluate('window.__TAURI__.event.emit("qchat://selection","Do not reveal this quote as a name")');await command('rename');await waitFor(renameVisible,'quote-only rename');
  check('native quote-only rename does not expose quote text as its default name',await main.evaluate('document.getElementById("rename-chat-input").value==="Untitled chat"'));
  await saveName('Quoted idea');check('native quote-only Rename leaves the composer empty',await value()===''&&(await saved()).current.title==='Quoted idea');
  await newChat();await command('rename');check('native truly empty chat still refuses Rename',!await renameVisible());
  await type(' \n  ');await command('rename');check('native whitespace-only chat still refuses Rename',!await renameVisible());
  await newChat();await main.evaluate('(()=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0,128,255,4])],"unnamed-native-file.bin",{type:"application/octet-stream"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');await waitFor(()=>main.evaluate('!!document.querySelector("#attachments [data-state=ready]")'),'native file-only fixture');
  await command('rename');check('native file-only chat still refuses Rename and retains staged bytes',!await renameVisible()&&(await uploads()).length===1);
  await newChat();await waitFor(async()=>(await uploads()).length===0,'native file-only cleanup');
  await newChat();await settings(false);await waitFor(()=>main.evaluate('localStorage.getItem("qchat.chats")===null'),'native history-off');await type('NEVER-SAVE-history-off-draft');await command('rename');await waitFor(renameVisible,'history-off rename');await saveName('NEVER-SAVE-history-off-name');await flush();
  check('native history-disabled Rename stores neither name nor draft',await main.evaluate('localStorage.getItem("qchat.chats")===null'));
  await newChat();await settings(true);await flush();
  check('native re-enabling history cannot resurrect excluded names',!JSON.stringify(await saved()).includes('NEVER-SAVE'));
  check('native unsent Rename sends no provider messages',(await Promise.all(providers.map(client=>client.evaluate('fixtureSends.length')))).every(count=>count===0));
  check('native unsent Rename has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-rename-draft-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
