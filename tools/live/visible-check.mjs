// Shows the real window in an isolated guest profile and screenshots the desktop to .tmp/live. Visible: check the foreground window first. No OS input.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = await mkdtemp(path.join(tmpdir(),'qchat-visible-'));
const port = 9400 + Math.floor(Math.random()*400);
// Non-activating test-owned panel: sharp text proves whether blur is real.
const backdropCode = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Windows.Forms;
public class BlurReference : Form {
 protected override bool ShowWithoutActivation { get { return true; } }
 protected override CreateParams CreateParams { get { var p=base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
 public BlurReference() {
  FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true;
  StartPosition=FormStartPosition.Manual; Bounds=new Rectangle(0,1080,640,360);
  BackColor=Color.FromArgb(220,224,230);
 }
 protected override void OnPaint(PaintEventArgs e) {
  base.OnPaint(e);
  for(int x=0;x<640;x+=80) using(var b=new SolidBrush((x/80)%2==0 ? Color.FromArgb(245,220,190) : Color.FromArgb(180,220,245))) e.Graphics.FillRectangle(b,x,0,80,360);
  using(var f=new Font("Consolas",12))
  for(int y=0;y<360;y+=22) e.Graphics.DrawString("DESKTOP 0123456789 | Sharp text behind glass ABCDEF", f, Brushes.Black, 0,y);
 }
}
'@
[System.Windows.Forms.Application]::Run((New-Object BlurReference))`;
const backdrop = spawn('powershell', ['-NoProfile','-EncodedCommand',Buffer.from(backdropCode,'utf16le').toString('base64')], {stdio:'ignore',windowsHide:true});
await new Promise(r=>setTimeout(r,1800));
const app = spawn(exe,[],{env:{...process.env,QCHAT_DEBUG_PORT:String(port),QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_TEST_SHOW_MAIN:'1'},stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let ws; let id=0; const pend=new Map();
const ev=(expr)=>new Promise((res,rej)=>{const i=++id;const timer=setTimeout(()=>{pend.delete(i);rej(Error("CDP evaluation timed out"))},15000);pend.set(i,{res,rej,timer});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:expr,awaitPromise:true,returnByValue:true}}));});
const shot=(name)=>spawnSync('powershell',['-NoProfile','-File','tools/live/grab.ps1',name],{encoding:'utf8'}).stdout.trim();
try{
  let page; for(let i=0;i<150&&!page;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();page=l.find(p=>p.url.includes('index.html')||p.url.includes('tauri.localhost'));}catch{} await sleep(200);}
  ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);clearTimeout(p.timer);m.error?p.rej(Error(m.error.message)):p.res(m.result.result?.value);}};
  await sleep(3000);
  const add=`(()=>{const z=document.getElementById('bubble-zone');z.hidden=false;const d=document.createElement('div');d.className='bubble glass';d.style.cssText='padding:14px 18px;margin-bottom:8px';d.innerHTML='<b>Real desktop blur check.</b> This bubble frosts whatever is behind it, with soft corners and no hard edge. <code>code</code> <a href="#">link</a>';z.append(d);const i=document.getElementById('prompt-input');i.value='Testing real glass over my desktop';i.dispatchEvent(new Event('input',{bubbles:true}));})()`;
  await ev(add); await ev(`window.QSurfaces.setBlur(true, 0x55121420)`); await sleep(1200);
  console.log('winrect',await ev(`JSON.stringify({w:innerWidth,h:innerHeight,sx:screenX,sy:screenY,bg:getComputedStyle(document.body).backgroundColor,hbg:getComputedStyle(document.documentElement).backgroundColor,fill:getComputedStyle(document.getElementById('bar')).backgroundImage.slice(0,120)})`));
  console.log('debug',await ev(`window.__TAURI__.core.invoke('surfaces_debug').then(JSON.stringify)`));
  console.log("nodes",await ev(`JSON.stringify([...document.querySelectorAll("[data-surface], .glass")].map(n=>{const b=n.getBoundingClientRect();return [n.id||n.className.slice(0,24),n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height),getComputedStyle(n).pointerEvents]}))`));
  const dbg=JSON.parse(await ev(`window.__TAURI__.core.invoke('surfaces_debug').then(JSON.stringify)`));console.log(spawnSync('powershell',['-NoProfile','-File','tools/live/rgn.ps1',String(dbg.glassHwnd),String(dbg.mainHwnd)],{encoding:'utf8'}).stdout);console.log(shot(".tmp/live/on.png"));
  await ev(`window.QSurfaces.setBlur(false,0)`); await sleep(800);
  console.log(shot('.tmp/live/off.png'));
  await writeFile('.tmp/live/geometry.json', JSON.stringify(await ev(`({x:screenX,y:screenY,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,rects:[...document.querySelectorAll('[data-surface], .glass, .thinking, button, textarea')].filter(n=>!n.closest('.preview')&&n.id!=='btn-send'&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&getComputedStyle(n).pointerEvents!=='none').map(n=>{const b=n.getBoundingClientRect();const raw=getComputedStyle(n).borderTopLeftRadius.split(' ')[0];const r=parseFloat(raw)*(raw.endsWith('%')?Math.min(b.width,b.height)/100:1);return {x:b.x,y:b.y,w:b.width,h:b.height,r:Math.min(r||0,b.width/2,b.height/2)}}).filter(r=>r.w&&r.h)})`),null,2));
  await ev(`window.QSurfaces.setBlur(true, 0x55121420)`); await sleep(800);
  // Exercise frequent geometry changes without OS input or another session.
  await ev(`new Promise(resolve=>{let n=0;const b=document.querySelector('.bubble');const timer=setInterval(()=>{b.append(document.createTextNode(' Streaming text.'));if(++n===24){clearInterval(timer);resolve()}},40)})`);
  await sleep(500);
  console.log('after streaming',await ev(`window.__TAURI__.core.invoke('surfaces_debug')`));
  console.log(shot('.tmp/live/streaming.png'));
  // Measure only this isolated process, never another running QChat.
  console.log('idle CPU', spawnSync('powershell',['-NoProfile','-Command',`$p=Get-Process -Id ${app.pid}; $a=$p.TotalProcessorTime.TotalSeconds; Start-Sleep -Seconds 5; $p.Refresh(); "core percent {0:N2}" -f (($p.TotalProcessorTime.TotalSeconds-$a)/5*100)`],{encoding:'utf8',windowsHide:true}).stdout.trim());
} finally { ws?.close(); spawnSync('taskkill.exe',['/PID',String(backdrop.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); await sleep(800); await rm(profile,{recursive:true,force:true}).catch(()=>{}); }
