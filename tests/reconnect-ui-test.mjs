// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('reconnect-ui', { problems, realTimers: true });
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
  const start = async () => {
    await open('/?mock=1&status=hold&connect=120');
    if (!await waitFor(`!document.getElementById('global-error').hidden`)) throw Error('connection deadline did not fire');
    await evalJS(`window.realNow=Date.now;window.offset=0;Date.now=()=>realNow()+offset;window.attempts=[];window.originalInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{if(c==='chat_status'||c==='chat_new'){attempts.push(c);if(window.rejectAttempt)return Promise.reject(Error('offline'));if(window.holdAttempt)return new Promise(resolve=>window.releaseAttempt=resolve);return Promise.resolve()}return originalInvoke(c,a)}`);
  };
  const ready = `__mock.emit('bridge',{type:'status',ready:true,loggedIn:false})`;
  await open('/?mock=1'); await sleep(200);
  check('normal startup has no reconnect feedback', await evalJS(`!document.getElementById('command-feedback').textContent.includes('Reconnected')`));
  await start(); await type('my draft');
  await evalJS(`window.before=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'file'}):c==='attachment_chunk'||c==='attachment_finish'?Promise.resolve({}):before(c,a);const d=new DataTransfer();d.items.add(new File(['x'],'x.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`);
  await evalJS(`window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'))`);
  check('flapping gives one attempt', await evalJS('attempts.length===1'));
  await evalJS(ready); await waitFor(`document.getElementById('global-error').hidden&&document.getElementById('command-feedback').textContent.includes('Reconnected')`).catch(() => {});
  check('ready clears error with feedback', await evalJS(`document.getElementById('global-error').hidden&&document.getElementById('command-feedback').textContent.includes('Reconnected')`));
  check('draft and attachment preserved', await evalJS(`document.getElementById('prompt-input').value==='my draft'&&document.getElementById('attachments').textContent.includes('x.txt')`));
  check('no prompt sent', await count('chat_send')===0);
  await start();
  await evalJS(`window.recoveryArgs=[];window.beforeSignedRecovery=__TAURI__.core.invoke;__TAURI__.core.invoke=(command,args)=>{if(command==='chat_status'&&args?.reconnect)recoveryArgs.push(args);return beforeSignedRecovery(command,args)};__mock.emit('bridge',{type:'status',ready:false,loggedIn:true});window.dispatchEvent(new Event('online'))`);
  check('signed-in recovery reloads its provider without New chat',await evalJS(`attempts.length===1&&attempts[0]==='chat_status'&&recoveryArgs[0].provider==='chatgpt'&&__mock.count('chat_new')===0&&document.getElementById('btn-send').disabled`));
  await start(); await evalJS(`window.rejectAttempt=true;window.dispatchEvent(new Event('online'))`); await sleep(20);
  check('failed attempt retains error', await evalJS(`!document.getElementById('global-error').hidden`));
  await evalJS(`window.rejectAttempt=false;offset+=3001;window.dispatchEvent(new Event('online'))`);
  check('later attempt allowed', await evalJS('attempts.length===2'));
  await start(); await evalJS(`window.holdAttempt=true;window.dispatchEvent(new Event('online'));offset+=20000;window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('pending attempt cannot overlap', await evalJS('attempts.length===1'));
  await evalJS(`releaseAttempt();${ready}`);
  await start(); await evalJS(`window.rejectAttempt=true;window.dispatchEvent(new Event('online'))`); await sleep(20);
  await evalJS(`window.dispatchEvent(new Event('focus'));offset+=15001;window.dispatchEvent(new Event('focus'))`);
  check('focus waits 15 seconds', await evalJS('attempts.length===2'));
  await start(); await evalJS(`__mock.emit('bridge',{type:'error',code:'auth',message:'Sign in'});window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('auth stays and never opens sign in', await evalJS(`!document.getElementById('global-error').hidden&&document.getElementById('btn-error-signin').dataset.action==='signin'&&attempts.length===0&&__mock.count('show_signin')===0`));
  await open('/?mock=1'); await sleep(100);
  await evalJS(`window.originalInvoke=__TAURI__.core.invoke;window.sent=[];__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):originalInvoke(c,a)`);
  await send('failed turn'); await waitFor('sent.length===1'); await evalJS(`__mock.emit('bridge',{type:'error',id:sent[0].id,code:'send_failed'})`);
  await waitFor(`document.querySelector('[data-action="retry-turn"]')`);
  await evalJS(`window.retry=document.querySelector('[data-action="retry-turn"]');__mock.emit('bridge',{type:'error',code:'offline'});window.dispatchEvent(new Event('online'))`);
  check('failed turn retry unchanged and no resend', await evalJS(`document.querySelector('[data-action="retry-turn"]')===retry&&sent.length===1`));
  await open('/?mock=1'); await sleep(100);
  await evalJS(`window.originalInvoke=__TAURI__.core.invoke;window.sent=[];window.recoveries=0;__TAURI__.core.invoke=(c,a)=>c==='chat_send'?(sent.push(a),Promise.resolve()):c==='chat_status'||c==='chat_new'?(recoveries++,Promise.resolve()):originalInvoke(c,a)`);
  await send('busy'); await waitFor('sent.length===1'); await evalJS(`__mock.emit('bridge',{type:'error',code:'offline'});window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));__mock.emit('qchat://shown',{})`);
  check('busy turn untouched', await evalJS(`sent.length===1&&recoveries===0&&!document.getElementById('global-error').hidden`));
  await open('/?mock=1&connect=150'); await sleep(250);
  await evalJS(`window.attempts=[];window.originalInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>{if(c==='chat_status'||c==='chat_new'){attempts.push(c);return Promise.resolve()}return originalInvoke(c,a)};${ready};__mock.emit('bridge',{type:'error',code:'not_ready',message:'x'})`); await sleep(40);
  check('ready bridge can still show the retry error', await evalJS(`!document.getElementById('global-error').hidden&&document.getElementById('btn-error-signin').textContent==='Try again'`));
  await evalJS(`document.getElementById('btn-error-signin').click()`); await sleep(30);
  check('Try again shows it is working', await evalJS(`attempts.length===1&&document.getElementById('btn-error-signin').disabled&&document.getElementById('btn-error-signin').textContent.startsWith('Reconnecting')`));
  await sleep(300);
  check('attempt with no status event ends by itself', await evalJS(`!document.getElementById('btn-error-signin').disabled&&document.getElementById('btn-error-signin').textContent==='Try again'`));
  await evalJS(`document.getElementById('btn-error-signin').click()`); await sleep(30);
  check('Try again still works after a silent attempt', await evalJS('attempts.length===2'));
  check('no runtime errors', problems.length===0, problems.join(' | '));

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
