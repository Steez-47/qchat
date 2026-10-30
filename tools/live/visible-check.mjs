// Shows the real window in an isolated guest profile and screenshots the desktop to .tmp/live. Visible: check the foreground window first. No OS input.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = await mkdtemp(path.join(tmpdir(),'qchat-visible-'));
const port = 9400 + Math.floor(Math.random()*400);
const app = spawn(exe,[],{env:{...process.env,QCHAT_DEBUG_PORT:String(port),QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_TEST_SHOW_MAIN:'1'},stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let ws; let id=0; const pend=new Map();
const ev=(expr)=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:expr,awaitPromise:true,returnByValue:true}}));});
const shot=(name)=>spawnSync('powershell',['-NoProfile','-File','tools/live/grab.ps1',name],{encoding:'utf8'}).stdout.trim();
try{
  let page; for(let i=0;i<150&&!page;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();page=l.find(p=>p.url.includes('index.html')||p.url.includes('tauri.localhost'));}catch{} await sleep(200);}
  ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(Error(m.error.message)):p.res(m.result.result?.value);}};
  await sleep(3000);
  const add=`(()=>{const z=document.getElementById('bubble-zone');z.hidden=false;const d=document.createElement('div');d.className='bubble glass';d.style.cssText='padding:14px 18px;margin-bottom:8px';d.innerHTML='<b>Real desktop blur check.</b> This bubble frosts whatever is behind it, with soft corners and no hard edge. <code>code</code> <a href="#">link</a>';z.append(d);const i=document.getElementById('prompt-input');i.value='Testing real glass over my desktop';i.dispatchEvent(new Event('input',{bubbles:true}));})()`;
  await ev(add); await sleep(1200);
  console.log('winrect',await ev(`JSON.stringify({w:innerWidth,h:innerHeight,sx:screenX,sy:screenY,bg:getComputedStyle(document.body).backgroundColor,hbg:getComputedStyle(document.documentElement).backgroundColor,fill:getComputedStyle(document.getElementById('bar')).backgroundImage.slice(0,120)})`));
  console.log('debug',await ev(`window.__TAURI__.core.invoke('surfaces_debug').then(JSON.stringify)`));
  console.log("nodes",await ev(`JSON.stringify([...document.querySelectorAll("[data-surface], .glass")].map(n=>{const b=n.getBoundingClientRect();return [n.id||n.className.slice(0,24),n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height),getComputedStyle(n).pointerEvents]}))`));
  const dbg=JSON.parse(await ev(`window.__TAURI__.core.invoke('surfaces_debug').then(JSON.stringify)`));console.log(spawnSync('powershell',['-NoProfile','-File','tools/live/rgn.ps1',String(dbg.glassHwnd),String(dbg.mainHwnd)],{encoding:'utf8'}).stdout);console.log(shot(".tmp/live/on.png"));
  await ev(`window.QSurfaces.setBlur(false,0)`); await sleep(800);
  console.log(shot('.tmp/live/off.png'));
} finally { spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); await sleep(800); await rm(profile,{recursive:true,force:true}).catch(()=>{}); }
