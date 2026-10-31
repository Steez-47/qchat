// Real guest ChatGPT through QChat/WebView2. Hidden, isolated profile only.
// Usage: node tools/app-e2e.mjs (fresh cargo build first; sends harmless guest prompts).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.env.QCHAT_E2E_EXE || path.join(root, 'src-tauri', 'target', 'debug', 'qchat.exe');
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cdp(url) {
  const ws = new WebSocket(url), pending = new Map();
  let serial = 0;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('CDP connection timeout')), 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Error('CDP connection failed')); };
  });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  ws.onclose = () => { for (const callback of pending.values()) callback({ error: { message: 'CDP closed' } }); pending.clear(); };
  const call = async (method, params = {}) => {
    await ready;
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, message => { clearTimeout(timer); message.error ? reject(Error(message.error.message)) : resolve(message.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  return { ready, call, evaluate, close: () => ws.close() };
}

const profile = mkdtempSync(path.join(tmpdir(), 'qchat-e2e-'));
let app, ui, site, launchError, failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failed++; };
function ownsEndpoint() {
  const script = `$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess; for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return result.status === 0 && result.stdout.trim() === 'owned';
}
const lastTurn = `(()=>{const row=[...document.querySelectorAll('#bubble-zone [data-role=assistant]')].at(-1);return row?{id:row.dataset.id,txt:row.querySelector('.turn-content')?.innerText||'',html:row.querySelector('.turn-content')?.innerHTML||'',err:!!(row.querySelector('.turn-error')&&!row.querySelector('.turn-error').hidden),streaming:row.dataset.status==='streaming'}:null})()`;
async function until(expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await ui.evaluate(`!!(${expression})`)) return; await sleep(100); }
  throw Error('Timed out: ' + expression);
}
async function ask(prompt, stop = false) {
  const previous = await ui.evaluate(lastTurn);
  if (stop) await ui.evaluate(`window.__stopProbe={clicked:false};`);
  await ui.evaluate(`(()=>{const input=document.getElementById('prompt-input');input.value=${JSON.stringify(prompt)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const result = await ui.evaluate(lastTurn);
    if (result && result.id !== previous?.id && !result.streaming && (result.txt.trim() || result.err)) return { ...result, ms: Date.now() - start };
    await sleep(150);
  }
  throw Error('Reply timed out');
}

try {
  if (!existsSync(exe)) throw Error('Debug executable missing; build src-tauri first');
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore', windowsHide: true });
  app.on('error', error => { launchError = error; });
  let pages = [];
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw Error('Isolated app exited early: ' + app.exitCode);
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json(); } catch {}
    if (pages.some(page => page.url.includes('chatgpt.com')) && pages.some(page => page.url.includes('tauri.localhost'))) break;
    await sleep(300);
  }
  if (!ownsEndpoint()) throw Error('Debug endpoint does not belong to the spawned QChat; refusing to attach');
  const main = pages.find(page => page.url.includes('tauri.localhost') && !page.url.includes('settings'));
  const provider = pages.find(page => page.url.startsWith('https://chatgpt.com/'));
  if (!main || !provider) throw Error('App pages did not become ready');
  ui = cdp(main.webSocketDebuggerUrl); site = cdp(provider.webSocketDebuggerUrl);
  await Promise.all([ui.ready, site.ready]);
  await until("/Ready|Guest/.test(document.getElementById('status-label')?.textContent||'')", 45000);
  check('bridge ready', true);
  // Observe real bridge delivery before sending. Stop through the actual button,
  // in the same event task as the first received snapshot, without a polling race.
  await ui.evaluate(`(async()=>{
    await window.__TAURI__.event.listen('bridge',({payload:event})=>{
      const probe=window.__stopProbe;
      if(!probe||probe.clicked||event.type!=='delta'||!event.text?.trim())return;
      const row=[...document.querySelectorAll('#bubble-zone [data-role=assistant]')].find(row=>row.dataset.id===event.id);
      const button=document.getElementById('btn-send');
      if(row?.dataset.status==='streaming'&&button.dataset.mode==='stop'){
        probe.id=event.id;probe.clicked=true;button.click();
      }
    });
  })()`);
  let result = await ask('Reply with exactly the single word: pineapple');
  check('send + stream', /pineapple/i.test(result.txt) && !result.err, `${result.ms}ms`);
  result = await ask('What single word did you just reply with? Answer in one word.');
  check('context recall', /pineapple/i.test(result.txt) && !result.err, `${result.ms}ms`);
  result = await ask('In one sentence, mention that someone reached your daily limit yesterday.');
  check('limit phrase in chat is not a block', !result.err && result.txt.trim().length > 0);
  result = await ask('Say ok.');
  check('send after limit phrase', !result.err && result.txt.trim().length > 0);
  await ui.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`);
  await until("!document.querySelector('#bubble-zone [data-role=assistant]')");
  result = await ask('Write a 3-item markdown list of fruits and a one-line python code block.');
  check('new chat + markdown', /<li>/.test(result.html) && /code-block/.test(result.html) && !/\[object Object\]/.test(result.txt));
  await site.evaluate(`(()=>{const original=window.__qchat.stop;window.__stopSeen={calls:0,settled:false,failed:false};window.__qchat.stop=function(...args){const probe=window.__stopSeen;probe.calls++;try{const result=original.apply(this,args);Promise.resolve(result).then(()=>{probe.settled=true},()=>{probe.failed=true});return result}catch(error){probe.failed=true;throw error}}})()`);
  result = await ask('Count from 1 to 200, separated by spaces.', true);
  let nativeStop;
  for (let i=0;i<100;i++) { nativeStop=await site.evaluate('window.__stopSeen');if(nativeStop.settled||nativeStop.failed)break;await sleep(100); }
  const probe = await ui.evaluate('window.__stopProbe');
  const saved = () => ui.evaluate(`JSON.parse(localStorage.getItem('qchat.chats')).current.transcript.find(item=>item.id===${JSON.stringify(result.id)})`);
  const stopped = await saved();
  check('Stop button dispatches once and retains the received reply', probe.clicked && probe.id === result.id && nativeStop.calls === 1 && nativeStop.settled && !nativeStop.failed && !result.err && !!result.txt.trim() && stopped?.stopped === true && !!stopped.text.trim(), JSON.stringify({clicked:probe.clicked,nativeCalls:nativeStop.calls,stopped:stopped?.stopped}));
  await sleep(2000);
  const stable = await ui.evaluate(lastTurn);
  check('stopped reply stays settled after live events', stable?.id === result.id && !stable.streaming && !stable.err && stable.html === result.html && JSON.stringify(await saved()) === JSON.stringify(stopped));
  // Silence alone cannot prove stale-event handling. Exercise the native path.
  await site.evaluate(`(async()=>{for(const event of [{type:'start'},{type:'delta',text:'STALE STOP OVERWRITE'},{type:'done',text:'STALE STOP OVERWRITE'},{type:'error',code:'stream_failed',message:'STALE STOP OVERWRITE'}])await window.__QCHAT_EMIT__({...event,id:${JSON.stringify(result.id)}})})()`);
  await sleep(200);
  const late = await ui.evaluate(lastTurn);
  check('late native events cannot reopen or overwrite a stopped reply', late?.html === result.html && !late.streaming && !late.err && JSON.stringify(await saved()) === JSON.stringify(stopped));
  await ui.evaluate('window.__stopProbe=null');
  result = await ask('Reply with exactly the single word: walnut');
  check('send works after Stop', !result.err && /walnut/i.test(result.txt));
} catch (error) { check('harness', false, error.stack || error.message); }
finally {
  if (ui) void ui.evaluate("window.__TAURI__.core.invoke('quit_app')").catch(() => {});
  for (let i = 0; i < 30 && app && app.exitCode === null; i++) await sleep(100);
  ui?.close(); site?.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-e2e-')) {
    try { rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
