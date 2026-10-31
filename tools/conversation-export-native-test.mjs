// Real UTF-8 Downloads writes in an owned, hidden WebView2 test profile only.
// No account messages, OS input, real clipboard writes or user Downloads access.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-export-native-'));
const downloads=path.join(profile,'Downloads');
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const app=spawn(exe,[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_TEST_SHOW_SETTINGS:'0',QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
let launchError;app.on('error',error=>{launchError=error});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clients=[],problems=[];
let failed=0,main;
const check=(label,ok,detail='')=>{console.log(`${ok?'PASS':'FAIL'} ${label}${!ok&&detail?' :: '+detail:''}`);if(!ok)failed++};
const pages=async()=>{try{return await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(700)})).json()}catch{return[]}};
async function waitFor(fn,label){for(let i=0;i<100;i++){const value=await fn();if(value)return value;if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Isolated app exited');await sleep(70)}throw Error('Timed out: '+label)}
function ownsEndpoint(){
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0&&result.stdout.trim()==='owned';
}
async function connect(page){
  const ws=new WebSocket(page.webSocketDebuggerUrl),pending=new Map();let serial=0;
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id)}else if(message.method==='Runtime.exceptionThrown')problems.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text)};
  ws.onclose=()=>{for(const done of pending.values())done({error:{message:'CDP closed'}});pending.clear()};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},15000);pending.set(id,result=>{clearTimeout(timer);result.error?reject(Error(result.error.message)):resolve(result.result)});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
  const client={ws,send,evaluate};clients.push(client);await send('Runtime.enable');return client;
}
try{
  const target=await waitFor(async()=>(await pages()).find(page=>page.url.includes('tauri.localhost')&&!page.url.includes('settings')),'main target');
  if(!ownsEndpoint())throw Error('Debug endpoint is not owned by the spawned isolated app');
  main=await connect(target);await main.send('Page.enable');
  await waitFor(()=>main.evaluate("document.readyState==='complete'&&!!window.QSettings"),'main ready');
  const invoke=(args)=>main.evaluate(`window.__TAURI__.core.invoke('conversation_export',${JSON.stringify(args)})`);
  const rejected=expression=>main.evaluate(`${expression}.then(()=>false,()=>true)`);
  check('native rejects empty and over-limit export content',await rejected(`window.__TAURI__.core.invoke('conversation_export',${JSON.stringify({title:'Invalid',markdown:'  \n'})})`)&&await rejected("window.__TAURI__.core.invoke('conversation_export',{title:'Invalid',markdown:'é'.repeat(2*1024*1024+1)})"));
  check('invalid exports create no Downloads directory',await readdir(downloads).then(()=>false,error=>error.code==='ENOENT'));

  const text='Kia ora 🦊\n\n```js\nconst café = 42;\n```';
  const seed={key:'native-export',provider:'chatgpt',title:'Native export 🦊',lastPrompt:'Native question',lastResponse:text,draft:'Unsent private draft',createdAt:Date.now(),lastActive:Date.now(),transcript:[{id:'native-u',role:'user',text:'Native question',selectionTexts:['Quoted context']},{id:'native-a',role:'assistant',text}]};
  await main.evaluate(`QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0,keepHistory:true});localStorage.setItem('qchat.chats',${JSON.stringify(JSON.stringify({v:1,current:seed,recent:[]}))})`);
  await main.send('Page.reload');await waitFor(()=>main.evaluate("document.getElementById('prompt-input')?.value==='Unsent private draft'"),'saved fixture');
  await main.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.exportCopied=text}}});window.exportOriginalExec=document.execCommand;document.execCommand=function(command,...args){return command==='copy'?false:exportOriginalExec.call(document,command,...args)}");
  const palette=async name=>{await main.evaluate("document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}))");await main.evaluate(`document.querySelector('#slash-menu [data-command=${name}]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`)};
  await palette('copy');await waitFor(()=>main.evaluate("typeof window.exportCopied==='string'"),'clipboard stub');
  const expected=await main.evaluate('window.exportCopied');
  await main.evaluate("(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['private staged bytes'],'keep.txt'));const input=document.getElementById('attachment-input');input.files=transfer.files;input.dispatchEvent(new Event('change'));const prompt=document.getElementById('prompt-input');prompt.focus();prompt.setSelectionRange(2,7)})()");
  await waitFor(()=>main.evaluate("document.querySelector('#attachments .attachment-chip[data-state=ready]')?.textContent.includes('keep.txt')"),'staged attachment');
  await palette('export');
  await waitFor(()=>main.evaluate("document.getElementById('command-feedback').textContent.includes('to Downloads')"),'export feedback');
  const names=await readdir(downloads),first=names[0];
  const bytes=await readFile(path.join(downloads,first));
  check('native UI export writes exact Copy Markdown in UTF-8',names.length===1&&bytes.equals(Buffer.from(expected,'utf8'))&&expected.includes('🦊')&&expected.includes('Quoted context'));
  check('native export keeps the Unicode title in a Markdown filename',first==='QChat - Native export 🦊.md');
  check('native export preserves the unsent draft, caret and staged file',await main.evaluate("(()=>{const input=document.getElementById('prompt-input');return input.value==='Unsent private draft'&&input.selectionStart===2&&input.selectionEnd===7&&document.getElementById('attachments').textContent.includes('keep.txt')})()")&&!expected.includes('Unsent private draft')&&!expected.includes('private staged bytes'));
  const duplicates=await main.evaluate("Promise.all(Array.from({length:4},()=>window.__TAURI__.core.invoke('conversation_export',{title:'Native export 🦊',markdown:'Concurrent export'})))");
  check('native concurrent exports use unique names and preserve the original',new Set(duplicates).size===4&&!duplicates.includes(first)&&(await readFile(path.join(downloads,first))).equals(bytes));
  const unsafe=await invoke({title:'../../CON:*?<>|\u0000"\\',markdown:'Safe filename'});
  check('native export confines unsafe titles to a Markdown basename',path.basename(unsafe)===unsafe&&path.extname(unsafe)==='.md'&&!/[<>:"/\\|?*\x00-\x1f]/.test(unsafe)&&(await readFile(path.join(downloads,unsafe),'utf8'))==='Safe filename');
  const plain=await invoke({title:'Safe\u0085\u00ad\u061c\u200b\u200f\u202e\u202c\u2060\u2061\u2062\u2063\u2064\u2066\u2069\ufeffname',markdown:'Readable filename'});
  check('native export strips hidden controls and bidi filename overrides',plain==='QChat - Safename.md');
  const capped=await invoke({title:'猫'.repeat(81),markdown:'Bounded title'});
  check('native export bounds Unicode title length',capped===`QChat - ${'猫'.repeat(80)}.md`);
  const boundary=await main.evaluate("window.__TAURI__.core.invoke('conversation_export',{title:'Byte boundary',markdown:'é'.repeat(2*1024*1024)})");
  check('native export accepts the exact four MiB UTF-8 boundary',(await readFile(path.join(downloads,boundary))).length===4*1024*1024);

  await main.evaluate("window.__TAURI__.event.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,barWidth:340,replyWidth:340}))");
  await waitFor(()=>main.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bar-w').trim()==='340px'"),'minimum bar width');await palette('rename');
  await waitFor(()=>main.evaluate("!document.getElementById('rename-chat').hidden"),'rename fixture');
  await main.evaluate("(()=>{const input=document.getElementById('rename-chat-input');input.value='W'.repeat(40);input.dispatchEvent(new Event('input'));document.querySelector('#rename-chat button[type=submit]').click()})()");
  await palette('export');await waitFor(()=>main.evaluate("document.getElementById('command-feedback').textContent.includes('W'.repeat(40))"),'long filename feedback');await sleep(100);
  const feedback=await main.evaluate("(()=>{const note=document.getElementById('command-feedback'),box=note.getBoundingClientRect();return {left:box.left,right:box.right,width:box.width,height:box.height,scroll:note.scrollWidth,client:note.clientWidth,viewport:innerWidth}})()");
  check('native long filename feedback fits the narrow bar and its pill',feedback.width<=342&&feedback.left>=0&&feedback.right<=feedback.viewport+1&&feedback.scroll<=feedback.client+2,JSON.stringify(feedback));
  const shots=path.join(root,'.tmp','export-shots');await mkdir(shots,{recursive:true});await writeFile(path.join(shots,'native-export-narrow.png'),Buffer.from((await main.send('Page.captureScreenshot',{format:'png'})).data,'base64'));

  const savedDownloads=path.join(profile,'Downloads-saved');
  await rename(downloads,savedDownloads);await writeFile(downloads,'Owned failure fixture');
  try{
    await palette('export');await waitFor(()=>main.evaluate("document.getElementById('command-feedback').textContent.includes(\"Couldn't save conversation\")"),'save error');
    check('native write failure gives honest feedback and leaves the blocking file intact',(await readFile(downloads,'utf8'))==='Owned failure fixture'&&await main.evaluate("document.getElementById('prompt-input').value==='Unsent private draft'"));
  }finally{await rm(downloads);await rename(savedDownloads,downloads)}
  const countBefore=(await readdir(downloads)).length;await palette('export');
  await waitFor(async()=>(await readdir(downloads)).length===countBefore+1,'export after failure');
  await waitFor(()=>main.evaluate("document.getElementById('command-feedback').textContent.includes('to Downloads')"),'retry success feedback');
  check('native export can retry after a write failure',await main.evaluate("document.getElementById('command-feedback').textContent.includes('to Downloads')"));

  const uploadRoot=path.join(profile,'qchat-cache','media-session','uploads');
  const originalIds=await readdir(uploadRoot),originalPath=path.join(uploadRoot,originalIds[0],'keep.txt');
  const clearChats=async()=>{await palette('clear');await waitFor(()=>main.evaluate("!document.getElementById('clear-confirm').hidden"),'clear confirmation');await main.evaluate("document.getElementById('btn-clear-yes').click()");await waitFor(()=>main.evaluate("!!document.querySelector('#command-feedback button')"),'Undo offer')};
  const undo=async()=>{await main.evaluate("document.querySelector('#command-feedback button').click()");await sleep(100)};
  await clearChats();await undo();
  check('native clear Undo restores the chat and exact staged bytes',await main.evaluate("JSON.parse(localStorage.getItem('qchat.chats')).current.key==='native-export'&&document.getElementById('prompt-input').value==='Unsent private draft'&&document.querySelector('#attachments [data-state=ready]')?.textContent.includes('keep.txt')")&&(await readFile(originalPath,'utf8'))==='private staged bytes');
  await clearChats();
  await main.evaluate("document.querySelector('#attachments .attachment-chip:not(.selection-chip) button').click()");
  await waitFor(async()=>readFile(originalPath).then(()=>false,error=>error.code==='ENOENT'),'original native file removed');
  await main.evaluate("(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['Replacement draft bytes'],'replacement.txt'));const input=document.getElementById('attachment-input');input.files=transfer.files;input.dispatchEvent(new Event('change'))})()");
  await waitFor(()=>main.evaluate("document.querySelector('#attachments .attachment-chip[data-state=ready]')?.textContent.includes('replacement.txt')"),'replacement file ready');
  await undo();
  const replacementIds=(await readdir(uploadRoot)).filter(id=>!originalIds.includes(id));
  check('native clear Undo preserves a same-count replacement draft',await main.evaluate("(()=>{const chats=JSON.parse(localStorage.getItem('qchat.chats'));return chats.current.key!=='native-export'&&chats.recent.some(chat=>chat.key==='native-export')&&document.getElementById('attachments').textContent.includes('replacement.txt')})()")&&replacementIds.length===1&&(await readFile(path.join(uploadRoot,replacementIds[0],'replacement.txt'),'utf8'))==='Replacement draft bytes');

  await main.evaluate("window.__TAURI__.core.invoke('open_settings')");
  const settingsTarget=await waitFor(async()=>(await pages()).find(page=>page.url.includes('settings.html')),'offscreen settings');
  const settings=await connect(settingsTarget);
  await waitFor(()=>settings.evaluate("!!window.__TAURI__?.core"),'settings IPC');
  check('Settings cannot invoke the native conversation writer',await settings.evaluate("window.__TAURI__.core.invoke('conversation_export',{title:'Denied',markdown:'Must not save'}).then(()=>false,()=>true)"));
  const providerTarget=await waitFor(async()=>(await pages()).find(page=>page.url.startsWith('https://chatgpt.com/')),'provider target');
  const provider=await connect(providerTarget);
  await waitFor(()=>provider.evaluate("!!window.__TAURI_INTERNALS__?.invoke"),'provider IPC');
  check('provider WebView cannot invoke the native conversation writer',await provider.evaluate("window.__TAURI_INTERNALS__.invoke('conversation_export',{title:'Denied',markdown:'Must not save'}).then(()=>false,()=>true)"));
  check('denied WebViews create no export files',!(await readdir(downloads)).some(name=>name.includes('Denied')));
  check('native export has no runtime exceptions',problems.length===0,problems.join(' | '));
}catch(error){console.error('FAIL harness ::',error.message);failed++}
finally{
  if(main?.ws.readyState===WebSocket.OPEN)void main.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  for(const client of clients)client.ws.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-export-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
