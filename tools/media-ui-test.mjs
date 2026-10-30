// Synthetic UI regression checks in an isolated, invisible Edge profile. No account/site access.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-media-ui-'));
const server = createServer(async (req, res) => {
  const relative = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404).end(); return; }
  try { const bytes = await readFile(path.join(root, 'ui', relative)); res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'); res.end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const app = spawn(process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let ws;
let failed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error('Headless Edge did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0;
  const pending = new Map();
  ws.onmessage = e => { const result = JSON.parse(e.data); if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id); } else if(result.method==='Fetch.requestPaused') cdp('Fetch.fulfillRequest',{requestId:result.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Access-Control-Allow-Origin',value:'*'}],body:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='}).catch(()=>{}); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, d => d.error ? reject(new Error(d.error.message)) : resolve(d.result)); ws.send(JSON.stringify({ id, method, params })); });
  const evalJS = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result.description);
    return result.result.value;
  };
  await cdp('Page.enable');
  // Exits finish at once, so each check sees only the bubble it is about.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp('Fetch.enable',{patterns:[{urlPattern:'http://qchat-media.localhost/*',requestStage:'Request'}]});
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.test = {calls:[], handlers:{}, files:new Map(), delayBegin:false, delayChunk:false, failSend:false, badSrc:null, next:0};
    test.emit = payload => (test.handlers.bridge || []).forEach(fn => fn({payload}));
    window.__TAURI__ = { event: {listen: async (name, fn) => { (test.handlers[name] ||= []).push(fn); }}, core: {invoke: async (cmd, args={}) => {
      test.calls.push({cmd,args});
      if(cmd==='chat_status') { test.emit({type:'status',ready:true,loggedIn:false,url:'https://chatgpt.com/'}); return; }
      if(cmd==='get_theme') return {dark:true};
      if(cmd==='attachment_begin') { const file={...args,id:'file-'+(++test.next),offset:0}; test.files.set(file.id,file); if(test.delayBegin) await new Promise(r=>test.releaseBegin=r); return file; }
      if(cmd==='attachment_chunk') { if(test.delayChunk) await new Promise(r=>test.releaseChunk=r); const file=test.files.get(args.id); const size=atob(args.data).length; if(size>524288 || args.offset!==file.offset) throw Error('bad chunk'); file.offset+=size; return; }
      if(cmd==='attachment_finish') {const f=test.files.get(args.id); if(f.offset!==f.size) throw Error('incomplete'); return f;}
      if(cmd==='attachment_remove') {test.files.delete(args.id); return;}
      if(cmd==='chat_send') {if(test.delaySend) await new Promise((_,reject)=>test.rejectSend=()=>reject(Error('cancelled'))); if(test.failSend) throw Error('synthetic rejection'); test.turn=args.id; for(const id of args.attachmentIds || []) test.files.delete(id); return;}
      if(cmd==='media_load') return {id:args.mediaId, kind:test.mediaKind || 'image', mime:test.mime || 'image/png', src:test.badSrc || 'http://qchat-media.localhost/opaque_123'};
      if(cmd==='media_save' && test.failSave) throw Error('synthetic save failure');
    }}};
  ` });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 80; i++) { if (await evalJS(`!!window.test?.handlers.bridge`)) break; await sleep(50); }
  const results = await evalJS(`(async()=>{
    const results=[]; const check=(name,ok)=>results.push({name,ok:!!ok});
    const $=id=>document.getElementById(id); const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await wait(10);}throw Error('UI wait timed out');};
    const files=(name,size=1)=>{const data=new DataTransfer(); data.items.add(new File([new Uint8Array(size)],name,{type:'application/octet-stream'})); $('attachment-input').files=data.files; $('attachment-input').dispatchEvent(new Event('change'));};
    const remove=()=>document.querySelector('#attachments button').click();
    const reset=async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await wait(30);};
    const event=(type,more={})=>test.emit({type,id:test.turn,...more});
    $('prompt-input').value='look something up'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(20);
    check('tool status stays hidden until real activity arrives',document.querySelector('.tool-activity').hidden);
    event('activity',{kind:'search',state:'running'}); await wait(40);
    const activity=document.querySelector('.tool-activity');
    check('search activity reveals response before text',!activity.hidden && activity.textContent.includes('Searching the web') && !activity.closest('[data-role=assistant]').hidden && !document.querySelector('.image-generation:not([hidden])'));
    check('search shows accessible status and indeterminate bar',activity.getAttribute('role')==='status' && !!activity.querySelector('.tool-activity-track') && activity.getAttribute('aria-live')==='polite');
    check('reduced motion keeps activity static',getComputedStyle(activity.querySelector('.progress-ring')).animationName==='none' && getComputedStyle(activity.querySelector('.tool-activity-track'),'::after').animationName==='none');
    const previousMotion=document.documentElement.dataset.motion; document.documentElement.dataset.motion='on'; await wait(40);
    const scanStart=getComputedStyle(activity.querySelector('.tool-activity-track'),'::after').transform; await wait(120);
    check('search bar animates when motion is enabled',getComputedStyle(activity.querySelector('.tool-activity-track'),'::after').transform!==scanStart);
    document.documentElement.dataset.motion=previousMotion;
    event('delta',{text:'Checking a result…'}); await wait(40);
    event('activity',{kind:'browse',state:'running'}); await wait(30);
    check('activity updates without replacing streamed text or status node',document.querySelector('.tool-activity')===activity && activity.textContent.includes('Reading sources') && document.querySelector('.turn-content').textContent.includes('Checking'));
    event('activity',{kind:'code',state:'running',label:'<script>secret arguments</script>'}); await wait(30);
    check('tool labels describe activity without raw arguments',activity.textContent.includes('Running code') && !activity.textContent.includes('secret'));
    event('activity',{kind:'code',state:'complete'}); await wait(30);
    check('completed tool call hides its animation',activity.hidden);
    event('activity',{kind:'search',state:'running'}); await wait(30);
    event('done',{text:'Final result'}); await wait(30);
    event('activity',{kind:'search',state:'running'}); await wait(30);
    check('done clears activity and ignores late tool events',activity.hidden);
    await reset(); $('prompt-input').value='tool error'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(20);
    event('activity',{kind:'tool',state:'running'}); await wait(20); event('error',{code:'stream_failed'}); await wait(30);
    check('errors clear tool activity',document.querySelector('.tool-activity').hidden);
    await reset(); $('prompt-input').value='stop tool'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(20);
    event('activity',{kind:'search',state:'running'}); await wait(20); $('btn-send').click(); await wait(30); event('activity',{kind:'search',state:'running'}); await wait(30);
    check('Stop clears tool activity and ignores late events',!document.querySelector('.tool-activity:not([hidden])'));
    await reset(); test.calls.length=0;
    files('<img src=x onerror=alert(1)> 😀.txt',524289);
    check('send disabled during staging',$('btn-send').disabled);
    await until(()=>document.querySelector('#attachments [data-state=ready]'));
    check('filename text only and emoji intact',!document.querySelector('#attachments img') && $('attachments').textContent.includes('😀'));
    const chunks=test.calls.filter(c=>c.cmd==='attachment_chunk');
    check('bounded sequential chunks',chunks.length===2 && atob(chunks[0].args.data).length===524288 && chunks[1].args.offset===524288);
    $('btn-send').click(); await wait(20);
    const sent=test.calls.filter(c=>c.cmd==='chat_send').at(-1);
    check('attachments-only send',sent.args.prompt==='' && sent.args.attachmentIds.length===1 && document.querySelector('[data-role=user] .attachment-chip'));
    $('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    check('double send prevented',test.calls.filter(c=>c.cmd==='chat_send').length===1);
    event('delta',{text:'Hello 😀 👩🏽‍💻 é <script>bad()</script>'}); await wait(70);
    check('emoji and escaped response',document.querySelector('[data-role=assistant] .turn-content').textContent.includes('👩🏽‍💻') && !document.querySelector('.turn-content script'));
    test.mediaKind='audio'; test.mime='audio/mpeg';
    event('media',{items:[{id:'audio1',kind:'audio',name:'<script>audio</script>'}]});
    document.querySelector('.media-actions button').click(); await wait(30);
    const audio=document.querySelector('audio');
    check('audio explicit controls no autoplay',audio && audio.controls && audio.preload==='none' && !audio.autoplay);
    event('delta',{text:'More 😀'}); event('media',{items:[{id:'audio1',kind:'audio',name:'duplicate'}]}); await wait(70);
    check('media survives deltas and duplicate events',document.querySelector('audio')===audio && document.querySelectorAll('.media-card').length===1);
    event('error',{code:'stream_failed'}); await wait(20);
    check('partial response kept on error',document.querySelector('[data-role=assistant] .turn-content').textContent.includes('More 😀'));
    test.failSave=true; document.querySelectorAll('.media-actions button')[1].click(); await wait(20);
    check('download failure fallback',document.querySelector('.media-status').textContent.includes('Could not save') && document.querySelector('.media-actions').textContent.includes('View in ChatGPT'));
    await reset();
    test.delayBegin=true; files('cancel-before-id'); await until(()=>test.releaseBegin); remove(); test.releaseBegin(); test.delayBegin=false; await wait(50);
    check('cancel before begin response discards token',test.files.size===0 && !document.querySelector('#attachments .attachment-chip'));
    test.delayChunk=true; files('cancel-in-chunk',524290); await until(()=>test.releaseChunk); const cancelId=test.calls.filter(c=>c.cmd==='attachment_begin').at(-1); remove(); test.releaseChunk(); test.delayChunk=false; await wait(50);
    check('cancel in-flight chunk prevents finish',!test.calls.some(c=>c.cmd==='attachment_finish' && c.args.id==='file-3') && !test.files.has('file-3'));
    files('new-chat'); await until(()=>document.querySelector('#attachments [data-state=ready]')); await reset();
    check('new chat discards ready tokens',!test.files.has('file-4') && $('attachments').hidden);
    const pasted=new DataTransfer(); pasted.items.add(new File(['paste'],'paste.png',{type:'image/png'}));
    $('prompt-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:pasted,cancelable:true}));
    await until(()=>document.querySelector('#attachments [data-state=ready]'));
    check('clipboard files stage',document.querySelector('#attachments').textContent.includes('paste.png'));
    await reset();
    const dropped=new DataTransfer(); dropped.items.add(new File(['drop'],'drop.txt'));
    $('stack').dispatchEvent(new DragEvent('drop',{dataTransfer:dropped,cancelable:true,bubbles:true}));
    await until(()=>document.querySelector('#attachments [data-state=ready]'));
    check('DOM drop files stage',document.querySelector('#attachments').textContent.includes('drop.txt'));
    await reset();
    files('retry.txt'); await until(()=>document.querySelector('#attachments [data-state=ready]')); test.failSend=true;
    $('prompt-input').value='keep draft'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(30);
    check('failed send keeps draft and attachments',$('prompt-input').value==='keep draft' && !!document.querySelector('#attachments [data-state=ready]'));
    test.failSend=false; await reset(); $('prompt-input').value='security'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(20);
    const bad=['javascript:alert(1)','file:///x','blob:http://qchat-media.localhost/a','https://example.com/a','http://qchat-media.localhost.evil/a','http://qchat-media.localhost/a?secret=x','http://qchat-media.localhost/a/b','http://qchat-media.localhost:80/a'];
    test.mediaKind='image'; test.mime='image/png';
    for(let i=0;i<bad.length;i++){test.badSrc=bad[i]; event('media',{items:[{id:'bad'+i,kind:'image',name:'unsafe'}]}); await wait(5);}
    check('untrusted URL previews rejected',!document.querySelector('.media-preview img'));
    test.badSrc=null;
    for(const mime of ['image/svg+xml','text/html','application/octet-stream']){test.mime=mime;event('media',{items:[{id:mime,kind:'image',name:'unknown'}]});await wait(5);}
    check('SVG HTML and unknown MIME previews rejected',!document.querySelector('.media-preview img'));
    event('delta',{text:'![nice](https://example.com/image.png) [download](sandbox:/mnt/data/report.csv) [safe](https://example.com/)'}); await wait(70);
    check('web images render source links and sandbox downloads keep fallback',document.querySelectorAll('[data-action=view-media]').length===1 && !document.querySelector('.turn-content img') && document.querySelector('.turn-content a').href==='https://example.com/image.png');
    await reset(); $('prompt-input').value='sources'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click(); await wait(20);
    event('delta',{text:'Reported details. <Cite ref="turn1news0"/> Unknown <Cite ref="missing"/>'}); await wait(70);
    event('sources',{items:[{id:'turn1news0',url:'https://example.com/report',title:'Source report'},{id:'bad',url:'javascript:alert(1)',title:'unsafe'}]}); await wait(70);
    const sourceMenu=document.querySelector('.turn-sources');
    check('sources dropdown starts closed and rejects unsafe URLs',sourceMenu && !sourceMenu.open && sourceMenu.querySelectorAll('a').length===1);
    check('citation markup becomes a working numbered link',document.querySelector('.turn-content a')?.href==='https://example.com/report' && !document.querySelector('.turn-content').textContent.includes('<Cite'));
    sourceMenu.querySelector('summary').click(); await wait(30);
    event('sources',{items:[{id:'turn1news0',url:'https://example.com/report',title:'Updated report'}]}); await wait(30);
    check('source updates preserve expanded state without image cards',sourceMenu.open && document.querySelectorAll('.media-card').length===0 && document.querySelector('.image-generation').hidden);
    sourceMenu.querySelector('a').click(); await wait(10);
    check('source opens through native external link handler',test.calls.some(c=>c.cmd==='open_external'&&c.args.url==='https://example.com/report'));
    event('done',{text:'Reported details. <Cite ref="turn1news0"/>'}); await wait(30);
    check('completed source metadata is saved',JSON.parse(localStorage.getItem('qchat.chats')).current.lastSources?.[0]?.url==='https://example.com/report');
    await reset(); files('stopped.txt'); await until(()=>document.querySelector('#attachments [data-state=ready]'));
    test.delaySend=true; $('prompt-input').value='keep stopped draft'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click();
    await until(()=>test.rejectSend); $('btn-send').click(); await wait(30); test.rejectSend(); test.delaySend=false; await wait(70);
    check('Stop before native acceptance removes blank turns and keeps draft/files',!document.querySelector('[data-role=assistant]') && !document.querySelector('[data-role=user]') && $('prompt-input').value==='keep stopped draft' && !!document.querySelector('#attachments [data-state=ready]'));
    await reset();
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    const data=new DataTransfer();data.items.add(new File([bytes],'preview.png',{type:'image/png'}));$('attachment-input').files=data.files;$('attachment-input').dispatchEvent(new Event('change'));
    await until(()=>document.querySelector('#attachments [data-state=ready] img')?.naturalWidth===1);
    check('selected image has decoded thumbnail',!!document.querySelector('#attachments img'));
    document.querySelector('#attachments .image-copy').click();await until(()=>document.querySelector('#attachments .image-copy').textContent==='Copied');
    const copied=test.calls.filter(c=>c.cmd==='image_copy').at(-1);
    check('copy sends decoded image pixels to native clipboard',copied?.args.width===1&&copied?.args.height===1&&atob(copied?.args.rgba||'').length===4);
    $('btn-send').click();await wait(30);await until(()=>document.querySelector('.uploaded-image img')?.naturalWidth===1);
    const uploadURL=document.querySelector('.uploaded-image img').src;
    check('sent image remains visible after pending thumbnail is released',!!document.querySelector('.uploaded-image .image-copy')&&$('attachments').hidden);
    event('image_progress',{state:'generating',percentage:44});await wait(20);
    check('site generation percentage is displayed',document.querySelector('.image-generation:not([hidden]) .image-generation-value')?.textContent==='44%');
    event('image_progress',{state:'generating'});await wait(20);
    check('unknown generation progress shows graphic without invented percentage',!!document.querySelector('.image-generation:not([hidden]) svg')&&document.querySelector('.image-generation-value').textContent==='');
    test.mime='image/png';test.mediaKind='image';const before=test.calls.filter(c=>c.cmd==='media_load').length;
    event('media',{items:[{id:'generated-preview',kind:'image',name:'Generated image',pending:true,revision:0}]});await wait(20);
    check('pending image waits for a usable source',test.calls.filter(c=>c.cmd==='media_load').length===before);
    event('media',{items:[{id:'generated-preview',kind:'image',name:'Generated image',pending:false,revision:1}]});await until(()=>document.querySelector('[data-role=assistant] .media-preview img')?.naturalWidth===1);
    event('media',{items:[{id:'generated-preview',kind:'image',name:'Generated image',pending:false,revision:2}]});await wait(50);
    const loads=test.calls.filter(c=>c.cmd==='media_load'&&c.args.mediaId==='generated-preview');
    check('progressive image refreshes one card with new cache revision',loads.length===2&&loads[0].args.revision===1&&loads[1].args.revision===2&&document.querySelectorAll('[data-role=assistant] .media-card').length===1);
    document.querySelector('[data-role=assistant] .image-copy').click();await until(()=>document.querySelector('[data-role=assistant] .image-copy').textContent==='Copied');
    check('broker image can be copied without a cross-origin canvas error',true);
    event('done');await wait(20);check('generation graphic hides on completion',document.querySelector('.image-generation').hidden);
    await reset();let released=false;try{await fetch(uploadURL);}catch{released=true;}check('new chat releases local image preview URLs',released);
    $('prompt-input').value='Generate an image of a blue circle';$('prompt-input').dispatchEvent(new Event('input'));$('btn-send').click();await wait(20);
    check('explicit image request shows preparation graphic immediately',document.querySelector('.image-generation:not([hidden]) .image-generation-label')?.textContent==='Preparing image…');
    event('sources',{items:[{id:'turn1news0',url:'https://example.com/report',title:'Source report'}]});
    event('done',{text:'Reported details. <Cite ref="turn1news0"/>'}); await wait(50);
    return results;
  })()`);
  await cdp('Page.reload'); await sleep(500);
  results.push({name:'restart restores working citations with sources closed',ok:await evalJS(`!!document.querySelector('.turn-sources:not([open]) a[href="https://example.com/report"]') && document.querySelector('.turn-content a')?.href==='https://example.com/report' && !document.querySelector('.media-card')`)});
  if (process.env.QCHAT_RICH_REPLAY) {
    const replay = JSON.parse(await readFile(process.env.QCHAT_RICH_REPLAY, 'utf8'));
    const richCheck = await evalJS(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await wait(40);
      QSettings.apply(document.documentElement,{...QSettings.settings,animations:'on'});
      const input=document.getElementById('prompt-input'); input.value='Explain the Edge exclusive'; input.dispatchEvent(new Event('input')); document.getElementById('btn-send').click(); await wait(40);
      const samples=[]; const timer=setInterval(()=>samples.push(document.querySelector('[data-role=assistant] .turn-content')?.textContent||''),16);
      for(const event of ${JSON.stringify(replay)}) {test.emit({...event,id:test.turn}); await wait(140);}
      await wait(1500); clearInterval(timer);
      const content=document.querySelector('[data-role=assistant] .turn-content');
      return content.querySelectorAll('h2').length===1 && content.textContent.includes('And honestly, there is more to unpack.') && !content.textContent.includes('And how his') && content.querySelector('a')?.href==='https://example.com/edge' && samples.every(text=>!/<row|<box|<text|AsyncImage/.test(text) && (text.match(/Interpreting the Edge/g)||[]).length<=1);
    })()`);
    results.push({name:'actual bridge DIL events render once through paced UI with corrected text and links',ok:richCheck});
    if (process.env.QCHAT_RICH_SCREENSHOT) {
      const capture = await cdp('Page.captureScreenshot', {format:'png'});
      await writeFile(process.env.QCHAT_RICH_SCREENSHOT, Buffer.from(capture.data,'base64'));
    }
  }
  if (process.env.QCHAT_TEST_SCREENSHOT) {
    const capture = await cdp('Page.captureScreenshot', {format:'png'});
    await writeFile(process.env.QCHAT_TEST_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  if (process.env.QCHAT_ACTIVITY_SCREENSHOT) {
    await evalJS(`(async()=>{ window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await new Promise(r=>setTimeout(r,40)); const input=document.getElementById('prompt-input'); input.value='Search for the latest game news'; input.dispatchEvent(new Event('input')); document.getElementById('btn-send').click(); await new Promise(r=>setTimeout(r,40)); test.emit({type:'activity',id:test.turn,kind:'search',state:'running'}); await new Promise(r=>setTimeout(r,100)); })()`);
    const capture = await cdp('Page.captureScreenshot', {format:'png'});
    await writeFile(process.env.QCHAT_ACTIVITY_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  for (const { name, ok } of results) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++; }
} catch (e) { console.error(e); failed++; }
finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({id:999999,method:'Browser.close'}));
  ws?.close(); server.close(); server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-media-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
