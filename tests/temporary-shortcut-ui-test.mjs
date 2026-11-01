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
  browserPage = await openPage('temporary-shortcut-ui', { problems });
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
  const add = (name='binary-🌏.bin', size=524311, mime='application/octet-stream') => evalJS(`(()=>{const b=new Uint8Array(${size});for(let i=0;i<b.length;i++)b[i]=(i*37+191)%256;window.expected=b;const d=new DataTransfer();d.items.add(new File([b],${JSON.stringify(name)},{type:${JSON.stringify(mime)}}));const input=document.getElementById('attachment-input');input.files=d.files;input.dispatchEvent(new Event('change'))})()`);
  const wait = async (expr) => {if (!await waitFor(expr)) throw Error('timeout: '+expr)};
  const ready = `document.querySelector('#attachments [data-state="ready"]')`;


  const seeded = key => ({key,provider:'chatgpt',title:key,lastPrompt:'Earlier question',lastResponse:'Earlier answer',draft:'',createdAt:Date.now(),lastActive:Date.now(),transcript:[{id:key+'-user',role:'user',text:'Earlier question'},{id:key+'-reply',role:'assistant',text:'Earlier answer'}]});
  const boot = async (provider='chatgpt', recent=[]) => {
    const current={...seeded('current'),provider};
    await open('/?mock=1',{settings:{animations:'off',barWidth:340,replyWidth:340,defaultProvider:provider,showTabs:true},chats:{v:1,current,recent}});
    await wait('__mock.provider==='+JSON.stringify(provider));
    await evalJS('document.getElementById("prompt-input").focus()');
  };
  const chord = (extra={}) => evalJS('(()=>{const event=new KeyboardEvent("keydown",'+JSON.stringify({key:'N',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true,...extra})+');document.activeElement.dispatchEvent(event);return event.defaultPrevented;})()');
  const newCount = () => count('chat_new');
  for (const provider of ['chatgpt','gemini']) {
    await boot(provider);await type('Keep my ordinary draft');
    const before=await newCount();const handled=await chord();await wait('__mock.count("chat_new")>'+before);
    check(provider+' shortcut requests Temporary and prevents the default',handled&&await evalJS('__mock.last("chat_new").args.temporary===true&&document.getElementById("mode-chip").textContent==="Temporary"'));
    check(provider+' shortcut creates an empty composer without sending',await inputValue()===''&&await count('chat_send')===0);
    check(provider+' shortcut retains the previous ordinary draft',await evalJS('JSON.parse(localStorage.getItem("qchat.chats")).recent.some(chat=>chat.draft==="Keep my ordinary draft")'));
    await type('Private keyboard draft '+provider);
    await evalJS('window.dispatchEvent(new Event("pagehide"))');
    check(provider+' keyboard draft stays out of local history',await evalJS('!(localStorage.getItem("qchat.chats")||"").includes("Private keyboard draft")'));
    await evalJS('__mock.hold=true');await send('Private keyboard turn '+provider);await wait('__mock.count("chat_send")===1');
    check(provider+' keyboard send carries Temporary intent after setup',await evalJS('(()=>{const calls=__mock.calls;const index=calls.findIndex(call=>call.cmd==="chat_send");return calls[index].args.temporary===true&&calls.slice(0,index).some(call=>call.cmd==="chat_new"&&call.args.temporary===true);})()'));
  }
  await boot();const initialCount=await newCount();await chord();await wait('__mock.count("chat_new")>'+initialCount);
  const firstSetup=await evalJS('__mock.last("chat_new").args.setupId');const firstCount=await newCount();
  await chord();await wait('__mock.count("chat_new")>'+firstCount);
  check('each deliberate shortcut requests a distinct fresh Temporary setup',await evalJS('__mock.last("chat_new").args.temporary===true&&__mock.last("chat_new").args.setupId!=='+JSON.stringify(firstSetup)));
  await chord({shiftKey:false,key:'n'});await wait('!__mock.last("chat_new").args.temporary');
  check('Ctrl+N continues to create an ordinary chat',await evalJS('!__mock.last("chat_new").args.temporary&&document.getElementById("mode-chip").hidden'));
  await boot();const metaBefore=await newCount();const metaHandled=await chord({ctrlKey:false,metaKey:true});await wait('__mock.count("chat_new")>'+metaBefore);
  check('Meta+Shift+N uses the existing meta shortcut convention',metaHandled&&await evalJS('__mock.last("chat_new").args.temporary===true'));
  for (const [label,flags] of [['repeat',{repeat:true}],['Alt',{altKey:true}],['IME',{isComposing:true}],['IME keyCode',{keyCode:229}],['unmodified Shift+N',{ctrlKey:false}]]) {
    await boot();await type('Untouched '+label);const before=await newCount();const handled=await chord(flags);await sleep(40);
    check(label+' leaves the draft and chat unchanged',!handled&&await newCount()===before&&await inputValue()==='Untouched '+label);
  }
  for (const [label,selector] of [['rename','.rename-input'],['find','#find-input'],['chat search','.feature-search']]) {
    await boot();
    if(label==='rename'){await type('/rename');await key('Enter');}else await key(label==='find'?'f':'p',{ctrlKey:true});
    await wait('!!document.querySelector('+JSON.stringify(selector)+')&&!document.querySelector('+JSON.stringify(selector)+').closest("[hidden]")');
    await evalJS('window.shortcutEditor=document.querySelector('+JSON.stringify(selector)+');shortcutEditor.value="Keep this edit";shortcutEditor.focus()');
    const before=await newCount();const handled=await chord();await sleep(40);
    check(label+' editing keeps its value and focus',!handled&&await newCount()===before&&await evalJS('shortcutEditor.value==="Keep this edit"&&document.activeElement===shortcutEditor'));
  }
  await boot('chatgpt',[seeded('tab-a'),seeded('tab-b'),seeded('tab-c')]);await wait('document.querySelectorAll("#tabs .tab").length===3');
  await evalJS('document.querySelector("#tabs .tab").focus()');const tabBefore=await newCount();await chord();await wait('__mock.count("chat_new")>'+tabBefore);
  check('shortcut on a non-last recent tab starts Temporary and focuses the composer',await evalJS('__mock.last("chat_new").args.temporary===true&&document.activeElement===document.getElementById("prompt-input")'));
  await boot();await evalJS('__mock.hold=true');await send('Stop this held turn');await wait('__mock.count("chat_send")===1');const streamBefore=await newCount();
  await evalJS('window.originalStopInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=async(cmd,args)=>{if(cmd==="chat_stop")await new Promise(resolve=>{window.releaseShortcutStop=resolve;});return originalStopInvoke(cmd,args);};');
  await chord();await wait('typeof releaseShortcutStop==="function"');
  check('shortcut awaits Stop before requesting or marking Temporary',await newCount()===streamBefore&&await evalJS('document.getElementById("mode-chip").hidden'));
  await evalJS('releaseShortcutStop()');await wait('__mock.count("chat_new")>'+streamBefore);
  check('shortcut stops an active turn without submitting another message',await count('chat_stop')===1&&await count('chat_send')===1&&await inputValue()===''&&await evalJS('__mock.last("chat_new").args.temporary===true&&document.getElementById("mode-chip").textContent==="Temporary"'));
  await boot();await add('old-file.bin',37);await wait(ready);const fileBefore=await newCount();await chord();await wait('__mock.count("chat_new")>'+fileBefore+'&&__mock.attachmentFiles.size===0');
  check('shortcut discards previous staged files without sending',await evalJS('!document.querySelector("#attachments .attachment-chip")&&__mock.count("chat_send")===0'));
  await boot();await type('/keys');await key('Enter');
  check('shortcut is listed in keyboard help',await evalJS('document.querySelector(".feature-list").textContent.includes("Ctrl+Shift+N")&&document.querySelector(".feature-list").textContent.includes("Temporary chat")'));
  check('Temporary shortcut has no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
