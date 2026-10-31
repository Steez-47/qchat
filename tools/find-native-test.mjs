// Real hidden WebView2 search and prompt-edit checks. Isolated profile only; no
// account messages, OS input or clipboard access.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=process.env.QCHAT_SURFACES_EXE||path.join(root,'src-tauri','target','debug','qchat.exe');
const profile=await mkdtemp(path.join(tmpdir(),'qchat-find-native-'));
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const app=spawn(exe,[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
let launchError;
app.on('error',error=>{launchError=error;});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,failed=0,serial=0;
const pending=new Map(),problems=[];
const check=(label,ok,detail='')=>{console.log(`${ok?'PASS':'FAIL'} ${label}${!ok&&detail?' :: '+detail:''}`);if(!ok)failed++;};
async function command(method,params={}) {
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},10000);
    pending.set(id,message=>{clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for(let i=0;i<100;i++){if(await evaluate(`!!(${expression})`))return;await sleep(50);}
  throw Error('Timed out: '+expression);
}
const key=(value,extra={})=>evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({key:value,bubbles:true,cancelable:true,...extra})}))`);
function ownsEndpoint() {
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess; for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0&&result.stdout.trim()==='owned';
}
try {
  let page;
  for(let i=0;i<100&&!page;i++) {
    if(launchError)throw launchError;
    if(app.exitCode!==null)throw Error('Test app exited early: '+app.exitCode);
    try {page=(await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(600)})).json()).find(item=>item.url.includes('tauri.localhost')&&!item.url.includes('settings'));}catch{}
    if(!page)await sleep(100);
  }
  if(!page)throw Error('Main WebView2 target did not appear');
  if(!ownsEndpoint())throw Error('Debug endpoint is not owned by the spawned isolated QChat; refusing to attach');
  ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);}else if(message.method==='Runtime.exceptionThrown')problems.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);};
  ws.onclose=()=>{for(const callback of pending.values())callback({error:{message:'CDP closed'}});pending.clear();};
  await command('Runtime.enable');await command('Page.enable');
  await until("document.readyState==='complete'&&window.QSettings&&document.getElementById('find-input')");
  const transcript=[{id:'native-u',role:'user',text:'Needle in a saved question.'},{id:'native-a',role:'assistant',text:'Older NEEDLE and hel**lo** world.\n\n```js\nconst value = 42;\n```'}];
  const chat={key:'find-native',provider:'chatgpt',title:'Native search fixture',lastActive:Date.now(),createdAt:Date.now(),lastPrompt:transcript[0].text,lastResponse:transcript[1].text,draft:'Preserve this draft 🌏',transcript};
  await evaluate(`QSettings.save({...QSettings.settings,animations:'off',autoDismiss:0,barWidth:340,look:'frost'});localStorage.setItem('qchat.chats',${JSON.stringify(JSON.stringify({v:1,current:chat,recent:[]}))});true`);
  await command('Page.reload');await until("document.getElementById('prompt-input')?.value==='Preserve this draft 🌏'");
  await evaluate("document.getElementById('prompt-input').focus()");await key('f',{ctrlKey:true});
  await until("!document.getElementById('find-bar').hidden");
  await evaluate("(()=>{const i=document.getElementById('find-input');i.value='needle';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until("document.getElementById('find-count').textContent.replace(/\\s/g,'')==='1/2'");
  check('native search finds older case-insensitive matches',await evaluate("!document.getElementById('history-panel').hidden&&document.activeElement.id==='find-input'"));
  check('installed WebView2 has custom find ranges',await evaluate("typeof Highlight==='function'&&CSS.highlights?.get('qchat-find')?.size===2&&CSS.highlights?.get('qchat-find-current')?.size===1"));
  check('native highlight styles provide visible backgrounds',await evaluate("['qchat-find','qchat-find-current'].every(name=>{const color=getComputedStyle(document.querySelector('#history-panel .turn-content'),'::highlight('+name+')').backgroundColor;return color&&color!=='transparent'&&color!=='rgba(0, 0, 0, 0)'})"));
  await key('Enter');
  check('native keyboard navigation advances',await evaluate("document.getElementById('find-count').textContent.replace(/\\s/g,'')==='2/2'"));
  await evaluate("(()=>{const i=document.getElementById('find-input');i.value='hello';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await until("document.getElementById('find-count').textContent.replace(/\\s/g,'')==='1/1'");
  check('native ranges span inline formatting',await evaluate("Array.from(CSS.highlights.get('qchat-find'))[0].toString()==='hello'&&document.querySelector('#history-panel strong').textContent==='lo'"));
  check('native compact search stays inside its viewport',await evaluate("(()=>{const b=document.getElementById('find-bar').getBoundingClientRect(),i=document.getElementById('find-input').getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&i.width>=70})()"));
  const shots=path.join(root,'.tmp','find-shots');await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'native-find.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await key('Escape');
  check('native Escape closes search and preserves draft',await evaluate("document.getElementById('find-bar').hidden&&getComputedStyle(document.getElementById('find-bar')).display==='none'&&document.getElementById('find-bar').getClientRects().length===0&&!CSS.highlights.has('qchat-find')&&!CSS.highlights.has('qchat-find-current')&&!document.getElementById('history-panel').hidden&&document.getElementById('prompt-input').value==='Preserve this draft 🌏'&&document.activeElement.id==='prompt-input'"));
  await evaluate("document.querySelector('#history-panel [data-id=\"native-u\"] [data-action=\"edit-prompt\"]').click()");
  check('native prompt edit loads text without sending',await evaluate("document.getElementById('prompt-input').value==='Needle in a saved question.'&&!document.querySelector('[data-status=streaming]')&&JSON.parse(localStorage.getItem('qchat.chats')).current.transcript.length===2"));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
  check('native keyboard undo recovers the exact previous draft',await evaluate("document.getElementById('prompt-input').value==='Preserve this draft 🌏'"));
  const kept=await evaluate("(()=>{const original=document.execCommand;document.execCommand=()=>false;try{document.querySelector('#history-panel [data-id=\"native-u\"] [data-action=\"edit-prompt\"]').click();return document.getElementById('prompt-input').value==='Preserve this draft 🌏'&&document.getElementById('command-feedback').textContent.includes(\"Couldn't replace your draft\")}finally{document.execCommand=original}})()");
  check('native failed undoable insertion keeps the existing draft',kept);
  await until("JSON.parse(localStorage.getItem('qchat.chats')).current.draft==='Preserve this draft 🌏'");
  await evaluate("window.nativeCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>nativeCopies.push(text)}});window.editCommand=document.execCommand;document.execCommand=function(command,...args){return command==='copy'?false:editCommand.call(document,command,...args)};getSelection().removeAllRanges();const input=document.getElementById('prompt-input');input.focus();input.setSelectionRange(input.value.length,input.value.length)");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'C',code:'KeyC',windowsVirtualKeyCode:67,modifiers:10});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'C',code:'KeyC',windowsVirtualKeyCode:67,modifiers:10});
  await until('nativeCopies.length===1');
  check('native keyboard reply copy routes to the clipboard stub',await evaluate("nativeCopies[0].includes('Older NEEDLE')&&nativeCopies[0].includes('const value = 42;')&&document.getElementById('prompt-input').value==='Preserve this draft 🌏'"));
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'X',code:'KeyX',windowsVirtualKeyCode:88,modifiers:10});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'X',code:'KeyX',windowsVirtualKeyCode:88,modifiers:10});
  await until('nativeCopies.length===2');
  check('native keyboard code copy selects only code',await evaluate("nativeCopies[1].trim()==='const value = 42;'&&document.getElementById('prompt-input').value==='Preserve this draft 🌏'"));
  check('native search has no runtime exceptions',problems.length===0,problems.join(' | '));
} catch(error) {console.error('FAIL harness ::',error.message);failed++;}
finally {
  if(ws?.readyState===WebSocket.OPEN)void evaluate("window.__TAURI__.core.invoke('quit_app')").catch(()=>{});
  for(let i=0;i<30&&app.exitCode===null;i++)await sleep(100);
  ws?.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await sleep(600);
  const resolved=path.resolve(profile);
  if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('qchat-find-native-'))await rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
}
console.log(failed?`${failed} FAILED`:'ALL PASS');process.exitCode=failed?1:0;
