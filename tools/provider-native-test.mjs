// End-to-end check of the real QChat app, driven over WebView2 CDP. No windows are shown.
// Usage: node tools/provider-native-test.mjs (needs `cargo build` first).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reservePort() {
  const listener = createServer();
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const port = listener.address().port;
  await new Promise((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  return port;
}
function ownsEndpoint(app, port) {
  if (!app.pid) return false;
  const script = `$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result = spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0 && result.stdout.trim()==='owned';
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let n = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  ws.onclose = () => {for(const done of pend.values())done({error:{message:'CDP closed'}});pend.clear();};
  const ready = new Promise((resolve,reject) => {ws.onopen=resolve;ws.onerror=reject;});
  const evaluate = async expr => {
    const id = ++n;
    const d = await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{pend.delete(id);reject(Error('CDP evaluation timed out'));},15000);
      pend.set(id,result=>{clearTimeout(timer);resolve(result);});
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });
    if(d.error)throw Error(d.error.message);
    if(d.result?.exceptionDetails)throw Error(d.result.exceptionDetails.exception?.description||d.result.exceptionDetails.text);
    return d.result.result.value;
  };
  return { ready, evaluate, close: () => ws.close() };
}


const runKey = () => spawnSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','QChat'],{encoding:'utf8',windowsHide:true}).stdout;
const before=runKey();
let failed=0;
const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;};
for(const autostart of [false,true]) {
 const port=await reservePort();
 const profile=mkdtempSync(path.join(tmpdir(),'qchat-provider-'));
 const app=spawn(exe,autostart?['--autostart']:[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
 let launchError;app.on('error',error=>{launchError=error;});
 let ui;
 try {
  let list=[];
  for(let i=0;i<80;i++){if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Isolated app exited');try{list=await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1000)})).json();}catch{} if(list.some(p=>p.url.includes('tauri.localhost')))break;await sleep(500);}
  const target=list.find(p=>p.url.includes('tauri.localhost')&&!p.url.includes('settings'));
  if(!target)throw Error('Isolated main target did not start');
  if(!ownsEndpoint(app,port))throw Error('Debug endpoint is not owned by the isolated test app');
  ui=cdp(target.webSocketDebuggerUrl);await ui.ready;
  const invoke=(command,args={})=>ui.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))`);
  for(let i=0;i<60;i++){if(await ui.evaluate(`typeof window.__TAURI__?.core?.invoke === 'function'`))break;await sleep(100);}
  check(`launch_info ${autostart}`,(await invoke('launch_info')).value?.autostart===autostart);
  check('Gemini initially lazy',!list.some(p=>p.url.includes('gemini.google.com')));
  check('default provider',(await invoke('provider_get')).value==='chatgpt');
  const switched=await ui.evaluate(`Promise.all([1,2].map(()=>window.__TAURI__.core.invoke('provider_set',{provider:'gemini'}))).then(()=>true,()=>false)`);
  check('concurrent provider_set',switched);
  for(let i=0;i<60;i++){list=await(await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(1000)})).json();if(list.some(p=>p.url.startsWith('https://gemini.google.com/')))break;await sleep(500);}
  check('one Gemini target',list.filter(p=>p.url.startsWith('https://gemini.google.com/')).length===1);
  check('provider_get',(await invoke('provider_get')).value==='gemini');
  check('invalid provider rejected',(await invoke('provider_set',{provider:'bogus'})).error?.includes('invalid_provider'));
  check('provider mismatch rejected',(await invoke('chat_send',{id:'test',prompt:'test',provider:'chatgpt'})).error?.includes('provider_mismatch'));
  await invoke('set_autostart',{enabled:true});check('test autostart on',(await invoke('get_autostart')).value===true);
  await invoke('set_autostart',{enabled:false});check('test autostart off',(await invoke('get_autostart')).value===false);
 }catch(e){check(e.stack,false);}finally{
  ui?.close();
  if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  if(path.dirname(path.resolve(profile))===path.resolve(tmpdir())&&path.basename(profile).startsWith('qchat-provider-'))try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
}
check('real Run value unchanged',before===runKey());
process.exit(failed?1:0);
