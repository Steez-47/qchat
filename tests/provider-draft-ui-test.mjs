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
    await evalJS(`window.copyCalls=0;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{copyCalls++}}});const originalExec=document.execCommand.bind(document);document.execCommand=(cmd,...args)=>{if(cmd.toLowerCase()==='copy'){copyCalls++;return true}return originalExec(cmd,...args)}`);
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
  const wait = async (expr) => {if (!await waitFor(expr)) throw Error('timeout: '+expr)};
  const retry = `document.querySelector('[data-action="retry-attachment"]')`;
  const err = `document.querySelector('#attachments [data-state="error"]')`;
  const ready = `document.querySelector('#attachments [data-state="ready"]')`;
  const click = (expr) => evalJS(`${expr}.click()`);


  const beginSwitch=async()=>{await evalJS('__mock.providerHold=true');await key('k',{ctrlKey:true});await evalJS("document.getElementById('slash-gemini').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))");await wait('typeof __mock.releaseProvider===\"function\"')};
  const finishSwitch=async()=>{await evalJS('__mock.releaseProvider()');await wait("JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='gemini'")};
  await setup();await type('older draft');await beginSwitch();await type('newer draft 🦊');await evalJS("document.getElementById('prompt-input').setSelectionRange(2,7)");await finishSwitch();
  check('pending provider change keeps newer text and caret',await evalJS("document.getElementById('prompt-input').value==='newer draft 🦊'&&document.getElementById('prompt-input').selectionStart===2&&document.getElementById('prompt-input').selectionEnd===7"));
  await setup();await type('draft to delete');await beginSwitch();await type('');await finishSwitch();
  check('pending provider change respects a deleted draft',await inputValue()==='');
  await setup();await type('old chat draft');await beginSwitch();await evalJS("__mock.emit('qchat://new-chat',{})");await finishSwitch();
  check('pending provider change does not resurrect a New chat draft',await inputValue()==='');
  await setup();await type('quoted draft');await beginSwitch();await evalJS("__mock.emit('qchat://selection','new quoted context')");await finishSwitch();
  check('pending provider change preserves newly captured context',await evalJS("!!document.querySelector('#attachments .selection-chip')"));
  const saved = `JSON.parse(localStorage.getItem('qchat.chats'))`;
  const quote = text => evalJS(`__mock.emit('qchat://selection',${JSON.stringify(text)})`);
  const noSend = () => evalJS("__mock.count('chat_send')===0 && __mock.count('image_copy')===0 && copyCalls===0");
  const editor = (value,start,end) => evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value===${JSON.stringify(value)} && i.selectionStart===${start} && i.selectionEnd===${end} && i.selectionDirection==='backward'})()`);
  const snapFile = () => evalJS(`(()=>({src:document.querySelector('#attachments img')?.src,ids:[...__mock.attachmentFiles.keys()]}))()`);
  await setup(); await type('old'); await add('image.png',128,'image/png'); await wait(ready); const before=await snapFile();
  await beginSwitch(); await evalJS("const i=document.getElementById('prompt-input');i.focus();i.select()"); await cdp('Input.insertText',{text:'Kia ora 🌏\nnew line'}); await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36,modifiers:8}); await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36,modifiers:8}); await quote('new context'); await finishSwitch();
  check('latest multiline Unicode and backward range',await editor('Kia ora 🌏\nnew line',11,19));
  check('new context saved once with quote preview',await evalJS(`${saved}.current.selectionTexts.length===1 && ${saved}.current.selectionTexts[0]==='new context' && document.querySelectorAll('#attachments .selection-chip').length===1 && document.querySelector('#attachments .selection-chip .attachment-name').textContent==='new context'`));
  check('staged image and preview retained',JSON.stringify(before)===JSON.stringify(await snapFile()) && !!before.src && before.ids.length===1);
  await wait("!document.getElementById('btn-send').disabled"); check('switch sends nothing and controls settle',await noSend());
  await open('/',{keep:true}); check('latest draft and context reload',await inputValue()==='Kia ora 🌏\nnew line' && await evalJS("document.querySelectorAll('#attachments .selection-chip').length===1"));
  await setup(); await evalJS('__mock.providerHold=true'); await type('/gemini'); await key('Enter'); await wait('typeof __mock.releaseProvider === "function"'); await type(''); await finishSwitch(); check('typed command respects deletion',await inputValue()==='' && await evalJS(`${saved}.current.draft===''`));
  await setup(); await type('old'); await quote('old quote'); await beginSwitch(); await evalJS("__mock.emit('qchat://new-chat',{})"); await finishSwitch(); check('new chat clears old quote',await inputValue()==='' && await evalJS(`${saved}.current.selectionTexts.length===0`));
  await setup(); await beginSwitch(); await type('/cop'); await finishSwitch(); check('known slash prefix remains visible but is not persisted',await inputValue()==='/cop' && await evalJS(`${saved}.current.draft===''`));
  await setup(); await quote('remove me'); await beginSwitch(); await evalJS("document.querySelector('#attachments .selection-chip button').click()"); await quote('keep me'); await finishSwitch(); check('quote removal and addition preserved once',await evalJS(`${saved}.current.selectionTexts.length===1 && ${saved}.current.selectionTexts[0]==='keep me' && document.querySelectorAll('#attachments .selection-chip').length===1`));
  await setup(); await add('image.png',128,'image/png'); await wait(ready); const failFile=await snapFile(); await beginSwitch(); await type('new after failure'); await evalJS("document.getElementById('prompt-input').setSelectionRange(1,5,'backward');__mock.failProvider=true;__mock.releaseProvider()"); await wait("document.getElementById('global-error').textContent.includes(\"Couldn't switch\")"); check('failed switch preserves latest editor',await editor('new after failure',1,5)); check('failed switch retains file and does not send',JSON.stringify(failFile)===JSON.stringify(await snapFile()) && await noSend());
  const seed={v:1,current:{key:'fallback',provider:'gemini',title:'fallback',draft:'old',selectionTexts:[],transcript:[]},recent:[]};
  await open('/?mock=1&holdProvider&failProvider',{chats:seed}); await wait('typeof __mock.releaseProvider === "function"'); await type('fallback 🌏\nlatest'); await evalJS("document.getElementById('prompt-input').setSelectionRange(1,8,'backward')"); await quote('fallback context'); await add('image.png',128,'image/png'); await wait(ready); const fallbackFile=await snapFile(); await evalJS('__mock.releaseProvider()'); await wait(`${saved}?.current?.provider==='chatgpt'`);
  check('startup fallback keeps latest editor',await editor('fallback 🌏\nlatest',1,8)); check('startup fallback keeps quote and image',await evalJS(`${saved}.current.selectionTexts[0]==='fallback context' && document.querySelectorAll('#attachments .selection-chip').length===1`) && JSON.stringify(fallbackFile)===JSON.stringify(await snapFile())); check('fallback sends nothing',await noSend());
  await setup(); await evalJS("__mock.attachmentFaults.attachment_begin={holdOn:[1]}"); await add('inflight.png',128,'image/png'); await wait('__mock.attachmentFaults.attachment_begin.release'); await add('queued.png',128,'image/png'); const previews=await evalJS("[...document.querySelectorAll('#attachments img')].map(i=>i.src)"); await beginSwitch(); await finishSwitch(); check('queued and in-flight previews survive switch',await evalJS(`[...document.querySelectorAll('#attachments img')].map(i=>i.src).join('|')===${JSON.stringify(previews.join('|'))}`) && previews.length===2); await evalJS('__mock.attachmentFaults.attachment_begin.release()'); await wait("document.querySelectorAll('#attachments [data-state=ready]').length===2"); check('queued and in-flight files finish with original ownership',await evalJS("__mock.attachmentFiles.size===2 && __mock.count('attachment_begin')===2 && __mock.count('attachment_remove')===0") && await noSend());
  await open('/?mock=1',{settings:{keepHistory:false}}); await beginSwitch(); await type('private draft'); await quote('private context'); await evalJS('__mock.releaseProvider()'); await wait("__mock.provider==='gemini' && !document.getElementById('btn-send').disabled"); check('history disabled keeps current composer without storage',await inputValue()==='private draft' && await evalJS("localStorage.getItem('qchat.chats')===null && document.querySelectorAll('#attachments .selection-chip').length===1"));
  await setup(); await type('/temp'); await key('Enter'); await type('temporary secret'); await quote('temporary quote'); await beginSwitch(); await finishSwitch(); check('temporary draft and quote remain private through switch',await inputValue()==='temporary secret' && await evalJS("!(localStorage.getItem('qchat.chats')||'').includes('temporary secret') && !(localStorage.getItem('qchat.chats')||'').includes('temporary quote') && document.querySelectorAll('#attachments .selection-chip').length===1 && !document.getElementById('mode-chip').hidden && document.getElementById('mode-chip').textContent==='Temporary'"));
  await setup(); await type('old'); await beginSwitch(); await type('/temp'); await key('Enter'); await type('held temporary secret'); await quote('held temporary quote'); await finishSwitch(); check('temporary mode selected during switch remains private',await inputValue()==='held temporary secret' && await evalJS("!(localStorage.getItem('qchat.chats')||'').includes('held temporary secret') && !(localStorage.getItem('qchat.chats')||'').includes('held temporary quote') && document.querySelectorAll('#attachments .selection-chip').length===1"));
  await setup(); await type('/temp'); await key('Enter'); await type('old temporary'); await beginSwitch(); await key('n',{ctrlKey:true}); await type('ordinary new draft'); await finishSwitch(); check('new chat while switching leaves temporary mode',await evalJS(`${saved}.current.draft==='ordinary new draft' && document.getElementById('mode-chip').hidden`));
  check('no runtime errors',problems.length===0,problems.slice(0,3).join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
