// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-attachment-focus-ui-'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, 'ui', relative));
    res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', CSP);
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const app = spawn(process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error('Headless Edge did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJS = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description}`);
    return result.result.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const waitFor = async (expr, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(`!!(${expr})`)) return true; } catch {}
      await sleep(10);
    }
    return false;
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/` });
    await waitFor(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(70);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const inputValue = () => evalJS(`document.getElementById('prompt-input').value`);
  const setup = async () => {
    await open('/?mock=1', {settings:{animations:'off',barWidth:340,replyWidth:340}});
    await evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,animations:'off',barWidth:340,replyWidth:340}))`);
    await cdp('Emulation.setDeviceMetricsOverride',{width:368,height:800,deviceScaleFactor:1,mobile:false,screenWidth:1920,screenHeight:1080});
  };
  const add = (name='binary-🌏.bin', size=524311, mime='application/octet-stream') => evalJS(`(()=>{const b=new Uint8Array(${size});for(let i=0;i<b.length;i++)b[i]=(i*37+191)%256;window.expected=b;const d=new DataTransfer();d.items.add(new File([b],${JSON.stringify(name)},{type:${JSON.stringify(mime)}}));const input=document.getElementById('attachment-input');input.files=d.files;input.dispatchEvent(new Event('change'))})()`);
  const fault = (cmd, spec) => evalJS(`__mock.attachmentFaults[${JSON.stringify(cmd)}]=${JSON.stringify(spec)}`);
  const wait = async (expr) => {if (!await waitFor(expr)) throw Error('timeout: '+expr)};
  const retry = `document.querySelector('[data-action="retry-attachment"]')`;
  const err = `document.querySelector('#attachments [data-state="error"]')`;
  const ready = `document.querySelector('#attachments [data-state="ready"]')`;
  const click = (expr) => evalJS(`${expr}.click()`);
  const shotDir=path.join(root,'.tmp','stage-retry-shots');await mkdir(shotDir,{recursive:true});
  const screenshot=async name=>writeFile(path.join(shotDir,name),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));


  for (const control of ['ready', 'selection', 'retry']) {
    await setup();
    if (control === 'ready') { await add('existing.bin', 20); await wait(ready); }
    if (control === 'selection') { await evalJS("__mock.emit('qchat://selection','Keep this quoted context')"); await wait("document.querySelector('#attachments .selection-chip button')"); }
    if (control === 'retry') { await fault('attachment_begin',{failOn:[1]}); await add('failed.bin',20); await wait(err); }
    await fault('attachment_chunk',{holdOn:[1]});
    await add('progress.bin', 1048611);
    await wait('__mock.attachmentFaults.attachment_chunk.release');
    const selector = control === 'ready' ? '[aria-label="Remove existing.bin"]' : control === 'selection' ? '.selection-chip button' : '[data-action="retry-attachment"]';
    await evalJS('window.focusedAttachment=document.querySelector('+JSON.stringify('#attachments '+selector)+');focusedAttachment.focus()');
    check(control+' focus initially reachable',await evalJS('document.activeElement===focusedAttachment'));
    await evalJS('__mock.attachmentFaults.attachment_chunk.release()');
    await wait('document.querySelector('+JSON.stringify('[aria-label="Remove progress.bin"]')+').closest(".attachment-chip").dataset.state==="ready"');
    check(control+' focus and node survive unrelated upload progress',await evalJS('focusedAttachment.isConnected&&document.activeElement===focusedAttachment'));
  }

  await setup();await add('same.bin',21);await wait(ready);await add('same.bin',22);await wait("document.querySelectorAll('#attachments [data-state=ready]').length===2");
  const sameIds=await evalJS('__mock.calls.filter(call=>call.cmd==="attachment_begin").map(call=>call.args.name)');
  check('same-name files remain separate visible attachments',sameIds.length===2&&await evalJS('document.querySelectorAll("#attachments .attachment-chip:not(.selection-chip)").length===2'));
  await fault('attachment_chunk',{holdOn:[1]});await add('other-progress.bin',524301);await wait('__mock.attachmentFaults.attachment_chunk.release');
  await evalJS('window.sameControls=Array.from(document.querySelectorAll("#attachments button[aria-label]" )).filter(button=>button.getAttribute("aria-label")==="Remove same.bin");window.focusedSame=sameControls[1];focusedSame.focus()');
  await evalJS('__mock.attachmentFaults.attachment_chunk.release()');await wait("document.querySelectorAll('#attachments [data-state=ready]').length===3");
  check('same-name focus remains on the second file through progress',await evalJS('focusedSame.isConnected&&document.activeElement===focusedSame&&Array.from(document.querySelectorAll("#attachments button[aria-label]" )).filter(button=>button.getAttribute("aria-label")==="Remove same.bin")[1]===focusedSame'));
  const enter=async()=>{await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});};
  await evalJS('Array.from(document.querySelectorAll("#attachments button[aria-label]" )).find(button=>button.getAttribute("aria-label")==="Remove same.bin").focus()');await enter();await wait('document.querySelectorAll("#attachments .attachment-chip:not(.selection-chip)").length===2');
  await evalJS('Array.from(document.querySelectorAll("#attachments button[aria-label]" )).find(button=>button.getAttribute("aria-label")==="Remove same.bin").focus()');await enter();await wait('document.querySelectorAll("#attachments .attachment-chip:not(.selection-chip)").length===1');
  check('keyboard removal targets each same-name file once',await evalJS('__mock.count("attachment_remove")===2&&Array.from(document.querySelectorAll("#attachments button[aria-label]")).some(button=>button.getAttribute("aria-label")==="Remove other-progress.bin")&&Array.from(__mock.attachmentFiles.values()).every(file=>file.name!=="same.bin")'));

  await setup();
  await evalJS('(()=>{const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="),char=>char.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],"copy-focus.png",{type:"image/png"}));const input=document.getElementById("attachment-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()');await wait(ready);
  await fault('attachment_chunk',{holdOn:[1]});await add('copy-progress.bin',524301);await wait('__mock.attachmentFaults.attachment_chunk.release');
  await evalJS('window.originalFocusInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==="image_copy"){__mock.calls.push({cmd,args});await new Promise(resolve=>{window.releaseImageCopy=resolve;});return null;}return originalFocusInvoke(cmd,args);};window.focusedCopy=document.querySelector("#attachments .image-copy");focusedCopy.focus();');
  await enter();await wait('typeof window.releaseImageCopy==="function"');
  await evalJS('__mock.attachmentFaults.attachment_chunk.release()');await wait("document.querySelectorAll('#attachments [data-state=ready]').length===2");
  check('pending image copy keeps one disabled control through progress',await evalJS('focusedCopy.isConnected&&document.querySelector("#attachments .image-copy")===focusedCopy&&focusedCopy.disabled&&__mock.count("image_copy")===1'));
  await evalJS('window.releaseImageCopy()');await wait('!focusedCopy.disabled');
  check('image copy feedback remains on the visible control',await evalJS('document.querySelector("#attachments .image-copy").textContent==="Copied"'));

  await setup();await type('A stable draft 🌏');await evalJS('document.getElementById("prompt-input").focus();document.getElementById("prompt-input").setSelectionRange(2,8,"backward")');
  await fault('attachment_chunk',{holdOn:[1]});await add('draft-progress.bin',1048581);await wait('__mock.attachmentFaults.attachment_chunk.release');await evalJS('__mock.attachmentFaults.attachment_chunk.release()');await wait(ready);
  check('upload progress preserves composer text and backward range',await evalJS('(()=>{const input=document.getElementById("prompt-input");return document.activeElement===input&&input.value==="A stable draft 🌏"&&input.selectionStart===2&&input.selectionEnd===8&&input.selectionDirection==="backward";})()'));
  check('attachment interaction never submits a chat',await count('chat_send')===0);
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-attachment-focus-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
