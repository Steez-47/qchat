// Isolated native capture regression: only a synthetic, nonactivating fixture is captured.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedExe = path.join(root, 'src-tauri/target-surfaces-test/debug/qchat.exe');
const testExe = process.env.QCHAT_SNAPSHOT_EXE || (existsSync(isolatedExe) ? isolatedExe : path.join(root, 'src-tauri/target/debug/qchat.exe'));
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-snapshot-'));
const port = 9357;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
const visible = process.argv.includes('--visible');
let app;
async function pages() {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return []; }
}
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(100); }
  throw Error(`Timed out: ${label}`);
}
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let serial = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  clients.push(ws);
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  return async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.exception?.value || result.exceptionDetails.text);
    return result.result?.value;
  };
}
function check(label, ok) { if (!ok) throw Error(label); console.log(`PASS ${label}`); }
let fixture;
try {
  if ((await pages()).length) throw Error('Test debug port already in use');
  const handleFile=path.join(profile,'handle.txt');
  const script=`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class SnapshotFixture : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
$f=New-Object SnapshotFixture
$f.FormBorderStyle='None'; $f.Size=New-Object System.Drawing.Size(160,100); $f.BackColor=[System.Drawing.Color]::FromArgb(17,91,203)
$f.ShowInTaskbar=$false; $f.StartPosition='Manual'; $f.Location=New-Object System.Drawing.Point(-3000,100)
$f.Add_Shown({[System.IO.File]::WriteAllText('${handleFile.replaceAll("'","''")}', $f.Handle.ToInt64().ToString())})
[System.Windows.Forms.Application]::Run($f)`;
  fixture=spawn('powershell.exe',['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore',windowsHide:true});
  await until(()=>existsSync(handleFile),'fixture handle');
  const hwnd=readFileSync(handleFile,'utf8').trim();
  app=spawn(testExe,[],{env:{...process.env,QCHAT_DEBUG_PORT:String(port),QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_TEST_SNAPSHOT_HWND:hwnd},stdio:'ignore',windowsHide:true});
  const main=await until(async()=>(await pages()).find(p=>p.url.includes('tauri.localhost')&&!p.url.includes('settings.html')),'main');
  const evaluate=await connect(main);
  await until(()=>evaluate(`!!window.__TAURI__?.core`),'main IPC ready');
  // The fixture reports its handle before its first paint, so only that blank capture is retried.
  let result;
  for (let attempt=0;;attempt++) {
    try { result=await evaluate(`window.__TAURI__.core.invoke('snapshot_capture')`); break; }
    catch (error) { if (attempt>=20 || !/blank or protected/.test(error.message)) throw error; await new Promise(r=>setTimeout(r,150)); }
  }
  check('PNG contract',result.mime==='image/png'&&result.name.endsWith('.png'));
  const png=Buffer.from(result.data,'base64');
  check('PNG dimensions',png.readUInt32BE(16)===160&&png.readUInt32BE(20)===100);
  // Decode in the webview so this harness needs no additional PNG dependency.
  check('synthetic colors',await evaluate(`(async()=>{const im=new Image();im.src='data:image/png;base64,${result.data}';await im.decode();const c=document.createElement('canvas');c.width=160;c.height=100;const x=c.getContext('2d');x.drawImage(im,0,0);const p=x.getImageData(80,50,1,1).data;return p[0]===17&&p[1]===91&&p[2]===203&&p[3]===255})()`));
  await until(()=>evaluate(`!!document.getElementById('btn-snapshot')`),'camera button');
  await evaluate(`(()=>{const i=document.getElementById('prompt-input');i.value='Keep this draft';i.dispatchEvent(new Event('input'));document.getElementById('btn-snapshot').click()})()`);
  await until(()=>evaluate(`document.querySelector('#attachments .attachment-chip')?.dataset.state==='ready' && document.querySelector('#attachments img')?.naturalWidth===160`),'native snapshot staged by camera');
  check('camera stages real capture and preserves draft',await evaluate(`document.getElementById('prompt-input').value==='Keep this draft' && document.querySelector('#attachments img').naturalHeight===100`));
  await evaluate(`document.querySelector('#attachments button[aria-label="Remove Snapshot.png"]').click()`);
  await until(()=>evaluate(`document.getElementById('attachments').hidden`),'native snapshot removed');
  check('native camera attachment is removable',true);
  spawnSync('taskkill.exe',['/PID',String(fixture.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  check('closed target fails',await evaluate(`window.__TAURI__.core.invoke('snapshot_capture').then(()=>false,()=>true)`));
  await evaluate(`window.__TAURI__.core.invoke('open_settings')`);
  const settings=await connect(await until(async()=>(await pages()).find(p=>p.url.includes('settings.html')),'settings'));
  await until(()=>settings(`!!window.__TAURI__?.core`),'settings IPC ready');
  check('settings denied',await settings(`window.__TAURI__.core.invoke('snapshot_capture').then(()=>false,()=>true)`));
  for(const ws of clients) ws.close();
  spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  await until(async()=>(await pages()).length===0,'test shutdown');
  app=spawn(testExe,[],{env:{...process.env,QCHAT_DEBUG_PORT:String(port),QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:profile,QCHAT_TEST_SNAPSHOT_HWND:'self'},stdio:'ignore',windowsHide:true});
  const selfPage=await until(async()=>(await pages()).find(p=>p.url.includes('tauri.localhost')&&!p.url.includes('settings.html')),'self exclusion instance');
  const selfEval=await connect(selfPage);
  await until(()=>selfEval(`!!window.__TAURI__?.core`),'self IPC ready');
  check('QChat target rejected',await selfEval(`window.__TAURI__.core.invoke('snapshot_capture').then(()=>false,()=>true)`));
  console.log('ALL PASS');
} catch(error) { console.error('FAIL '+error.message);process.exitCode=1; }
finally {
  for(const ws of clients) ws.close();
  for(const child of [app,fixture]) if(child?.pid&&child.exitCode===null) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-snapshot-')) {
    try { rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200}); } catch {}
  }
}
