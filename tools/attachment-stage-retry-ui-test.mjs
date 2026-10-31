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
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-stage-retry-ui-'));
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

  await setup(); await fault('attachment_begin',{failOn:[1]}); await add(); await wait(err);
  check('begin failure exposes named Retry and Remove',await evalJS(`!!${retry} && ${retry}.getAttribute('aria-label').includes('binary-🌏.bin') && !!${err}.querySelector('[aria-label^="Remove"]')`));
  check('340px setting applied and failed controls fit with full Retry text',await evalJS(`(()=>{const chip=${err},b=${retry},r=b.getBoundingClientRect(),c=chip.getBoundingClientRect();const bar=document.getElementById('bar').getBoundingClientRect();return QSettings.settings.barWidth===340 && Math.abs(bar.width-340)<1 && c.left>=bar.left-1 && c.right<=bar.right+1 && c.left>=0 && c.right<=innerWidth && r.left>=c.left && r.right<=c.right && b.scrollWidth<=b.clientWidth})()`));
  await screenshot('failed-340.png');
  await type('draft 🌏 caret'); await evalJS(`document.getElementById('prompt-input').setSelectionRange(2,5);${retry}.focus()`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13}); await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait(ready); await screenshot('ready-340.png');
  check('ready chip fits applied 340px bar',await evalJS(`(()=>{const b=document.getElementById('bar').getBoundingClientRect(),c=${ready}.getBoundingClientRect();return Math.abs(b.width-340)<1 && c.left>=b.left-1 && c.right<=b.right+1})()`));
  check('keyboard retry succeeds and restores draft focus and caret',await evalJS(`(()=>{const i=document.getElementById('prompt-input');return document.activeElement===i&&i.value==='draft 🌏 caret'&&i.selectionStart===2&&i.selectionEnd===5})()`));
  check('begin failure retry uses fresh start and sends nothing',await evalJS(`__mock.count('attachment_begin')===2 && __mock.last('attachment_chunk').args.offset===524288 && __mock.count('chat_send')===0`));
  for(const command of ['attachment_chunk','attachment_finish']) {
    await setup(); await fault(command,{failOn:[command==='attachment_chunk'?2:1]}); await add(); await wait(err);
    const old=await evalJS(`__mock.calls.find(c=>c.cmd==='attachment_chunk').args.id`);
    await wait(`!__mock.attachmentFiles.has(${JSON.stringify(old)})`);
    await evalJS(`window.detached=${retry};detached.click();detached.click()`); await wait(ready); await evalJS('detached.click()');
    check(command+' retries once with fresh id and removes old id',await evalJS(`(()=>{const calls=__mock.calls.filter(c=>c.cmd==='attachment_chunk'),id=calls.at(-1).args.id;return __mock.count('attachment_begin')===2 && id!==${JSON.stringify(old)}&&!__mock.attachmentFiles.has(${JSON.stringify(old)})&&calls.filter(c=>c.args.id===id)[0].args.offset===0})()`));
    check(command+' replays exact binary bytes and metadata',await evalJS(`(()=>{const b=__mock.calls.filter(c=>c.cmd==='attachment_begin').at(-1).args,chunks=__mock.calls.filter(c=>c.cmd==='attachment_chunk'),id=chunks.at(-1).args.id,bytes=chunks.filter(c=>c.args.id===id).map(c=>atob(c.args.data)).join('');return b.name==='binary-🌏.bin'&&b.mime==='application/octet-stream'&&b.size===expected.length&&bytes.length===expected.length&&Array.from(expected).every((v,i)=>bytes.charCodeAt(i)===v)})()`));
  }
  await setup(); await fault('attachment_chunk',{failOn:[2]}); await fault('attachment_remove',{holdOn:[1],failOn:[1,2]}); await add();
  await wait(`__mock.attachmentFaults.attachment_remove.release`);
  await evalJS(`__mock.emit('qchat://selection','context')`); await wait(err); await click(retry);
  check('retry waits for original cleanup before begin',await count('attachment_begin')===1);
  await evalJS(`__mock.attachmentFaults.attachment_remove.release()`); await wait(err);
  check('failed cleanup refuses fresh begin and keeps discard warning',await evalJS(`__mock.count('attachment_begin')===1 && document.body.textContent.includes('Could not discard')`));
  await click(retry); await wait(ready);
  check('later successful cleanup permits fresh begin',await evalJS(`__mock.count('attachment_begin')===2 && __mock.count('attachment_remove')===3`));
  check('successful cleanup clears its obsolete discard warning',await evalJS('document.getElementById("global-error").hidden'));
  await setup();await fault('attachment_chunk',{failOn:[2]});await fault('attachment_remove',{failOn:[1],holdOn:[2]});await add('warning.bin',524311);await wait(err);await click(retry);await wait('__mock.attachmentFaults.attachment_remove.release');
  await evalJS(`__mock.emit('qchat://selection-error','Keep this unrelated warning');__mock.attachmentFaults.attachment_remove.release()`);await wait(ready);
  check('successful cleanup preserves a newer unrelated warning',await evalJS(`!document.getElementById('global-error').hidden&&document.getElementById('global-error-text').textContent.includes('Keep this unrelated warning')`));
  await setup();await fault('attachment_begin',{failOn:[1],holdOn:[2]});await add('failed-switch.bin',35);await wait(err);await type('keep failed-switch draft');await click(retry);await wait(`__mock.attachmentFaults.attachment_begin.release`);
  await evalJS('__mock.failProvider=true');await key('k',{ctrlKey:true});await evalJS(`document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);await wait(`document.body.textContent.includes("Couldn't switch providers")`);
  await evalJS('__mock.attachmentFaults.attachment_begin.release()');await sleep(80);
  check('failed provider switch keeps the retrying file and draft',await evalJS(`__mock.provider==='chatgpt'&&!!document.querySelector('[aria-label="Remove failed-switch.bin"]')&&!!${ready}&&__mock.attachmentFiles.size===1&&document.getElementById('prompt-input').value==='keep failed-switch draft'`));
  await setup();await evalJS(`window.previewRevokes=[];window.originalRevoke=URL.revokeObjectURL;URL.revokeObjectURL=function(url){previewRevokes.push(url);return originalRevoke.call(URL,url)};(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const d=new DataTransfer();d.items.add(new File([bytes],'portable.png',{type:'image/png'}));const input=document.getElementById('attachment-input');input.files=d.files;input.dispatchEvent(new Event('change'))})()`);await wait(ready);await evalJS(`window.portablePreview=document.querySelector('#attachments img').src`);
  await key('k',{ctrlKey:true});await evalJS(`document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);await wait(`__mock.provider==='gemini'`);await sleep(60);
  check('provider switch preserves the pending image preview resource',await evalJS(`!!document.querySelector('[aria-label="Remove portable.png"]')&&document.querySelector('#attachments img').src===portablePreview&&!previewRevokes.includes(portablePreview)`));
  await setup();await fault('attachment_begin',{failOn:[1],holdOn:[2]});await add('local-retry.bin',22);await wait(err);await add('local-blocker.bin',22);await wait(`__mock.attachmentFaults.attachment_begin.release`);await click(retry);
  await evalJS('__mock.providerHold=true');await key('k',{ctrlKey:true});await evalJS(`document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);await wait('typeof __mock.releaseProvider==="function"');
  await evalJS('__mock.attachmentFaults.attachment_begin.release()');await wait(`document.querySelector('[aria-label="Remove local-retry.bin"]').closest('.attachment-chip').dataset.state!=='staging'`);
  check('queued local preparation continues while a provider switch is pending',await evalJS(`document.querySelector('[aria-label="Remove local-retry.bin"]').closest('.attachment-chip').dataset.state==='ready'&&__mock.count('attachment_begin')===3`));
  await evalJS('__mock.releaseProvider()');await wait(`__mock.provider==='gemini'`);
  await open('/?mock=1&holdProvider=1',{settings:{animations:'off',defaultProvider:'gemini',barWidth:340,replyWidth:340}});await wait('typeof __mock.releaseProvider==="function"');await type('startup draft');await add('startup.bin',27);await wait(ready);
  await evalJS('__mock.failProvider=true;__mock.releaseProvider()');await wait(`document.body.textContent.includes('Using ChatGPT for now')`);
  check('startup provider fallback keeps the staged file and draft',await evalJS(`!!document.querySelector('[aria-label="Remove startup.bin"]')&&!!${ready}&&__mock.attachmentFiles.size===1&&document.getElementById('prompt-input').value==='startup draft'`));
  for(const action of ['remove','new','provider']) {
    await setup(); await fault('attachment_begin',{failOn:[1],holdOn:[2]}); await add('held.bin',100); await wait(err); await click(retry); await wait(`__mock.attachmentFaults.attachment_begin.release`);
    if(action==='remove') await click(`document.querySelector('#attachments [aria-label^="Remove"]')`);
    if(action==='new') await evalJS(`__mock.emit('qchat://new-chat',{})`);
    if(action==='provider') {await key('k',{ctrlKey:true}); await evalJS(`document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);}
    if(action==='provider') {
      await wait(`__mock.provider==='gemini'`);await evalJS(`__mock.attachmentFaults.attachment_begin.release()`);await wait(ready);
      check('provider switch keeps in-flight Retry with the draft',await evalJS(`!!document.querySelector('[aria-label="Remove held.bin"]')&&__mock.attachmentFiles.size===1&&__mock.count('attachment_begin')===2&&__mock.count('chat_send')===0`));
    } else {
      await wait(`!document.querySelector('#attachments .attachment-name')`);
      await evalJS(`__mock.attachmentFaults.attachment_begin.release()`); await wait(`__mock.count('attachment_remove')===1`); await sleep(50);
      check(action+' during retry begin cancels and discards without resurrection',await evalJS(`!document.querySelector('#attachments .attachment-name') && __mock.attachmentFiles.size===0`));
    }
  }

  // A queued retry must not survive removal or navigation while another file owns the queue.
  for(const action of ['remove','new','provider']) {
    await setup(); await fault('attachment_begin',{failOn:[1],holdOn:[2]}); await add('failed.bin',20); await wait(err);
    await add('blocker.bin',20); await wait(`__mock.attachmentFaults.attachment_begin.release`);
    await evalJS(`window.detached=${retry};detached.click();detached.click()`);
    if(action==='remove') await click(`document.querySelector('#attachments [aria-label="Remove failed.bin"]')`);
    if(action==='new') await evalJS(`__mock.emit('qchat://new-chat',{})`);
    if(action==='provider') {await key('k',{ctrlKey:true}); await evalJS(`document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);}
    if(action==='provider') {
      await wait(`__mock.provider==='gemini'`);await evalJS(`__mock.attachmentFaults.attachment_begin.release()`);await wait(`document.querySelectorAll('#attachments [data-state=ready]').length===2`);await evalJS('detached.click()');
      check('provider switch preserves queued Retry and the other file',await evalJS(`__mock.count('attachment_begin')===3&&!!document.querySelector('[aria-label="Remove failed.bin"]')&&!!document.querySelector('[aria-label="Remove blocker.bin"]')&&__mock.attachmentFiles.size===2&&__mock.count('chat_send')===0`));
    } else {
      await wait(`!document.querySelector('[aria-label="Remove failed.bin"]')`);
      await evalJS(`__mock.attachmentFaults.attachment_begin.release();detached.click()`); await sleep(150);
      check(action+' cancels queued retry and detached clicks',await evalJS(`__mock.count('attachment_begin')===2 && !document.querySelector('[aria-label="Remove failed.bin"]') && !Array.from(__mock.attachmentFiles.values()).some(f=>f.name==='failed.bin')`));
    }
  }
  for(const phase of ['attachment_chunk','attachment_finish']) {
    await setup(); await fault('attachment_begin',{failOn:[1]}); await fault(phase,{holdOn:[1]}); await add('phase.bin',30); await wait(err); await click(retry);
    await wait(`__mock.attachmentFaults[${JSON.stringify(phase)}].release`); await click(`document.querySelector('[aria-label="Remove phase.bin"]')`);
    await evalJS(`__mock.attachmentFaults[${JSON.stringify(phase)}].release()`); await wait(`__mock.count('attachment_remove')===1`); await sleep(40);
    check('remove during retry '+phase+' leaves no file',await evalJS(`__mock.attachmentFiles.size===0 && !document.querySelector('[aria-label="Remove phase.bin"]')`));
  }
  await setup(); await fault('attachment_begin',{failOn:[1]}); await add('reader.bin',30); await wait(err);
  await evalJS(`window.NativeReader=FileReader;window.FileReader=class {readAsDataURL(blob){this.inner=new NativeReader();this.inner.onload=()=>{this.result=this.inner.result;window.releaseRead=()=>this.onload?.()};this.inner.onerror=()=>this.onerror?.();this.inner.readAsDataURL(blob)}abort(){this.inner.abort();this.onabort?.()}}`);
  await click(retry); await wait('window.releaseRead'); await click(`document.querySelector('[aria-label="Remove reader.bin"]')`); await wait(`__mock.count('attachment_remove')===1`);
  check('remove during retry FileReader discards without uploading',await evalJS(`__mock.attachmentFiles.size===0 && __mock.count('attachment_chunk')===0 && !document.querySelector('[aria-label="Remove reader.bin"]')`));
  await setup(); await fault('attachment_chunk',{failOn:[1]}); await fault('attachment_remove',{holdOn:[1]}); await add('cleanup.bin',30);
  await wait(`__mock.attachmentFaults.attachment_remove.release`); await evalJS(`__mock.emit('qchat://selection','render')`); await wait(err); await click(retry);
  await click(`document.querySelector('[aria-label="Remove cleanup.bin"]')`); await evalJS(`__mock.attachmentFaults.attachment_remove.release()`); await wait(`__mock.attachmentFiles.size===0`); await sleep(40);
  check('removal during shared cleanup cannot restart upload',await evalJS(`__mock.count('attachment_begin')===1 && !document.querySelector('[aria-label="Remove cleanup.bin"]')`));

  await setup(); await fault('attachment_begin',{failOn:[1]});
  await evalJS(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const d=new DataTransfer();d.items.add(new File([bytes],'preview.png',{type:'image/png'}));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))})()`);
  await wait(err); await add('other.bin',25); await wait(ready); await evalJS(`__mock.emit('qchat://selection','selected context');window.previewBefore=document.querySelector('#attachments img').src`); await type('keep this draft'); await evalJS(`document.getElementById('prompt-input').setSelectionRange(3,7);${retry}.focus()`);
  await screenshot('image-failed-340.png');
  check('image failure controls fit at 340px',await evalJS(`(()=>{const c=${err}.getBoundingClientRect(), b=${retry}.getBoundingClientRect();return c.left>=0 && c.right<=innerWidth && b.right<=c.right && ${retry}.scrollWidth<=${retry}.clientWidth})()`));
  await click(retry); await wait(`document.querySelectorAll('#attachments [data-state="ready"]').length===2`);
  check('retry preserves original preview, selection chip, other file, draft and caret',await evalJS(`(()=>{const i=document.getElementById('prompt-input');return document.querySelector('#attachments img').src===previewBefore && !!document.querySelector('#attachments .selection-chip') && !!document.querySelector('[aria-label="Remove other.bin"]') && i.value==='keep this draft' && i.selectionStart===3 && i.selectionEnd===7 && document.activeElement===i && __mock.count('chat_send')===0})()`));
  check('saved chat metadata contains no staged bytes or id',await evalJS(`(()=>{const s=localStorage.getItem('qchat.chats')||'';return !s.includes(previewBefore)&&!Array.from(__mock.attachmentFiles.keys()).some(id=>s.includes(id))&&!s.includes('iVBORw0KGgo')})()`));

  await setup(); await fault('attachment_begin',{failOn:[1]}); await add('bad.bin',20); await wait(err); await add('good.bin',20); await wait(ready);
  await type('send to become busy'); await click(`document.getElementById('btn-send')`); await wait(`__mock.count('chat_send')===1`);
  check('retry is visibly disabled while busy',await evalJS(`${retry}.disabled`));
  await evalJS(`${retry}.click()`); check('busy retry does not begin',await count('attachment_begin')===2);
  await wait(`!${retry}.disabled`); check('retry re-enables after completion',await evalJS(`!${retry}.disabled`));
  await setup(); await fault('attachment_begin',{failOn:[1]}); await add('stop.bin',20); await wait(err); await type('stop test'); await click(`document.getElementById('btn-send')`); await wait(`${retry}.disabled`); await click(`document.getElementById('btn-send')`); await wait(`!${retry}.disabled`);
  check('Retry re-enables after Stop',await evalJS(`!${retry}.disabled`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-stage-retry-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
