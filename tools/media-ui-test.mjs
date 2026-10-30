// Synthetic UI regression checks in an isolated, invisible Edge profile. No account/site access.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
  ws.onmessage = e => { const result = JSON.parse(e.data); if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, d => d.error ? reject(new Error(d.error.message)) : resolve(d.result)); ws.send(JSON.stringify({ id, method, params })); });
  const evalJS = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result.description);
    return result.result.value;
  };
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.test = {calls:[], handlers:{}, files:new Map(), delayBegin:false, delayChunk:false, failSend:false, badSrc:null, next:0};
    test.emit = payload => (test.handlers.bridge || []).forEach(fn => fn({payload}));
    window.__TAURI__ = { event: {listen: async (name, fn) => { (test.handlers[name] ||= []).push(fn); }}, core: {invoke: async (cmd, args={}) => {
      test.calls.push({cmd,args});
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
    const reset=async()=>{$('btn-new-chat').click(); await wait(30);};
    const event=(type,more={})=>test.emit({type,id:test.turn,...more});
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
    $('chat-view').dispatchEvent(new DragEvent('drop',{dataTransfer:dropped,cancelable:true}));
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
    check('markdown images and sandbox downloads have fallback',document.querySelectorAll('[data-action=view-media]').length===2 && !document.querySelector('.turn-content img') && document.querySelector('.turn-content a').href==='https://example.com/');
    await reset(); files('stopped.txt'); await until(()=>document.querySelector('#attachments [data-state=ready]'));
    test.delaySend=true; $('prompt-input').value='keep stopped draft'; $('prompt-input').dispatchEvent(new Event('input')); $('btn-send').click();
    await until(()=>test.rejectSend); $('btn-send').click(); await wait(30); test.rejectSend(); test.delaySend=false; await wait(70);
    check('Stop before native acceptance removes blank turns and keeps draft/files',!document.querySelector('[data-role=assistant]') && !document.querySelector('[data-role=user]') && $('prompt-input').value==='keep stopped draft' && !!document.querySelector('#attachments [data-state=ready]'));
    return results;
  })()`);
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
