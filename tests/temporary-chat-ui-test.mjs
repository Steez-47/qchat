// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('stage-retry-ui', { problems });
  const { cdp, evalJS } = browserPage;
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
    await cdp('Page.navigate', { url: `${base}/__blank` });
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

  await setup();
  await type('/temp');await key('Enter');await wait("__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)");
  await evalJS('__mock.emit("bridge",{type:"status",ready:true,loggedIn:false,url:"https://chatgpt.com/?temporary-chat=true"})');
  const switchedAt=await evalJS('__mock.calls.length');
  await key('k',{ctrlKey:true});await evalJS("document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");
  await wait("JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='gemini'");
  await send('Private cross-provider probe');await sleep(3000);
  check('temporary provider switch prepares the new provider before sending',await evalJS('__mock.calls.slice('+switchedAt+').some(c=>c.cmd==="chat_new"&&c.args.temporary===true)'));
  check('temporary send carries explicit privacy intent',await evalJS('__mock.last("chat_send")?.args.temporary===true'));
  await setup();
  await evalJS('window.originalTemporaryInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async function(cmd,args){if(cmd==="chat_new"&&args?.temporary){__mock.calls.push({cmd,args});__mock.emit("bridge",{type:"error",code:"temporary_unavailable",message:"Temporary mode is unavailable"});return null;}return originalTemporaryInvoke(cmd,args);}');
  await type('/temp');await key('Enter');await wait("__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)");
  await send('Private rejected-mode probe');await sleep(3000);
  check('failed temporary setup prevents provider send',await evalJS('__mock.count("chat_send")===0'));
  check('failed temporary setup retains the private draft',await inputValue()==='Private rejected-mode probe');
  await setup();
  await type('/temp'); await key('Enter'); await wait("__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)");
  await sleep(100);
  await evalJS(`__mock.emit('qchat://selection','private quoted selection')`);
  await add('private-image.png', 12, 'image/png'); await wait(ready);
  await type('private file draft');
  check('temporary draft and quote absent from local storage', await evalJS(`!JSON.stringify(localStorage).includes('private file draft')&&!JSON.stringify(localStorage).includes('private quoted selection')`));
  await evalJS(`window.originalTemporaryInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async function(cmd,args){if(cmd==='chat_send'&&args.temporary) throw new Error('temporary_unavailable: unavailable');return originalTemporaryInvoke(cmd,args)}`);
  await key('Enter'); await sleep(300);
  check('native temporary rejection restores draft', await inputValue()==='private file draft');
  check('native temporary rejection retains context and file', await evalJS(`document.querySelector('#attachments [data-state="ready"]')!==null && document.querySelector('#attachments .selection-chip')!==null`));
  await setup();
  await evalJS(`window.originalTemporaryInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async function(cmd,args){if(cmd==='chat_new'&&args.temporary){__mock.calls.push({cmd,args});return null}return originalTemporaryInvoke(cmd,args)}`);
  await type('/temp'); await key('Enter'); await wait("__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)");
  await send('delayed temporary draft');
  await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:true,temporary:true,setupId:'stale-generation',url:'https://chatgpt.com/?temporary-chat=true'})`);
  await sleep(300);
  check('stale temporary status cannot release send', await count('chat_send')===0);
  await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:true,temporary:true,setupId:__mock.last('chat_new').args.setupId,url:'https://chatgpt.com/?temporary-chat=true'})`);
  await wait("__mock.calls.some(c=>c.cmd==='chat_send')");
  check('matching delayed temporary status permits send', await evalJS(`__mock.last('chat_send').args.temporary===true`));
  await setup(); await type('/temp'); await key('Enter'); await wait("__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)"); await sleep(100);
  await evalJS(`__mock.emit('qchat://selection','private late context')`); await add('late-private.png',12,'image/png'); await wait(ready);
  await evalJS(`window.originalTemporaryInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async function(cmd,args){if(cmd==='chat_send'&&args.temporary){__mock.calls.push({cmd,args});setTimeout(()=>__mock.emit('bridge',{type:'error',id:args.id,code:'temporary_unavailable'}),40);return null}return originalTemporaryInvoke(cmd,args)}`);
  await type('later private draft'); await evalJS(`document.getElementById('prompt-input').setSelectionRange(2,9,'backward')`); await key('Enter'); await sleep(300);
  check('late bridge rejection restores draft and backward selection', await evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value==='later private draft'&&i.selectionStart===2&&i.selectionEnd===9&&i.selectionDirection==='backward'})()`));
  check('late bridge rejection restores quote and retains file', await evalJS(`!!document.querySelector('#attachments .selection-chip')&&!!document.querySelector('#attachments [data-state="ready"]')`));
  await setup(); await type('/temp'); await key('Enter'); await sleep(100); await add('expired-private.bin',31); await wait(ready);
  const expiredId=await evalJS('Array.from(__mock.attachmentFiles.keys())[0]');
  await evalJS(`window.expiryInvoke=window.__TAURI__.core.invoke;window.expireOnce=true;window.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==='chat_send'&&expireOnce){expireOnce=false;__mock.calls.push({cmd,args});__mock.attachmentFiles.clear();throw new Error('Attachment is unavailable. Select it again.');}return expiryInvoke(cmd,args);}`);
  await type('private expired-file draft'); await key('Enter'); await wait("document.getElementById('prompt-input').value==='private expired-file draft'&&!document.getElementById('btn-reasoning').disabled");
  check('expired native file becomes a recoverable failed chip',await evalJS(`!!${err}&&!!${retry}`));
  await screenshot('expired-file-340.png');
  if(await evalJS(`!!${retry}`)){await click(retry);await wait(ready);}
  check('expired file Retry stages a fresh native id without submitting',await evalJS(`__mock.attachmentFiles.size===1&&!__mock.attachmentFiles.has(${JSON.stringify(expiredId)})&&__mock.count('chat_send')===1`));
  check('expired file recovery keeps its private draft unsaved',await inputValue()==='private expired-file draft'&&await evalJS(`!(localStorage.getItem('qchat.chats')||'').includes('private expired-file draft')`));
  await setup(); await type('/temp'); await key('Enter'); await sleep(100); await add('pending-private.bin',17); await wait(ready);
  await evalJS(`window.pendingInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==='chat_send')throw new Error('attachment_pending: Clear pending files');return pendingInvoke(cmd,args);}`);
  await send('private pending draft'); await wait("document.getElementById('prompt-input').value==='private pending draft'&&!document.getElementById('btn-reasoning').disabled");
  check('pending provider files show the actionable recovery reason',await evalJS(`document.body.textContent.includes('Start a new chat or remove them there')`));
  check('pending provider files retain the local attachment and private draft',await inputValue()==='private pending draft'&&await evalJS(`!!${ready}&&__mock.attachmentFiles.size===1&&!(localStorage.getItem('qchat.chats')||'').includes('private pending draft')`));
  await setup(); await send('ordinary prompt'); await wait("__mock.calls.some(c=>c.cmd==='chat_send')");
  check('ordinary send carries false temporary intent', await evalJS(`__mock.last('chat_send').args.temporary===false`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
