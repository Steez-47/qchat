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
  browserPage = await openPage('attachment-retry-ui', { problems });
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
  await open('/?mock=1', {settings:{animations:'off',keepHistory:true,showTabs:true}, chats:{v:1,current:{key:'current',createdAt:Date.now(),transcript:[]},recent:[{key:'other',title:'other',lastPrompt:'old',lastResponse:'reply',createdAt:Date.now(),lastActive:Date.now(),transcript:[]}]}});
  await evalJS(`window.sent=[];window.removed=[];window.orig=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{
    if(c==='attachment_begin')return window.holdFile?new Promise(resolve=>window.releaseFile=()=>resolve({...a,id:'new-file'})):Promise.resolve({...a,id:'retry-file'});
    if(c==='attachment_chunk'||c==='attachment_finish')return Promise.resolve({});
    if(c==='attachment_remove'){removed.push(a.id);return Promise.resolve();}
    if(c==='chat_send'){sent.push(a);return window.gone?Promise.reject(Error('Attachment is unavailable. Select it again.')):Promise.resolve();}
    return orig(c,a);
  };const d=new DataTransfer();d.items.add(new File(['x'],'x.txt'));const e=document.getElementById('attachment-input');e.files=d.files;e.dispatchEvent(new Event('change'));`);
  if(!await waitFor(`document.querySelector('#attachments [data-state=ready]')`))throw Error('stage timeout');
  };
  await setup();
  await evalJS(`document.getElementById('btn-send').click()`);await waitFor('sent.length===1');
  check('progress heartbeat leaves reply and activity presentation unchanged',await evalJS(`(()=>{const before=document.getElementById('bubble-zone').innerHTML;__mock.emit('bridge',{type:'progress',id:sent[0].id});return document.getElementById('bubble-zone').innerHTML===before})()`));
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);await sleep(150);
  check('attachment-only failure offers Retry',await evalJS(`!!document.querySelector('[data-action="retry-turn"]')`));
  await evalJS(`window.beforeNarrowSettings={...QSettings.settings};__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,barWidth:340,replyWidth:340}))`);
  await cdp('Emulation.setDeviceMetricsOverride',{width:368,height:800,deviceScaleFactor:1,mobile:false});await sleep(100);
  check('retry action and error fit a narrow popup',await evalJS(`(()=>{const button=document.querySelector('[data-action="retry-turn"]'),rect=button.getBoundingClientRect(),row=button.closest('.turn-row').getBoundingClientRect();return rect.width>=36&&row.left>=0&&row.right<=innerWidth})()`));
  const shots=path.join(root,'.tmp','retry-shots');await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'attachment-retry.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:516,height:800,deviceScaleFactor:1,mobile:false});
  await evalJS("__mock.emit('qchat://settings-changed',QSettings.save(beforeNarrowSettings))");
  await evalJS(`const composer=document.getElementById('prompt-input');composer.value='next draft';composer.dispatchEvent(new Event('input'));window.retryButton=document.querySelector('[data-action="retry-turn"]');retryButton.click();retryButton.click()`);await sleep(200);
  check('double click sends same files once',await evalJS(`sent.length===2&&sent[1].prompt===sent[0].prompt&&JSON.stringify(sent[0].attachmentIds)===JSON.stringify(sent[1].attachmentIds)`));
  check('composer text preserved',await inputValue()==='next draft');
  await evalJS(`retryButton.click()`);await sleep(80);check('busy ignored',await evalJS('sent.length===2'));
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[1].id,code:'stream_failed'})`);await sleep(120);
  await evalJS(`window.gone=true;document.querySelector('[data-action="retry-turn"]').click()`);await sleep(150);
  check('missing file explains reattach',await evalJS(`document.body.textContent.includes('Attach it again')&&sent.length===3`));
  for(const action of ['new','clear','switch','success','auth','retry']){
    await setup();await type('same prompt');await evalJS(`document.getElementById('btn-send').click()`);await waitFor('sent.length===1');
    await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:${JSON.stringify(action==='auth'?'auth':'timeout')}})`);await sleep(100);
    if(action==='new')await evalJS(`__mock.emit('qchat://new-chat',{})`);
    if(action==='clear')await evalJS(`__mock.emit('qchat://clear-chats',{})`);
    if(action==='switch')await evalJS(`document.querySelector('.tab[data-key="other"]').click()`);
    if(action==='success'||action==='retry'){
      await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await waitFor('sent.length===2');
      check('prompt and ids preserved',await evalJS(`sent[0].prompt===sent[1].prompt&&JSON.stringify(sent[0].attachmentIds)===JSON.stringify(sent[1].attachmentIds)`));
      await evalJS(`__mock.emit('bridge',{type:'done',id:sent[1].id,text:'ok'})`);
    }
    await sleep(120);
    if(action==='auth')check('auth has no Retry',await evalJS(`!document.querySelector('[data-action="retry-turn"]')`));
    else check(action+' releases files',await evalJS(`removed.includes('retry-file')`));
  }
  await open('/?mock=1');await evalJS(`window.sent=[];window.orig=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):orig(c,a)`);await send('text only');await waitFor('sent.length===1');await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);await sleep(100);await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await waitFor('sent.length===2');check('text-only retry unchanged',await evalJS(`sent.length===2&&sent[1].prompt==='text only'&&sent[1].attachmentIds.length===0`));
  check('text-only retry clears the matching recovered draft and saved draft',await evalJS(`document.getElementById('prompt-input').value===''&&JSON.parse(localStorage.getItem('qchat.chats')).current.draft===''`));
  await evalJS(`__mock.emit('bridge',{type:'done',id:sent[1].id,text:'ok'})`);
  if(!await waitFor(`!document.querySelector('#bubble-zone [data-status=streaming]')`))throw Error('retry did not finish');
  await key('Enter');await sleep(60);
  check('Enter after a successful retry cannot send a duplicate recovered prompt',await evalJS('sent.length===2'));
  await send('text retry with new file');
  if(!await waitFor('sent.length===3'))throw Error('new text send did not start: '+JSON.stringify(await evalJS(`({sent:sent.length,focus:document.activeElement?.id,input:document.getElementById('prompt-input').value,mode:document.getElementById('btn-send').dataset.mode,disabled:document.getElementById('btn-send').disabled,status:document.getElementById('status-label').textContent,error:document.getElementById('global-error').textContent,rows:[...document.querySelectorAll('[data-role=assistant]')].map(row=>row.dataset.status)})`)));
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[2].id,code:'send_failed'});window.beforeNewFile=__TAURI__.core.invoke;__TAURI__.core.invoke=(command,args)=>command==='attachment_begin'?Promise.resolve({...args,id:'future-file'}):command==='attachment_chunk'||command==='attachment_finish'?Promise.resolve({}):beforeNewFile(command,args);(()=>{const data=new DataTransfer();data.items.add(new File(['new'],'future.txt'));const input=document.getElementById('attachment-input');input.files=data.files;input.dispatchEvent(new Event('change'))})()`);
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`);await type('future prompt');
  if(!await waitFor(`document.querySelector('.turn-row:not(.leaving) [data-action="retry-turn"]')`))throw Error('current retry did not render');
  await evalJS(`document.querySelector('.turn-row:not(.leaving) [data-action="retry-turn"]').click()`);
  if(!await waitFor('sent.length===4'))throw Error('retry with a new file did not start: '+JSON.stringify(await evalJS(`({sent:sent.length,input:document.getElementById('prompt-input').value,mode:document.getElementById('btn-send').dataset.mode,feedback:document.getElementById('command-feedback').textContent,attachments:document.getElementById('attachments').textContent,rows:[...document.querySelectorAll('[data-role=assistant]')].map(row=>({id:row.dataset.id,status:row.dataset.status,error:row.querySelector('.turn-error')?.textContent}))})`)));
  check('text-only retry preserves newer text and attachments without sending them',await evalJS(`sent[3].prompt==='text retry with new file'&&sent[3].attachmentIds.length===0&&document.getElementById('prompt-input').value==='future prompt'&&document.getElementById('attachments').textContent.includes('future.txt')`));

  await setup();await send('with files');await waitFor('sent.length===1');
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);await sleep(80);
  check('attachment failure restores the original prompt',await inputValue()==='with files');
  await evalJS(`(()=>{window.holdFile=true;const d=new DataTransfer();d.items.add(new File(['new'],'new.txt'));const input=document.getElementById('attachment-input');input.files=d.files;input.dispatchEvent(new Event('change'))})()`);
  if(!await waitFor('typeof releaseFile==="function"'))throw Error('delayed stage did not start');
  await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await sleep(80);
  check('retry while staging preserves its files and recovered draft with feedback',await evalJS(`sent.length===1&&removed.length===0&&document.getElementById('prompt-input').value==='with files'&&!!document.querySelector('[data-action="retry-turn"]')&&document.getElementById('command-feedback').textContent.includes('finish attaching')`));
  await evalJS('window.holdFile=false;releaseFile()');
  if(!await waitFor(`document.querySelectorAll('#attachments [data-state=ready]').length===1`))throw Error('new file not ready');
  await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await waitFor('sent.length===2');
  check('attachment retry clears only the matching recovered text and sends only original files',await evalJS(`document.getElementById('prompt-input').value===''&&JSON.parse(localStorage.getItem('qchat.chats')).current.draft===''&&sent[1].attachmentIds.length===1&&sent[1].attachmentIds[0]==='retry-file'&&document.getElementById('attachments').textContent.includes('new.txt')&&!removed.includes('new-file')`));

  await setup();await send('snapshot retry');await waitFor('sent.length===1');
  await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'timeout'});window.beforeSnapshot=__TAURI__.core.invoke;__TAURI__.core.invoke=(command,args)=>command==='snapshot_capture'?new Promise((resolve,reject)=>window.rejectSnapshot=()=>reject(Error('fixture cancelled'))):beforeSnapshot(command,args);document.getElementById('btn-snapshot').click()`);
  if(!await waitFor('typeof rejectSnapshot==="function"'))throw Error('snapshot did not start');
  await evalJS(`document.querySelector('[data-action="retry-turn"]').click()`);await sleep(60);
  check('retry during a snapshot keeps ownership and recovered text with feedback',await evalJS(`sent.length===1&&removed.length===0&&document.getElementById('prompt-input').value==='snapshot retry'&&document.getElementById('command-feedback').textContent.includes('snapshot to finish')`));
  await evalJS('rejectSnapshot()');await sleep(60);

  for(const terminalType of ['done','error','attachment_pending']){
    await setup();await type('old draft');
    await evalJS(`window.baseInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(command,args)=>command==='chat_send'?(sent.push(args),new Promise((resolve,reject)=>window.rejectSend=()=>reject(Error('native rejection')))):baseInvoke(command,args);document.getElementById('btn-send').click()`);
    await waitFor('typeof rejectSend==="function"');await type('newer draft 🌏');
    await evalJS(`__mock.emit('bridge',{type:${JSON.stringify(terminalType==='done'?'done':'error')},id:sent[0].id,text:'finished',code:${JSON.stringify(terminalType==='attachment_pending'?'attachment_pending':'auth')}});rejectSend()`);await sleep(100);
    check(terminalType+' before rejected invoke cannot leave deleted-file chips or erase newer draft',await evalJS(`!document.querySelector('#attachments .attachment-chip')&&removed.includes('retry-file')&&document.getElementById('prompt-input').value==='newer draft 🌏'&&!document.querySelector('[data-action="retry-turn"]')`));
  }

  await setup();await send('expiry prompt');await waitFor('sent.length===1');
  await evalJS(`window.originalTimeout=setTimeout;window.setTimeout=(callback,delay,...args)=>{if(delay===600000)window.expireRetry=callback;return originalTimeout(callback,delay,...args)};__mock.emit('bridge',{type:'error',id:sent[0].id,code:'timeout'})`);await sleep(100);
  await type('new draft before expiry');await evalJS('expireRetry();window.setTimeout=originalTimeout');await sleep(80);
  check('expiry releases retained bytes and removes retry with an honest notice',await evalJS(`removed.includes('retry-file')&&!document.querySelector('[data-action="retry-turn"]')&&document.body.textContent.includes('files have expired')&&document.getElementById('prompt-input').value==='new draft before expiry'`));
  check('no runtime errors',problems.length===0,problems.join(' | '));

} catch (e) {
  console.error(e);
  if (problems.length) console.error('console:', problems.slice(0, 5).join(' | '));
  failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
