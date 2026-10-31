// Isolated native attachment and media broker checks. No account data is read or logged.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri', 'target'), 'debug', 'qchat.exe');
const reserve = createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port = reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let n = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const ready = new Promise((r, j) => { const timer=setTimeout(()=>j(Error('CDP connection timeout')),10000);ws.onopen=()=>{clearTimeout(timer);r()};ws.onerror=()=>{clearTimeout(timer);j(Error('CDP connection failed'))}; });
  ws.onclose=()=>{for(const callback of pend.values())callback({error:{message:'CDP closed'}});pend.clear()};
  const call = async (method, params = {}) => { await ready;const id = ++n; return new Promise((r, j) => { const timer=setTimeout(()=>{pend.delete(id);j(Error('CDP timeout: '+method))},15000);pend.set(id, d => {clearTimeout(timer);d.error ? j(Error(d.error.message)) : r(d.result || {})});ws.send(JSON.stringify({ id, method, params })); }); };
  const evaluate = async expr => { const d = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (d.exceptionDetails) throw Error(`page evaluation failed: ${String(d.exceptionDetails.exception?.description || d.exceptionDetails.text || '').slice(0, 150)}`); return d.result?.value; };
  return { ready, evaluate, call, close: () => ws.close() };
}
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-native-media-'));
let app, ui, site, failed = 0;
function ownsEndpoint() {
  const script=`$probeId=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') } | Select-Object -First 1 -ExpandProperty OwningProcess;for($depth=0;$depth -lt 20 -and $probeId;$depth++){if($probeId -eq ${app.pid}){Write-Output 'owned';exit 0};$record=Get-CimInstance Win32_Process -Filter "ProcessId = $probeId" -ErrorAction Stop;$probeId=$record.ParentProcessId};exit 1`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
  return result.status===0&&result.stdout.trim()==='owned';
}
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` :: ${info}` : ''}`); if (!ok) failed++; };
const safeError = async p => { try { await p; return false; } catch { return true; } };
try {
  if (!existsSync(exe)) throw Error('Debug executable missing; build src-tauri first.');
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile }, stdio: 'ignore', windowsHide: true });
  let launchError;app.on('error',error=>{launchError=error});
  let pages = [];
  for (let i = 0; i < 100; i++) {
    if(launchError)throw launchError;if(app.exitCode!==null)throw Error('Isolated test app exited early');
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json`,{signal:AbortSignal.timeout(700)})).json(); } catch {}
    if (pages.some(p => p.url.includes('tauri.localhost')) && pages.some(p => p.url.includes('chatgpt.com'))) break;
    await sleep(500);
  }
  const mainPage = pages.find(p => p.url.includes('tauri.localhost'));
  const sitePage = pages.find(p => p.url.includes('chatgpt.com'));
  if (!mainPage || !sitePage) throw Error('App CDP pages did not become ready.');
  if(!ownsEndpoint())throw Error('Debug endpoint is not owned by spawned QChat; refusing to attach');
  ui = cdp(mainPage.webSocketDebuggerUrl); site = cdp(sitePage.webSocketDebuggerUrl); await Promise.all([ui.ready, site.ready]);
  let status = '';
  for (let i = 0; i < 80; i++) { status = await ui.evaluate("document.getElementById('status-label')?.textContent||''"); if (/Ready|Guest/.test(status)) break; await sleep(500); }
  check('main bridge ready', /Ready|Guest/.test(status));
  let uploadGeneration=(await ui.evaluate("window.__TAURI__.core.invoke('launch_info')")).uploadGeneration;
  check('bridge context denies native attachment command', await safeError(site.evaluate("window.__TAURI_INTERNALS__.invoke('attachment_begin',{name:'x',mime:'text/plain',size:0})")));
  check('bridge context denies native media command', await safeError(site.evaluate("window.__TAURI_INTERNALS__.invoke('media_load',{mediaId:'x'})")));
  check('bridge context denies native image copy', await safeError(site.evaluate("window.__TAURI_INTERNALS__.invoke('image_copy',{width:1,height:1,rgba:'AAAAAA=='})")));
  check('native image copy rejects mismatched dimensions before touching clipboard', await safeError(ui.evaluate("window.__TAURI__.core.invoke('image_copy',{width:2,height:1,rgba:'AAAAAA=='})")));

  const fixture = Buffer.alloc(700123); for (let i = 0; i < fixture.length; i++) fixture[i] = (i * 31 + 17) & 255;
  const expected = fixture.toString('base64');
  const begun = await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'資料 🧪.txt',mime:'text/plain; charset=utf-8',size:${fixture.length},uploadGeneration:${uploadGeneration}})`);
  check('attachment metadata preserves Unicode filename and MIME', begun.name === '資料 🧪.txt' && begun.mime === 'text/plain' && begun.size === fixture.length);
  const id = begun.id;
  check('reject incorrect chunk offset', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_chunk',{id:${JSON.stringify(id)},offset:1,data:'AA=='})`)));
  check('reject oversized chunk', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_chunk',{id:${JSON.stringify(id)},offset:0,data:${JSON.stringify(Buffer.alloc(512 * 1024 + 1).toString('base64'))}})`)));
  check('reject incomplete finish', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(id)}})`)));
  for (let offset = 0; offset < fixture.length;) { const bytes = fixture.subarray(offset, Math.min(offset + 512 * 1024, fixture.length)); await ui.evaluate(`window.__TAURI__.core.invoke('attachment_chunk',{id:${JSON.stringify(id)},offset:${offset},data:${JSON.stringify(bytes.toString('base64'))}})`); offset += bytes.length; }
  const finished = await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(id)}})`);
  check('stage multi-chunk attachment', finished.id === id && finished.kind === 'file');
  check('Stop before a native flight preserves staged draft ownership', (await ui.evaluate("window.__TAURI__.core.invoke('chat_stop')")).includes(id)&&!!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(id)}})`));
  // Page synchronization must retain a draft staged before a lazy chat open/new.
  await site.evaluate(`window.__qchat.openConversation=async()=>{};window.__qchat.newChat=async()=>{}`);
  for (const [command, args] of [['chat_open', {conversationId:'fixture-conversation',preserveUploads:true}], ['chat_new', {preserveUploads:true}]]) {
    await ui.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
    const retained = await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(id)}})`);
    check(`${command} page synchronization retains staged attachment`, retained.id === id);
  }
  check('reject staged filename traversal', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'../../escape.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`)));
  const removed = await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'remove.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_remove',{id:${JSON.stringify(removed.id)}})`);
  check('reject removed attachment token', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_chunk',{id:${JSON.stringify(removed.id)},offset:0,data:''})`)));

  await site.evaluate(`(()=>{const f=document.createElement('input');f.type='file';f.id='qchat-fixture-upload';document.body.append(f);window.__qchat.attachmentInput=async()=> '#qchat-fixture-upload';window.__qchat.send=p=>window.__QCHAT_EMIT__({type:'error',id:p.id,code:'send_failed'})})()`);
  await ui.evaluate(`window.__TAURI__.core.invoke('chat_send',{id:'failed-upload',prompt:'fixture',attachmentIds:[${JSON.stringify(id)}]})`);
  await sleep(300);
  check('error retains quota', await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'quota.txt',mime:'text/plain',size:536870912,uploadGeneration:${uploadGeneration}})`)));
  check('error retains staged file', !!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(id)}})`));
  await site.call('Page.reload');
  for(let i=0;i<80;i++){if(await site.evaluate('!!window.__qchat'))break;await sleep(250);}
  await site.evaluate(`(()=>{const f=document.createElement('input');f.type='file';f.id='qchat-fixture-upload';f.hidden=true;document.body.append(f);window.__qchat.attachmentInput=async()=> '#qchat-fixture-upload';window.__qchat.send=async p=>{const file=document.querySelector('#qchat-fixture-upload').files[0];const b=new Uint8Array(await file.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000));window.__qchatFixtureSent={name:file.name,type:file.type,b64:btoa(s),count:1};await window.__QCHAT_EMIT__({type:'done',id:p.id})}})()`);
  await ui.evaluate(`window.__TAURI__.core.invoke('chat_send',{id:'native-media-fixture',prompt:'fixture',attachmentIds:[${JSON.stringify(id)}]})`);
  let uploaded = null;
  for (let i = 0; i < 40; i++) { uploaded = await site.evaluate(`(()=>{const f=document.querySelector('#qchat-fixture-upload')?.files?.[0],s=window.__qchatFixtureSent;return f?{name:f.name,type:f.type,count:s?.count||0}:null})()`); if (uploaded?.count === 1) break; await sleep(250); }
  // Compare inside the page to avoid returning or printing fixture bytes.
  const parity = await site.evaluate(`(()=>{const f=document.querySelector('#qchat-fixture-upload')?.files?.[0],sent=window.__qchatFixtureSent;return !!f&&!!sent&&f.name==='資料 🧪.txt'&&f.type==='text/plain'&&sent.name===f.name&&sent.type===f.type&&sent.b64===${JSON.stringify(expected)}&&sent.count===1})()`);
  check('CDP staged bytes reach actual site file input exactly once before terminal', parity && uploaded?.name === '資料 🧪.txt' && uploaded?.type === 'text/plain' && uploaded?.count === 1);
  await sleep(300);
  const capacityId = await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'capacity-check.txt',mime:'text/plain',size:536870912,uploadGeneration:${uploadGeneration}}).catch(()=>null)`);
  check('terminal event releases staged attachment quota', !!capacityId?.id);
  if (capacityId?.id) await ui.evaluate(`window.__TAURI__.core.invoke('attachment_remove',{id:${JSON.stringify(capacityId.id)}})`);
  await site.evaluate("document.querySelector('#qchat-fixture-upload')?.remove();delete window.__qchatFixtureSent");
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_remove',{id:${JSON.stringify(id)}})`);

  // A synchronous dispatch failure retains bytes, then transfers exclusive
  // ownership. Old terminal events cannot affect the new native flight.
  const retryFile=await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'retry.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(retryFile.id)}})`);
  await site.evaluate("(()=>{const input=document.createElement('input');input.type='file';input.id='qchat-fixture-upload';input.hidden=true;document.body.append(input);window.__qchat.send=()=>{window.__dispatchThrew=true;throw Error('fixture dispatch failed')}})()");
  check('dispatch exception rejects send',await safeError(ui.evaluate(`window.__TAURI__.core.invoke('chat_send',{id:'dispatch-failed',prompt:'fixture',attachmentIds:[${JSON.stringify(retryFile.id)}]})`))&&await site.evaluate('window.__dispatchThrew===true'));
  check('failed dispatch retains its staged bytes',!!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(retryFile.id)}})`));
  await site.evaluate("window.__qchat.send=p=>{window.__retrySent=p.id}");
  await ui.evaluate(`window.__TAURI__.core.invoke('chat_send',{id:'retry-active',prompt:'fixture',attachmentIds:[${JSON.stringify(retryFile.id)}]})`);
  await site.evaluate("(async()=>{for(const type of ['done','error'])await window.__QCHAT_EMIT__({type,id:'dispatch-failed',code:'send_failed'})})()");
  check('stale native terminal leaves retry file and flight owned',!!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(retryFile.id)}})`)&&await site.evaluate("window.__retrySent==='retry-active'")&&await safeError(ui.evaluate("window.__TAURI__.core.invoke('chat_send',{id:'should-be-busy',prompt:'fixture'})")));
  await ui.evaluate("window.__TAURI__.core.invoke('chat_stop')");
  check('native Stop releases active retry bytes',await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(retryFile.id)}})`)));

  const orphan=await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'orphan.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(orphan.id)}})`);
  await site.evaluate("window.__qchat.send=p=>{window.__QCHAT_EMIT__({type:'error',id:p.id,code:'timeout'})}");
  await ui.evaluate(`window.__TAURI__.core.invoke('chat_send',{id:'reload-retained',prompt:'fixture',attachmentIds:[${JSON.stringify(orphan.id)}]})`);
  await sleep(100);
  await ui.call('Page.reload');
  for(let i=0;i<80;i++){try{if(await ui.evaluate("!!window.QSettings&&document.readyState==='complete'"))break}catch{}await sleep(100)}
  const previousGeneration=uploadGeneration;
  uploadGeneration=(await ui.evaluate("window.__TAURI__.core.invoke('launch_info')")).uploadGeneration;
  check('main reload releases unreachable retry bytes and changes upload session',uploadGeneration>previousGeneration&&await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(orphan.id)}})`)));
  check('queued old-document begin cannot create orphan files',await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'late-old.txt',mime:'text/plain',size:0,uploadGeneration:${previousGeneration}})`)));
  const currentFile=await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'current.txt',mime:'text/plain',size:536870912,uploadGeneration:${uploadGeneration}})`);
  check('main reload restores full upload quota for new session',!!currentFile.id);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_remove',{id:${JSON.stringify(currentFile.id)}})`);

  const racing=await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'racing.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(racing.id)}})`);
  await site.evaluate("window.__lateDispatches=0;window.__qchat.send=()=>{window.__lateDispatches++};window.__qchat.attachmentInput=()=>{window.__inputWaiting=true;return new Promise(resolve=>{window.__releaseInput=()=>resolve('#qchat-fixture-upload')})}");
  await ui.evaluate(`window.__racingSend=window.__TAURI__.core.invoke('chat_send',{id:'reload-attaching',prompt:'fixture',attachmentIds:[${JSON.stringify(racing.id)}]}).catch(()=>{});true`);
  for(let i=0;i<80;i++){if(await site.evaluate('window.__inputWaiting===true'))break;await sleep(50)}
  await ui.call('Page.reload');
  for(let i=0;i<80;i++){try{if(await ui.evaluate("!!window.QSettings&&document.readyState==='complete'"))break}catch{}await sleep(100)}
  await site.evaluate('window.__releaseInput()');await sleep(500);
  check('main reload cancels an in-flight attach before provider dispatch',await site.evaluate('window.__lateDispatches===0')&&await safeError(ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(racing.id)}})`)));
  uploadGeneration=(await ui.evaluate("window.__TAURI__.core.invoke('launch_info')")).uploadGeneration;

  const unsent=await ui.evaluate(`window.__TAURI__.core.invoke('attachment_begin',{name:'unsent.txt',mime:'text/plain',size:0,uploadGeneration:${uploadGeneration}})`);
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(unsent.id)}})`);
  await site.evaluate('window.__inputWaiting=false;window.__qchat.newChat=async()=>{};window.__qchat.openConversation=async()=>{}');
  await ui.evaluate(`window.__earlyStopped=false;window.__TAURI__.core.invoke('chat_send',{id:'stop-before-dispatch',prompt:'fixture',attachmentIds:[${JSON.stringify(unsent.id)}]}).catch(()=>{window.__earlyStopped=true});true`);
  for(let i=0;i<80;i++){if(await site.evaluate('window.__inputWaiting===true'))break;await sleep(50)}
  const keptDrafts=await ui.evaluate("window.__TAURI__.core.invoke('chat_stop')");
  await site.evaluate('window.__releaseInput()');
  for(let i=0;i<80;i++){if(await ui.evaluate('window.__earlyStopped'))break;await sleep(50)}
  check('Stop before dispatch preserves original draft bytes and reports their ownership',Array.isArray(keptDrafts)&&keptDrafts.includes(unsent.id)&&!!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(unsent.id)}})`)&&await ui.evaluate('window.__earlyStopped')&&await site.evaluate('window.__lateDispatches===0'));
  await ui.evaluate(`window.__TAURI__.core.invoke('attachment_remove',{id:${JSON.stringify(unsent.id)}})`);

  await site.evaluate('window.__inputWaiting=false');
  await ui.evaluate("(()=>{const data=new DataTransfer();data.items.add(new File(['draft bytes'],'ui-stop.txt',{type:'text/plain'}));const input=document.getElementById('attachment-input');input.files=data.files;input.dispatchEvent(new Event('change'))})()");
  for(let i=0;i<80;i++){if(await ui.evaluate("!!document.querySelector('#attachments [data-state=ready]')"))break;await sleep(50)}
  await ui.evaluate("(()=>{const input=document.getElementById('prompt-input');input.value='preserve UI draft';input.dispatchEvent(new Event('input'));document.getElementById('btn-send').click()})()");
  for(let i=0;i<80;i++){if(await site.evaluate('window.__inputWaiting===true'))break;await sleep(50)}
  await ui.evaluate("document.getElementById('btn-send').click()");await sleep(150);
  await site.evaluate('window.__releaseInput()');
  for(let i=0;i<80;i++){if(await ui.evaluate("!document.querySelector('#bubble-zone [data-role=assistant]')&&document.getElementById('prompt-input').value==='preserve UI draft'"))break;await sleep(50)}
  const uiDraftIds=await ui.evaluate("window.__TAURI__.core.invoke('chat_stop')");
  check('real UI Stop before acceptance restores draft and preserves its file chip and bytes',uiDraftIds.length===1&&await ui.evaluate("document.getElementById('prompt-input').value==='preserve UI draft'&&!!document.querySelector('#attachments [data-state=ready]')&&!document.querySelector('#bubble-zone [data-role=assistant]')")&&!!await ui.evaluate(`window.__TAURI__.core.invoke('attachment_finish',{id:${JSON.stringify(uiDraftIds[0])}})`));
  await ui.evaluate("document.querySelector('#attachments .attachment-chip .icon-btn').click()");

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  await site.evaluate(`window.__qchat.resolveMedia=async()=>({url:'data:image/png;base64,${png}',name:'test.png',kind:'image',mime:'image/png'})`);
  const media = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-image'})");
  check('media load returns local broker URL', /^http:\/\/qchat-media\.localhost\/[0-9a-f-]{36}$/.test(media.src) && media.mime === 'image/png');
  const broker = await ui.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(media.src)});return {status:r.status,type:r.headers.get('content-type'),bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}})()`);
  check('broker serves exact media bytes and MIME', broker.status === 200 && broker.type === 'image/png' && Buffer.from(broker.bytes).toString('base64') === png);
  const range = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(media.src)},{headers:{Range:'bytes=0-3'}});return {status:r.status,cr:r.headers.get('content-range'),b:Array.from(new Uint8Array(await r.arrayBuffer()))}}catch(e){return {error:String(e)}}})()`);
  check('broker byte range', range.status === 206 && /^bytes 0-3\//.test(range.cr) && Buffer.from(range.b).toString('base64') === Buffer.from(png,'base64').subarray(0,4).toString('base64'), range.error ? 'fetch rejected' : `status ${range.status}, content-range ${range.cr || 'hidden'}, bytes ${range.b?.length ?? 0}`);
  const invalid = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(media.src)},{headers:{Range:'bytes=999-'}});return r.status}catch{return 0}})()`);
  check('broker rejects invalid range', invalid === 416, `status ${invalid}`);
  const head = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(media.src)},{method:'HEAD'});return {status:r.status,len:r.headers.get('content-length'),body:(await r.arrayBuffer()).byteLength}}catch(e){return {error:String(e)}}})()`);
  check('broker HEAD has length and no body', head.status === 200 && Number(head.len) === Buffer.from(png,'base64').length && head.body === 0, head.error ? 'fetch rejected' : `status ${head.status}`);
  const image = await ui.evaluate(`new Promise(resolve=>{const i=new Image();i.onload=()=>resolve(i.naturalWidth);i.onerror=()=>resolve(0);i.src=${JSON.stringify(media.src)}})`);
  check('broker image renders', image === 1);
  const refreshed=await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-image',revision:2})");
  const replaced=await ui.evaluate(`Promise.all([fetch(${JSON.stringify(media.src)}).then(r=>r.status),fetch(${JSON.stringify(refreshed.src)}).then(r=>r.status)])`);
  check('new image revision replaces cached preview without retaining old URL',refreshed.src!==media.src&&replaced[0]===404&&replaced[1]===200);
  const first = await ui.evaluate("window.__TAURI__.core.invoke('media_save',{mediaId:'fixture-image'})");
  const second = await ui.evaluate("window.__TAURI__.core.invoke('media_save',{mediaId:'fixture-image'})");
  const dl = path.join(profile, 'Downloads');
  check('media save does not overwrite', first === 'test.png' && second === 'test (1).png' && readFileSync(path.join(dl, first)).toString('base64') === png && readFileSync(path.join(dl, second)).toString('base64') === png);
  const blobUrl = await site.evaluate(`(()=>{const raw=atob('${png}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));window.__qchatFixtureBlob=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));window.__qchat.resolveMedia=async()=>({url:window.__qchatFixtureBlob,name:'blob-test.png',kind:'image',mime:'image/png'});return window.__qchatFixtureBlob})()`);
  const tree = await site.call('Page.getFrameTree');
  await site.call('Network.enable');
  async function probeResource(url) {
    try {
      const result = await site.call('Network.loadNetworkResource', { frameId: tree.frameTree.frame.id, url, options: { disableCache: true, includeCredentials: true } });
      const resource = result.resource || {};
      if (!resource.success || !resource.stream) return { ok: false, status: resource.statusCode ?? 0, bytes: 0, error: 'no resource stream' };
      let bytes = 0;
      try {
        for (;;) { const packet = await site.call('IO.read', { handle: resource.stream, size: 512 * 1024 }); bytes += packet.base64Encoded ? Buffer.from(packet.data, 'base64').length : Buffer.byteLength(packet.data || ''); if (packet.eof) break; }
        return { ok: true, status: resource.statusCode ?? 0, bytes, error: '' };
      } finally { try { await site.call('IO.close', { handle: resource.stream }); } catch {} }
    } catch (e) { return { ok: false, status: 0, bytes: 0, error: String(e.message || e).slice(0, 110) }; }
  }
  const blobProbe = await probeResource(blobUrl);
  const siteIcon = await site.evaluate("document.querySelector('link[rel~=\\\"icon\\\"]')?.href||''");
  const httpsProbe = siteIcon ? await probeResource(siteIcon) : { ok: false, status: 0, bytes: 0, error: 'site icon unavailable' };
  check('direct CDP resource diagnostic', true, `blob=${blobProbe.ok ? `ok/${blobProbe.status}/${blobProbe.bytes}B` : `error/${blobProbe.error}`} site-icon=${httpsProbe.ok ? `ok/${httpsProbe.status}/${httpsProbe.bytes}B` : `error/${httpsProbe.error}`}`);
  const blobMedia = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-blob'}).catch(e=>({__error:String(e)}))");
  let blobBody = null;
  if (blobMedia && !blobMedia.__error) blobBody = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(blobMedia.src)});return {status:r.status,type:r.headers.get('content-type'),bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}}catch(e){return {error:String(e)}}})()`);
  const blobFailure = String(blobMedia?.__error || blobBody?.error || '').replace(/(?:https?|blob):\S+/g, '[url]').slice(0, 140);
  check('CDP Network.loadNetworkResource streams blob media', blobUrl.startsWith('blob:https://chatgpt.com/') && blobMedia?.mime === 'image/png' && blobBody?.status === 200 && blobBody?.type === 'image/png' && Buffer.from(blobBody?.bytes || []).toString('base64') === png, blobFailure);
  await site.evaluate('URL.revokeObjectURL(window.__qchatFixtureBlob);delete window.__qchatFixtureBlob');
  if (siteIcon) {
    await site.evaluate(`window.__qchat.resolveMedia=async()=>({url:${JSON.stringify(siteIcon)},name:'site-icon',kind:'image'})`);
    const iconMedia = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-public-icon'}).catch(e=>({__error:String(e)}))");
    let iconBody = null;
    if (iconMedia && !iconMedia.__error) iconBody = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(iconMedia.src)});const b=await r.arrayBuffer();return {status:r.status,type:r.headers.get('content-type'),bytes:b.byteLength}}catch(e){return {error:String(e)}}})()`);
    const safeIconMime = ['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','image/x-icon','image/vnd.microsoft.icon','application/octet-stream'].includes(iconMedia?.mime);
    check('public site icon loads through native media broker', !!httpsProbe.bytes && safeIconMime && iconBody?.status === 200 && iconBody.bytes > 0, iconMedia?.__error ? 'native media load rejected' : iconBody?.error ? 'broker fetch rejected' : `bytes=${iconBody?.bytes ?? 0} safeMime=${safeIconMime}`);
  } else check('public site icon loads through native media broker', false, 'site icon unavailable');
  for (const bad of ['javascript:alert(1)','file:///C:/private','https://localhost/x','data:image/svg+xml;base64,PHN2Zz4=']) {
    await site.evaluate(`window.__qchat.resolveMedia=async()=>({url:${JSON.stringify(bad)},name:'bad.png',mime:'image/png'})`);
    check(`reject unsafe media source ${bad.split(':')[0]}`, await safeError(ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'unsafe-fixture'})")));
  }
  const csv = 'id,name\n1,synthetic fixture\n2,Unicode café 🧪\n';
  await site.evaluate(`(()=>{window.__qchat.resolveMedia=async()=>{throw new Error('synthetic resolver fallback')};window.__qchat.mediaInfo=()=>({kind:'file',name:'fixture.csv',mime:'text/csv'});window.__qchat.activateMedia=async()=>{const b=new Blob([${JSON.stringify(csv)}],{type:'text/csv'});window.__qchatFixtureCsv=URL.createObjectURL(b);const a=document.createElement('a');a.href=window.__qchatFixtureCsv;a.download='fixture.csv';document.body.append(a);a.click();a.remove();return {kind:'file',name:'fixture.csv',mime:'text/csv'}}})()`);
  const csvMedia = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-site-download'}).catch(e=>({__error:String(e)}))");
  let csvBody = null;
  if (csvMedia && !csvMedia.__error) csvBody = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(csvMedia.src)});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000));return {status:r.status,type:r.headers.get('content-type'),b64:btoa(s)}}catch(e){return {error:String(e)}}})()`);
  const csvExact = Buffer.from(csv, 'utf8').toString('base64');
  check('site download fallback captures exact synthetic CSV', !!csvMedia?.src && csvMedia.mime === 'text/csv' && csvBody?.status === 200 && csvBody?.b64 === csvExact, csvMedia?.__error ? 'native download fallback rejected' : csvBody?.error ? 'broker fetch rejected' : `bytes=${csvBody?.b64 ? Buffer.from(csvBody.b64,'base64').length : 0}`);
  const csvFirst = await ui.evaluate("window.__TAURI__.core.invoke('media_save',{mediaId:'fixture-site-download'}).catch(()=>null)");
  const csvSecond = await ui.evaluate("window.__TAURI__.core.invoke('media_save',{mediaId:'fixture-site-download'}).catch(()=>null)");
  const csvSavedExact = !!csvFirst && !!csvSecond && existsSync(path.join(dl,csvFirst)) && existsSync(path.join(dl,csvSecond)) && readFileSync(path.join(dl,csvFirst)).toString('utf8') === csv && readFileSync(path.join(dl,csvSecond)).toString('utf8') === csv;
  check('site download fallback save collision suffix', csvFirst === 'fixture.csv' && csvSecond === 'fixture (1).csv' && csvSavedExact);
  await site.evaluate('if(window.__qchatFixtureCsv)URL.revokeObjectURL(window.__qchatFixtureCsv);delete window.__qchatFixtureCsv');
  const wav = Buffer.alloc(44 + 800);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(800, 40);
  const wav64 = wav.toString('base64');
  const wavUrl = await site.evaluate(`(()=>{const raw=atob('${wav64}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));window.__qchatFixtureWav=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));window.__qchat.resolveMedia=async()=>({url:window.__qchatFixtureWav,name:'fixture.wav',kind:'audio',mime:'audio/wav'});return window.__qchatFixtureWav})()`);
  const wavMedia = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-wav'}).catch(e=>({__error:String(e)}))");
  let wavBroker = null, audioMeta = null;
  if (wavMedia && !wavMedia.__error) {
    wavBroker = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(wavMedia.src)});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000));return {status:r.status,type:r.headers.get('content-type'),b64:btoa(s)}}catch(e){return {error:String(e)}}})()`);
    audioMeta = await ui.evaluate(`new Promise(resolve=>{const a=new Audio();a.preload='metadata';a.autoplay=false;a.onloadedmetadata=()=>resolve({duration:a.duration,autoplay:a.autoplay});a.onerror=()=>resolve({error:true,autoplay:a.autoplay});a.src=${JSON.stringify(wavMedia.src)};a.load();setTimeout(()=>resolve({timeout:true,autoplay:a.autoplay}),5000)})`);
  }
  check('silent WAV media loads without autoplay', wavUrl.startsWith('blob:https://chatgpt.com/') && wavMedia?.mime === 'audio/wav' && wavBroker?.status === 200 && wavBroker?.type === 'audio/wav' && wavBroker?.b64 === wav64 && Math.abs((audioMeta?.duration || 0) - 0.1) < 0.01 && audioMeta?.autoplay === false, wavMedia?.__error ? 'native media load rejected' : audioMeta?.error || audioMeta?.timeout ? 'audio metadata unavailable' : `duration=${audioMeta?.duration ?? 0}`);
  await site.evaluate('if(window.__qchatFixtureWav)URL.revokeObjectURL(window.__qchatFixtureWav);delete window.__qchatFixtureWav');
  const webmPath = path.join(profile, 'fixture.webm');
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=64x64:r=5:d=0.2','-an','-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-b:v','0','-crf','50','-threads','1','-y',webmPath], { stdio: 'ignore', windowsHide: true });
  if (ffmpeg.status !== 0 || !existsSync(webmPath)) throw Error('Bounded VP9 fixture generation failed.');
  const webm64 = readFileSync(webmPath).toString('base64');
  const webmUrl = await site.evaluate(`(()=>{const raw=atob('${webm64}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));window.__qchatFixtureWebm=URL.createObjectURL(new Blob([bytes],{type:'video/webm'}));window.__qchat.resolveMedia=async()=>({url:window.__qchatFixtureWebm,name:'fixture.webm',kind:'video',mime:'video/webm'});return window.__qchatFixtureWebm})()`);
  const videoMedia = await ui.evaluate("window.__TAURI__.core.invoke('media_load',{mediaId:'fixture-video'}).catch(e=>({__error:String(e)}))");
  let videoBroker = null, videoMeta = null, videoRange = null;
  if (videoMedia && !videoMedia.__error) {
    videoBroker = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(videoMedia.src)});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000));return {status:r.status,type:r.headers.get('content-type'),b64:btoa(s)}}catch(e){return {error:String(e)}}})()`);
    videoRange = await ui.evaluate(`(async()=>{try{const r=await fetch(${JSON.stringify(videoMedia.src)},{headers:{Range:'bytes=0-7'}});return {status:r.status,range:r.headers.get('content-range'),bytes:(await r.arrayBuffer()).byteLength}}catch(e){return {error:String(e)}}})()`);
    videoMeta = await ui.evaluate(`new Promise(resolve=>{const v=document.createElement('video');v.preload='metadata';v.autoplay=false;v.onloadedmetadata=()=>resolve({duration:v.duration,width:v.videoWidth,height:v.videoHeight,autoplay:v.autoplay});v.onerror=()=>resolve({error:true,autoplay:v.autoplay});v.src=${JSON.stringify(videoMedia.src)};v.load();setTimeout(()=>resolve({timeout:true,autoplay:v.autoplay}),7000)})`);
  }
  check('silent VP9 WebM media loads without autoplay', webmUrl.startsWith('blob:https://chatgpt.com/') && videoMedia?.mime === 'video/webm' && videoBroker?.status === 200 && videoBroker?.type === 'video/webm' && videoBroker?.b64 === webm64 && videoRange?.status === 206 && /^bytes 0-7\//.test(videoRange?.range || '') && videoRange?.bytes === 8 && Math.abs((videoMeta?.duration || 0) - 0.2) < 0.05 && videoMeta?.width === 64 && videoMeta?.height === 64 && videoMeta?.autoplay === false, videoMedia?.__error ? 'native media load rejected' : videoMeta?.error || videoMeta?.timeout ? 'video metadata unavailable' : `duration=${videoMeta?.duration ?? 0} size=${videoMeta?.width ?? 0}x${videoMeta?.height ?? 0}`);
  await site.evaluate('if(window.__qchatFixtureWebm)URL.revokeObjectURL(window.__qchatFixtureWebm);delete window.__qchatFixtureWebm');
} catch (e) { check('harness', false, String(e.message || e).slice(0, 220)); }
finally {
  try { await site?.evaluate("document.querySelector('#qchat-fixture-upload')?.remove()"); } catch {}
  ui?.close(); site?.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile), temp = path.resolve(tmpdir());
  if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('qchat-native-media-')) { try { rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
