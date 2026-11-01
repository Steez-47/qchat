// Real UI, staging, WebView2 file handoff and provider bridges. Image sends
// use local provider fixtures; no account, clipboard or visible window.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-image-send-native-'));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const app = spawn(process.env.QCHAT_SURFACES_EXE || path.join(root, 'src-tauri/target/debug/qchat.exe'), [], {
  env: { ...process.env, QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_DEBUG_PORT: String(port) },
  stdio: 'ignore', windowsHide: true
});
let launchError, failed = 0;
app.on('error', error => { launchError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [], problems = [];
let main, site;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failed++; };
async function until(fn, label) {
  for (let i = 0; i < 160; i++) {
    if (launchError) throw launchError;
    if (app.exitCode !== null) throw Error('Isolated app exited');
    if (await fn()) return;
    await sleep(75);
  }
  throw Error('Timed out: ' + label);
}
const pages = async () => {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(700) })).json(); }
  catch { return []; }
};
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(), handlers = [];
  let serial = 0;
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const result = JSON.parse(event.data);
    if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id); }
    else {
      if (result.method === 'Runtime.exceptionThrown') problems.push(result.params.exceptionDetails.exception?.description || result.params.exceptionDetails.text);
      for (const handler of handlers) Promise.resolve(handler(result.method, result.params)).catch(error => { problems.push(error.message); });
    }
  };
  ws.onclose = () => { for (const finish of pending.values()) finish({ error: { message: 'CDP closed' } }); pending.clear(); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, result => { clearTimeout(timer); result.error ? reject(Error(result.error.message)) : resolve(result.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const client = { ws, send, evaluate, handlers }; clients.push(client);
  await send('Runtime.enable'); await send('Page.enable');
  return client;
}
const fixtureHTML = provider => `<!doctype html><html><head><meta charset="utf-8"><title>Image send fixture</title></head><body>
  <a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: Image fixture">Account</a>
  <div id="messages"></div><form onsubmit="return false">
  <rich-textarea><div id="prompt-textarea" class="ql-editor ProseMirror" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini" style="min-height:40px"></div></rich-textarea>
  <input id="files" type="file" multiple><div id="chips"></div>
  <button type="button" id="send" data-testid="send-button" aria-label="Send message">Send</button></form>
  <button data-testid="create-new-chat-button" data-test-id="reset-button" aria-label="New chat" onclick="fixtureReset()">New chat</button>
  <script>
  window.fixtureSubmissions=[];window.fixtureClicks=0;window.fixtureIgnore=0;window.fixtureFiles=[];
  window.fixtureReset=()=>{document.getElementById('messages').replaceChildren();document.getElementById('chips').replaceChildren();document.getElementById('files').value='';document.getElementById('prompt-textarea').textContent='';fixtureFiles=[];fixtureClicks=0;fixtureSubmissions=[];};
  document.getElementById('files').onchange=event=>{
    fixtureFiles=Array.from(event.target.files);
    document.getElementById('chips').replaceChildren();
    for(const file of fixtureFiles){const chip=document.createElement('button');chip.type='button';chip.setAttribute('aria-label','Remove file '+file.name);chip.onclick=()=>chip.remove();document.getElementById('chips').append(chip);}
  };
  document.getElementById('send').onclick=async()=>{
    if(++fixtureClicks<=fixtureIgnore)return;
    const composer=document.getElementById('prompt-textarea'),text=composer.innerText.trim(),files=fixtureFiles.slice();
    const record={text,files:await Promise.all(files.map(async file=>({name:file.name,bytes:Array.from(new Uint8Array(await file.arrayBuffer()))}))) };
    fixtureSubmissions.push(record);
    composer.textContent='';document.getElementById('files').value='';document.getElementById('chips').replaceChildren();
    const user=document.createElement(${JSON.stringify(provider === 'chatgpt' ? 'div' : 'user-query')});
    user.setAttribute('data-message-author-role','user');user.setAttribute('data-message-id',crypto.randomUUID());user.textContent=text;
    for(const file of files){const image=document.createElement('img');image.src=URL.createObjectURL(file);user.append(image);}
    document.getElementById('messages').append(user);
    // No intercepted conversation fetch or Stop button: the actual bridge must
    // acknowledge the submitted turn and deliver this reply through DOM fallback.
    setTimeout(()=>{const reply=document.createElement(${JSON.stringify(provider === 'chatgpt' ? 'div' : 'model-response')});reply.setAttribute('data-message-author-role','assistant');reply.setAttribute('data-message-id',crypto.randomUUID());reply.innerHTML='<div class="markdown"><p>Image received: '+files.length+'</p></div>';document.getElementById('messages').append(reply);},150);
  };
  </script></body></html>`;
async function install(provider) {
  let target;
  await until(async () => (target = (await pages()).find(page => page.url.startsWith(provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/'))), 'provider target');
  const client = await connect(target);
  client.handlers.push(async (method, params) => {
    if (method !== 'Fetch.requestPaused') return;
    const documentRequest = params.resourceType === 'Document';
    const body = documentRequest ? fixtureHTML(provider) : JSON.stringify(params.request.url.includes('/api/auth/session') ? { user: {} } : {});
    await client.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: documentRequest ? 'text/html; charset=utf-8' : 'application/json' }], body: Buffer.from(body).toString('base64') });
  });
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await client.send('Page.navigate', { url: provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app' });
  await until(async () => { try { return await client.evaluate('document.readyState==="complete"&&!!window.__qchat&&!!window.fixtureReset'); } catch { return false; } }, 'provider fixture');
  await client.evaluate('window.__qchat.status();undefined');
  return client;
}
try {
  let target;
  await until(async () => (target = (await pages()).find(page => page.url.includes('tauri.localhost') && !page.url.includes('settings'))), 'main target');
  const ownership = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$probeId=(Get-CimInstance Win32_Process -Filter "ProcessId = $probeId").ParentProcessId};exit 1`
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (ownership.status !== 0 || ownership.stdout.trim() !== 'owned') throw Error('Debug endpoint is not owned by the isolated app');
  main = await connect(target);
  await until(() => main.evaluate('document.readyState==="complete"&&!!window.QSettings'), 'main ready');
  await main.evaluate('(async()=>{window.fixtureEvents=[];await window.__TAURI__.event.listen("bridge",event=>fixtureEvents.push(event.payload));window.__TAURI__.event.emit("qchat://settings-changed",QSettings.save({...QSettings.settings,animations:"off",autoDismiss:0,reasoningEffort:"medium"}));})()');
  for (const provider of ['chatgpt', 'gemini']) {
    if (provider === 'gemini') await main.evaluate('window.__TAURI__.core.invoke("provider_set",{provider:"gemini"})');
    site = await install(provider);
    if (provider === 'gemini') {
      await main.evaluate('document.getElementById("btn-reasoning").click()');
      await until(() => main.evaluate('!!Array.from(document.querySelectorAll("#picker button")).find(button=>button.textContent.trim()==="Gemini")'), 'Gemini picker');
      await main.evaluate('Array.from(document.querySelectorAll("#picker button")).find(button=>button.textContent.trim()==="Gemini").click()');
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    const expectedBytes = Array.from(Buffer.from(png, 'base64'));
    for (const scenario of [{ prompt: 'Describe this image 🌏', count: 1 }, { prompt: '', count: 1 }, { prompt: '', count: 2 }, { prompt: '', count: 1, ignore: 1 }]) {
      await main.evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"n",ctrlKey:true,bubbles:true,cancelable:true}))');
      await until(() => main.evaluate('document.getElementById("prompt-input").value===""&&document.getElementById("attachments").hidden'), 'fresh composer');
      // Let actual newChat finish before configuring this submission.
      await sleep(450);
      await site.evaluate('fixtureIgnore=' + (scenario.ignore || 0) + ';fixtureClicks=0;fixtureSubmissions=[];');
      await main.evaluate(`(()=>{const transfer=new DataTransfer(),bytes=Uint8Array.from(atob(${JSON.stringify(png)}),c=>c.charCodeAt(0));for(let i=0;i<${scenario.count};i++)transfer.items.add(new File([bytes],'photo-🌏-'+i+'.png',{type:'image/png'}));const input=document.getElementById('attachment-input');input.files=transfer.files;input.dispatchEvent(new Event('change'));const prompt=document.getElementById('prompt-input');prompt.value=${JSON.stringify(scenario.prompt)};prompt.dispatchEvent(new Event('input'));})()`);
      await until(() => main.evaluate(`document.querySelectorAll('#attachments [data-state="ready"]').length===${scenario.count}&&!document.getElementById('btn-send').disabled`), 'image staging');
      const label = provider + ' ' + (scenario.ignore ? 'ignored first click' : scenario.count > 1 ? 'multiple images without text' : scenario.prompt ? 'image with text' : 'image without text');
      check(label + ' renders decoded previews', await main.evaluate(`Array.from(document.querySelectorAll('#attachments img')).filter(image=>image.naturalWidth===1).length===${scenario.count}`));
      const before = await main.evaluate('fixtureEvents.length');
      await main.evaluate('document.getElementById("btn-send").click()');
      await until(() => main.evaluate(`fixtureEvents.slice(${before}).some(event=>event.type==='done'||event.type==='error')`), 'native image reply');
      const events = await main.evaluate(`fixtureEvents.slice(${before}).filter(event=>event.id&&['start','done','error'].includes(event.type))`);
      const submissions = await site.evaluate('fixtureSubmissions');
      check(label + ' submits once with exact image bytes and text', submissions.length === 1 && submissions[0].text === scenario.prompt && submissions[0].files.length === scenario.count && submissions[0].files.every((file, index) => file.name === `photo-🌏-${index}.png` && JSON.stringify(file.bytes) === JSON.stringify(expectedBytes)));
      check(label + ' acknowledges and completes without refresh', events.filter(event => event.type === 'start').length === 1 && events.filter(event => event.type === 'done' && event.text === 'Image received: ' + scenario.count).length === 1 && !events.some(event => event.type === 'error'));
      await until(() => main.evaluate('Array.from(document.querySelectorAll("[data-role=assistant] .turn-content")).some(node=>node.textContent.includes("Image received"))'), 'rendered image reply');
      check(label + ' displays the reply and restores Send', await main.evaluate('document.getElementById("btn-send").dataset.mode==="send"&&document.getElementById("attachments").hidden'));
    }
  }
  check('native image send has no runtime errors', problems.length === 0);
} catch (error) { console.error('FAIL harness ::', error.message); failed++; }
finally {
  if (main?.ws.readyState === WebSocket.OPEN) void main.evaluate('window.__TAURI__.core.invoke("quit_app")').catch(() => {});
  for (let i = 0; i < 30 && app.exitCode === null; i++) await sleep(100);
  for (const client of clients) client.ws.close();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(600);
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-image-send-native-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
