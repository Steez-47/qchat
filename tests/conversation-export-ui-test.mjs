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
  browserPage = await openPage('conversation-export', { problems });
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
  const MIN = 60 * 1000;
  const chatSeed = (key, { conv = null, prompt = `prompt ${key}`, reply = `reply ${key}`, ago = MIN, draft = "", transcript } = {}) => ({
    key,
    conversationId: conv,
    title: key,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft,
    transcript: transcript || [
      { id: `${key}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${key}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago
  });


  const runExport = async () => { await type('/export'); await key('Enter'); await sleep(50); };
  const paletteExport = async () => { await key('k',{ctrlKey:true}); await evalJS("document.querySelector('#slash-export').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(50); };
  const transcript = [
    {id:'u',role:'user',text:'Kia ora 🌏',selectionTexts:['quoted\nselection']},
    {id:'a',role:'assistant',text:'```js\nconst x = "é";\n```\nciteturn0search0',sources:[{id:'turn0search0',url:'https://example.com/',title:'Source'}]},
    {id:'f',role:'user',text:'',hadAttachments:true},
    {id:'m',role:'assistant',text:'',media:[{file:'file-test-id',name:'report.csv'}]}
  ];
  await open('/',{chats:{v:1,current:chatSeed('export',{transcript}),recent:[]},settings:{animations:'off',autoDismiss:0}});
  await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.copyWrites=(window.copyWrites||0)+1;window.copied=t}}})");
  await type('/copy'); await key('Enter'); await sleep(50);
  await evalJS(`__mock.emit('qchat://selection','draft selection');(()=>{const d=new DataTransfer();d.items.add(new File(['private bytes'],'keep.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))})()`); await waitFor("document.querySelector('#attachments .selection-chip') && document.getElementById('attachments').textContent.includes('keep.txt')");
  await type('unsent draft'); await evalJS("(()=>{let i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(2,5)})()");
  await paletteExport();
  check('copy parity and draft excluded',await evalJS("__mock.last('conversation_export').args.markdown===window.copied&&!window.copied.includes('unsent draft')&&window.copied.includes('🌏')&&window.copied.includes('quoted')&&window.copied.includes('const x')&&window.copied.includes('[Attachment]')"));
  check('citation and media name preserved',await evalJS("window.copied.includes('https://example.com/') && window.copied.includes('report.csv')"));
  check('draft and selection preserved',await evalJS("(()=>{let i=document.getElementById('prompt-input');return i.value==='unsent draft'&&i.selectionStart===2&&i.selectionEnd===5})()"));
  check('files and selection preserved',await evalJS("document.querySelector('#attachments .selection-chip') && document.getElementById('attachments').textContent.includes('keep.txt') && !__mock.last('conversation_export').args.markdown.includes('private bytes')"));
  check('success feedback',await evalJS("document.getElementById('command-feedback').textContent.includes('to Downloads')"));
  check('export makes no additional clipboard write',await evalJS('window.copyWrites===1'));
  await open('/',{settings:{animations:'off',autoDismiss:0}}); await runExport();
  check('empty skips native',await evalJS("__mock.count('conversation_export')===0&&document.getElementById('command-feedback').textContent.includes('No messages')"));
  await open('/',{chats:{v:1,current:chatSeed('async'),recent:[chatSeed('other')]},settings:{animations:'off',autoDismiss:0}});
  await evalJS('__mock.exportError=true'); await runExport();
  check('error feedback',await evalJS(`document.getElementById("command-feedback").textContent.includes("Couldn't save")`));
  await evalJS('__mock.exportError=false; __mock.exportHold=true'); await runExport(); await runExport();
  check('pending prevents duplicate',await evalJS("__mock.count('conversation_export')===2"));
  check('pending action gives Saving feedback',await evalJS("document.getElementById('command-feedback').textContent.includes('Saving conversation')"));
  await evalJS("document.querySelector('#tabs [data-key=other]').click(); __mock.releaseExport()"); await sleep(80);
  check('completed export reports its result after switching chats',await evalJS("document.getElementById('command-feedback').textContent.includes('Saved')&&JSON.parse(localStorage.getItem('qchat.chats')).current.key==='other'"));
  check('pending export keeps the original conversation snapshot',await evalJS("__mock.last('conversation_export').args.title==='async'&&__mock.last('conversation_export').args.markdown.includes('reply async')&&!__mock.last('conversation_export').args.markdown.includes('reply other')"));
  await evalJS('__mock.exportHold=false'); await runExport();
  check('retry succeeds',await evalJS("__mock.count('conversation_export')===3&&document.getElementById('command-feedback').textContent.includes('Saved')"));
  await evalJS('__mock.exportHold=true;__mock.exportError=true');await runExport();
  await evalJS("document.querySelector('#tabs [data-key=async]').click()");await type('new draft after switching');
  await evalJS('__mock.releaseExport()');await sleep(80);
  check('failed export reports after a switch and preserves the new draft',await evalJS("document.getElementById('command-feedback').textContent.includes(\"Couldn't save\")&&JSON.parse(localStorage.getItem('qchat.chats')).current.key==='async'&&document.getElementById('prompt-input').value==='new draft after switching'"));
  for (const mode of ['temporary','history-disabled']) {
    await open('/',{settings:{animations:'off',autoDismiss:0,keepHistory:mode!=='history-disabled',streamStyle:'paragraph'}});
    if (mode==='temporary') { await type('/temp'); await key('Enter'); await sleep(100); }
    await evalJS('__mock.hold=true'); await send('private question'); await waitFor("__mock.count('chat_send')===1");
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify('```js\nconst received = 42;')}})`); await sleep(50);
    await runExport();
    check(mode+' exports streaming snapshot',await evalJS("__mock.last('conversation_export').args.markdown.includes('const received = 42;')"));
    check(mode+' keeps storage private',await evalJS("!String(localStorage.getItem('qchat.chats')).includes('private question')"));
  }
  await open('/',{settings:{animations:'off',autoDismiss:0,streamStyle:'paragraph'}});
  await evalJS('__mock.hold=true');await send('Large export fixture');await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'é'.repeat(2*1024*1024)})");
  await paletteExport();
  check('oversized UTF-8 conversation skips native with honest feedback',await evalJS("__mock.count('conversation_export')===0&&document.getElementById('command-feedback').textContent.includes('too long to save')"));
  check('no runtime errors',problems.length===0,problems.slice(0,3).join(' | '));
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



