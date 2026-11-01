// Focused captured-selection composer checks in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'qchat-selection-ui-'));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(relative) || relative.includes('..')) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(path.join(root, 'ui', relative));
    res.setHeader('Content-Type', TYPES[path.extname(relative)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const app = spawn(process.env.QCHAT_TEST_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ['--headless=new', '--disable-extensions', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let failed = 0;

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
    const message = JSON.parse(e.data);
    if (message.method === 'Runtime.exceptionThrown') console.error('PAGE ERROR', message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
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
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.test = {
      calls: [], handlers: {}, files: new Map(), finished: [], next: 0,
      png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      snapshotName: 'Snapshot 1.png',
      delaySnapshot: false, rejectSnapshot: false, snapshotError: 'snapshot_failed: no active window',
      autoDone: true
    };
    test.emit = payload => (test.handlers.bridge || []).forEach(fn => fn({ payload }));
    window.__TAURI__ = { event: { listen: async (name, fn) => { (test.handlers[name] ||= []).push(fn); } }, core: { invoke: async (cmd, args = {}) => {
      test.calls.push({ cmd, args });
      if (cmd === 'chat_status') { test.emit({ type: 'status', ready: true, loggedIn: false, url: 'https://chatgpt.com/' }); return null; }
      if (cmd === 'get_theme') return { dark: true };
      if (cmd === 'snapshot_capture') {
        if (test.delaySnapshot) await new Promise((resolve, reject) => {
          test.releaseSnapshot = resolve;
          test.rejectSnapshotNow = () => reject(new Error(test.snapshotError));
        });
        if (test.rejectSnapshot) throw new Error(test.snapshotError);
        return { name: test.snapshotName, mime: 'image/png', data: test.png };
      }
      if (cmd === 'attachment_begin') {
        const file = { ...args, id: 'file-' + (++test.next), offset: 0 };
        test.files.set(file.id, file);
        return file;
      }
      if (cmd === 'attachment_chunk') {
        const file = test.files.get(args.id);
        const size = atob(args.data).length;
        if (!file || size > 524288 || args.offset !== file.offset) throw new Error('bad chunk');
        file.offset += size;
        return null;
      }
      if (cmd === 'attachment_finish') {
        const file = test.files.get(args.id);
        if (!file || file.offset !== file.size) throw new Error('incomplete');
        test.finished.push(args.id);
        return file;
      }
      if (cmd === 'attachment_remove') { test.files.delete(args.id); return null; }
      if (cmd === 'chat_send') {
        if(test.failSelectionSend) throw Error('offline');
        if(test.delaySelectionSend) await new Promise(resolve=>{test.releaseSelectionSend=resolve;});
        if (test.autoDone) setTimeout(() => test.emit({ type: 'done', id: args.id, text: 'ok', conversationId: 'conv-1' }), 10);
        return null;
      }
      return null;
    } } };
  ` });

  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100; i++) { if (await evalJS(`!!window.test?.handlers["qchat://selection"] && !!window.QSettings`)) break; await sleep(50); }

  if (!await evalJS(`!!window.test?.handlers["qchat://selection"]`)) throw new Error("Selection listener did not initialize; see page errors above");

  const results = await evalJS(String.raw`(async () => {
    const results = [];
    const check = (name, ok) => results.push({ name, ok: !!ok });
    const $ = id => document.getElementById(id);
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async fn => { for (let i=0; i<300; i++) { if (fn()) return; await wait(10); } throw Error('UI wait timed out: '+JSON.stringify({sends:sends().length,calls:test.calls.slice(-5).map(c=>c.cmd),statuses:[...document.querySelectorAll('[data-role=assistant]')].map(n=>n.dataset.status),error:$('global-error-text').textContent})); };
    const input = value => { $('prompt-input').value=value; $('prompt-input').dispatchEvent(new Event('input', {bubbles:true})); };
    const selection = text => (test.handlers['qchat://selection'] || []).forEach(fn => fn({payload:text}));
    const chips = () => document.querySelectorAll('#attachments .selection-chip');
    const saved = () => JSON.parse(localStorage.getItem('qchat.chats'));
    const sends = () => test.calls.filter(c => c.cmd==='chat_send');
    const reset = async () => { document.dispatchEvent(new KeyboardEvent('keydown', {key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await wait(40); };
    const secret = 'First private selection <img src=x onerror=alert(1)> 😀' + String.fromCharCode(13,10) + 'Second line';
    input('Explain this');
    $('prompt-input').setSelectionRange(2,4);
    selection(secret);
    check('capture preserves draft and caret', $('prompt-input').value==='Explain this' && $('prompt-input').selectionStart===2 && $('prompt-input').selectionEnd===4);
    check('compact removable selection indicator', chips().length===1 && !chips()[0].querySelector(':scope > .icon') && chips()[0].querySelector('.attachment-name').textContent.includes('First private selection') && !!chips()[0].querySelector('button[aria-label="Remove selection"]'));
    check('captured excerpt renders as literal text', document.body.textContent.includes('First private selection') && !document.querySelector('img[src="x"]'));
    check('selection is saved with its draft', saved().current.selectionTexts[0]===secret);
    selection('Another private selection');
    check('repeated captures attach independently', chips().length===2);
    chips()[1].querySelector('button').click();
    check('remove only the chosen selection', chips().length===1 && saved().current.selectionTexts.length===1);
    selection('   ');
    check('empty capture is ignored',chips().length===1);
    $('btn-send').click();
    await until(()=>sends().length===1 && $('attachments').hidden);
    check('send includes question and all selected text', sends()[0].args.prompt==='Explain this'+String.fromCharCode(10,10)+'> '+secret.replace(/\r\n?/g,'\n').split('\n').join('\n> '));
    check('sent quote sits above question', (()=>{const c=document.querySelector('[data-role="user"] .selection-chip'); const node=c.parentNode.querySelector('.selection-prompt'); const r=document.createRange(); r.selectNodeContents(node); return c.getBoundingClientRect().bottom<=r.getBoundingClientRect().top+1 && !c.querySelector('button');})());
    check('sent message displays question and selection chip', document.querySelector('[data-role="user"] .selection-chip') && document.body.textContent.includes('First private selection'));
    check('successful send consumes only its captured context', saved().current.selectionTexts.length===0 && $('attachments').hidden);
    await until(()=>document.querySelector('[data-action="retry-reply"]:not([hidden])'));
    await wait(250); document.querySelector('[data-action="retry-reply"]').click();
    await until(()=>sends().length===2);
    check('retry reuses selection exactly once', sends()[1].args.prompt===sends()[0].args.prompt);
    await wait(80);
    test.emit({type:'transcript',conversationId:'conv-1',complete:true,messages:[{role:'user',text:sends()[0].args.prompt},{role:'assistant',text:'Account answer'}]});
    await wait(80);
    check('account refresh preserves the collapsed selection', saved().current.transcript[0].text==='Explain this' && saved().current.transcript[0].selectionTexts[0]===secret);
    check('account refresh still updates assistant text',saved().current.transcript[1].text==='Account answer');
    await reset();
    selection('Selection only');
    check('selection-only message can send', !$('btn-send').disabled && $('prompt-input').value==='');
    $('btn-send').click();
    await until(()=>sends().length===3 && $('attachments').hidden);
    check('selection-only wire prompt',sends().at(-1).args.prompt==='> Selection only');
    await wait(40);
    check('selection-only sent turn remains in history', saved().current.transcript.some(t=>t.role==='user' && t.text==='' && t.selectionTexts[0]==='Selection only'));
    await reset();
    input('Keep question'); selection('Keep context'); test.failSelectionSend=true;
    $('btn-send').click();
    await until(()=>document.querySelector('[data-status="error"]'));
    check('failed send keeps question and selection', $('prompt-input').value==='Keep question' && chips().length===1 && saved().current.selectionTexts[0]==='Keep context');
    test.failSelectionSend=false;
    await reset();
    input('Stop question'); selection('Stop context'); test.autoDone=false;
    $('btn-send').click();
    await until(()=>$('attachments').hidden && $('btn-send').dataset.mode==='stop');
    $('btn-send').click();
    await wait(60);
    check('Stop before a reply restores question and context', $('prompt-input').value==='Stop question' && chips().length===1 && saved().current.selectionTexts[0]==='Stop context');
    await reset();
    input('Pending question'); selection('First send context'); test.autoDone=true; test.delaySelectionSend=true;
    const before=sends().length;
    $('btn-send').click();
    await until(()=>!!test.releaseSelectionSend);
    selection('Next question context');
    check('selection removal stays disabled during submission', [...chips()].every(c=>c.querySelector('button').disabled));
    test.releaseSelectionSend(); test.delaySelectionSend=false;
    await until(()=>sends().length===before+1 && chips().length===1);
    check('late capture is reserved for the next question', saved().current.selectionTexts[0]==='Next question context' && !sends().at(-1).args.prompt.includes('Next question context'));
    await wait(80);
    await reset();
    check('new chat has no prior context',chips().length===0 && $('prompt-input').value==='');
    input('Draft to restore'); selection('Draft private context');
    const oldKey=saved().current.key;
    await reset();
    const tab=[...document.querySelectorAll('#tabs [data-chat-key]')].find(t=>t.dataset.chatKey===oldKey);
    if(tab) tab.click();
    else { input('/chats'); $('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await wait(50); const row=[...document.querySelectorAll('.feature-list button')].find(b=>b.textContent.includes('Draft to restore')); row?.click(); }
    await wait(50);
    check('chat switch restores its own selection draft', saved().current.key===oldKey && chips().length===1 && $('prompt-input').value==='Draft to restore');
    (test.handlers['qchat://selection-error'] || []).forEach(fn=>fn({payload:'Could not copy selected text.'}));
    check('capture failure is visible without losing draft', !$('global-error').hidden && $('global-error-text').textContent.includes('Could not copy') && chips().length===1);
    await reset();
    const originalSet=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='qchat.chats' && value.length>130000) throw new DOMException('quota','QuotaExceededError'); return originalSet.call(this,key,value);};
    const large='Large private context '+ 'x'.repeat(120000);
    input('Large selection question'); selection(large);
    $('btn-send').click();
    await until(()=>$('attachments').hidden);
    await wait(80);
    check('storage pressure still sends the complete selection',sends().at(-1).args.prompt.includes(large));
    check('storage fallback persists the latest question and bounded context',saved().current.lastPrompt==='Large selection question' && saved().current.transcript[0].selectionTexts[0].length<=40000 && !!saved().current.transcript[0].selectionMatch);
    test.largeWire=sends().at(-1).args.prompt;
    Storage.prototype.setItem=originalSet;
    return results;
  })()`);

  for (const {name,ok} of results) { console.log((ok?'PASS ':'FAIL ')+name); if(!ok) failed++; }
  const largeWire=await evalJS('test.largeWire');
  await cdp('Page.reload');
  await sleep(300);
  await evalJS(`test.emit({type:'transcript',conversationId:'conv-1',complete:true,messages:[{role:'user',text:${JSON.stringify(largeWire)}},{role:'assistant',text:'Restored answer'}]})`);
  await sleep(100);
  await evalJS(`document.getElementById('btn-history').click()`);
  const restored=await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));return s.current.lastPrompt==='Large selection question' && s.current.transcript[0].text==='Large selection question' && document.querySelector('#history-panel .selection-chip') && document.body.textContent.includes('Large private context');})()`);
  console.log((restored?'PASS ':'FAIL ')+'quota fallback reload keeps account selection collapsed'); if(!restored) failed++;
  await evalJS(`document.getElementById('btn-history').click(); const i=document.getElementById('prompt-input');i.value='Draft to restore';i.dispatchEvent(new Event('input'));for(const fn of test.handlers['qchat://selection']) fn({payload:'Draft private context'});`);
  await cdp('Page.reload'); await sleep(250);
  const draftRestored=await evalJS(`document.getElementById('prompt-input').value==='Draft to restore' && document.querySelectorAll('#attachments .selection-chip').length===1 && document.body.textContent.includes('Draft private context')`);
  console.log((draftRestored?'PASS ':'FAIL ')+'reload restores context and question'); if(!draftRestored) failed++;
  await cdp('Emulation.setDeviceMetricsOverride',{width:580,height:600,deviceScaleFactor:1,mobile:false});
  await sleep(150);
  const geometry = await evalJS(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    QSettings.apply(document.documentElement,{...QSettings.settings,showPrompt:true,userLines:1,barWidth:340,replyWidth:340});
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await wait(100);
    const input=document.getElementById('prompt-input'); input.value='Geometry question'; input.dispatchEvent(new Event('input',{bubbles:true}));
    for(const text of ['Long multiline text '+ 'word '.repeat(150)+'\\nsecond line', 'unbroken'+ 'x'.repeat(1000)]) for(const f of test.handlers['qchat://selection']) f({payload:text});
    const valid=c=>{const n=c.querySelector('.attachment-name'), cs=getComputedStyle(n), r=n.getBoundingClientRect(); return cs.whiteSpace==='nowrap' && cs.textOverflow==='ellipsis' && n.scrollWidth>n.clientWidth && r.height<=parseFloat(cs.lineHeight)+1 && c.getBoundingClientRect().right<=document.documentElement.clientWidth+1;};
    const composer=[...document.querySelectorAll('#attachments .selection-chip')]; const a=composer.length===2 && composer.every(valid);
    document.getElementById('btn-send').click(); await wait(250);
    const sent=[...document.querySelectorAll('.turn-row[data-role="user"] .selection-chip')]; const b=sent.length===2 && sent.every(valid) && sent.every(c=>!c.querySelector('button'));
    const prompt=document.querySelector('#bubble-zone .selection-prompt') || sent[0]?.parentNode.querySelector('.selection-prompt');
    const questionVisible=!!prompt && prompt.textContent==='Geometry question' && prompt.getBoundingClientRect().height>0 && prompt.parentNode.getBoundingClientRect().bottom>=prompt.getBoundingClientRect().bottom && sent.at(-1).getBoundingClientRect().bottom<=prompt.getBoundingClientRect().top+1;
    document.getElementById('btn-history').click(); await wait(100);
    const history=[...document.querySelectorAll('#history-panel .selection-chip')]; const c=history.length===2 && history.every(valid) && history.every(x=>!x.querySelector('button'));
    document.getElementById('btn-history').click();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true})); await wait(100);
    return [a,b,c,document.documentElement.scrollWidth<=document.documentElement.clientWidth,questionVisible];
  })()`);
  for(const [i,name] of ['composer ellipsis at narrow width','sent ellipsis at narrow width','history ellipsis at narrow width','no page horizontal overflow','one-line prompt limit preserves question below multiple quotes'].entries()) { console.log((geometry[i]?'PASS ':'FAIL ')+name); if(!geometry[i]) failed++; }
  await evalJS(`(()=>{const i=document.getElementById('prompt-input'); i.value='Make this sound friendlier'; i.dispatchEvent(new Event('input',{bubbles:true})); for(const f of test.handlers['qchat://selection']) f({payload:'We missed the launch date because the vendor could not deliver the parts on time.'});})()`);
  await sleep(150);
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  const {mkdir,writeFile}=await import('node:fs/promises');
  await mkdir(path.join(root,'.tmp/selection-shots'),{recursive:true});
  await writeFile(path.join(root,'.tmp/selection-shots/composer.png'),Buffer.from(shot.data,'base64'));
  await evalJS(`document.getElementById('btn-send').click()`); await sleep(300);
  const sentShot=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(root,'.tmp/selection-shots/sent.png'),Buffer.from(sentShot.data,'base64'));
} catch (error) {
  console.error(error);
  failed++;
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
  ws?.close();
  server.close();
  server.closeAllConnections();
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('qchat-selection-ui-')) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
