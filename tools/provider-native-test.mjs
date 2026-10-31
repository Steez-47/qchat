// End-to-end check of the real QChat app, driven over WebView2 CDP. No windows are shown.
// Usage: node tools/app-e2e.mjs   (needs `cargo build` first; uses the debug exe)
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const port = 9347;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let n = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const ready = new Promise(r => (ws.onopen = r));
  const evaluate = async expr => {
    const id = ++n;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await new Promise(r => pend.set(id, r));
    return d.result?.result?.value;
  };
  return { ready, evaluate, close: () => ws.close() };
}


const runKey = () => spawnSync('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','QChat'],{encoding:'utf8',windowsHide:true}).stdout;
const before=runKey();
let failed=0;
const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++;};
for(const autostart of [false,true]) {
 const profile=mkdtempSync(path.join(tmpdir(),'qchat-provider-'));
 const app=spawn(exe,autostart?['--autostart']:[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_DEBUG_PORT:String(port)},stdio:'ignore',windowsHide:true});
 let ui;
 try {
  let list=[];
  for(let i=0;i<80;i++){try{list=await(await fetch(`http://127.0.0.1:${port}/json`)).json();}catch{} if(list.some(p=>p.url.includes('tauri.localhost')))break;await sleep(500);}
  ui=cdp(list.find(p=>p.url.includes('tauri.localhost')).webSocketDebuggerUrl);await ui.ready;
  const invoke=(command,args={})=>ui.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}))`);
  for(let i=0;i<60;i++){if(await ui.evaluate(`typeof window.__TAURI__?.core?.invoke === 'function'`))break;await sleep(100);}
  check(`launch_info ${autostart}`,(await invoke('launch_info')).value?.autostart===autostart);
  check('Gemini initially lazy',!list.some(p=>p.url.includes('gemini.google.com')));
  check('default provider',(await invoke('provider_get')).value==='chatgpt');
  const switched=await ui.evaluate(`Promise.all([1,2].map(()=>window.__TAURI__.core.invoke('provider_set',{provider:'gemini'}))).then(()=>true,()=>false)`);
  check('concurrent provider_set',switched);
  for(let i=0;i<60;i++){list=await(await fetch(`http://127.0.0.1:${port}/json`)).json();if(list.some(p=>p.url.startsWith('https://gemini.google.com/')))break;await sleep(500);}
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
