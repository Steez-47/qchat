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
  browserPage = await openPage('conversation-copy', { problems });
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

  const stub = async (mode='ok') => evalJS(`(()=>{window.clipWrites=[];window.copyMode=${JSON.stringify(mode)};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{if(copyMode!=='ok')throw Error('denied');clipWrites.push(t)}}});document.execCommand=()=>{if(copyMode==='throw')throw Error('denied');if(copyMode==='fallback'){clipWrites.push(document.activeElement.value);return true}return false};})()`);
  const copy = async () => { await type('/copy'); await key('Enter'); await sleep(80); };
  const transcript = [
    {id:'u1',role:'user',text:'Kia ora 🌏',selectionTexts:['quoted\nselection']},
    {id:'a1',role:'assistant',text:'```js\nconst x = "é";\n```'},
    {id:'u2',role:'user',text:'Second'},
    {id:'a2',role:'assistant',text:'Answer <Entity name="kiwi"/> citeturn0search0\n\n![Kiwi](qchat-web:photo1)',sources:[{id:'turn0search0',url:'https://example.com/kiwi',title:'Kiwi'}]},
    {id:'hidden',role:'system',text:'Never copy system text'},
    {id:'u3',role:'user',text:'',hasMedia:true}
  ];
  await open('/', {chats:{v:1,current:chatSeed('copy-test',{transcript}),recent:[]},settings:{animations:'off',autoDismiss:0}});
  await stub(); await copy();
  let result=await evalJS('clipWrites[0]');
  check('stored turns ordered, Unicode, code, selection and attachment', typeof result==='string' && result.includes('Kia ora 🌏\n\n> quoted\n> selection') && result.includes('```js\nconst x = "é";\n```') && result.indexOf('Second')>result.indexOf('const x') && result.indexOf('Answer')>result.indexOf('Second') && result.includes('[Attachment]'),String(result));
  check('success feedback',await evalJS("document.getElementById('command-feedback').textContent==='Conversation copied'"));
  check('readable sources and media, without internal tags', result.includes('https://example.com/kiwi') && result.includes('[Image: Kiwi]') && !/qchat-web:||<Entity|Never copy system/.test(result), result);
  await open('/', {keep:true}); await stub(); await copy();
  check('history survives reload',await evalJS("clipWrites[0]?.includes('Kia ora 🌏') && clipWrites[0]?.includes('Answer')"));
  for(const mode of ['false','throw']) {
    await stub(mode); await copy();
    check('clipboard '+mode+' reports failure',await evalJS("!clipWrites.length && document.body.textContent.includes(\"Couldn't copy. Try again.\") && document.getElementById('command-feedback').hidden"));
  }
  await stub('fallback');
  await type('draft selection'); await evalJS("(()=>{const i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(2,7)})()");
  await key('k',{ctrlKey:true});
  check('Ctrl+K preserves draft and selection',await evalJS("(()=>{const i=document.getElementById('prompt-input');return i.value==='draft selection'&&i.selectionStart===2&&i.selectionEnd===7&&!document.getElementById('slash-menu').hidden})()"));
  await evalJS("document.querySelector('#slash-copy')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(80);
  check('fallback copies and restores draft focus and selection',await evalJS("(()=>{const i=document.getElementById('prompt-input');return clipWrites.length===1&&document.activeElement===i&&i.value==='draft selection'&&i.selectionStart===2&&i.selectionEnd===7})()"));
  check('successful retry clears the old copy error',await evalJS("document.getElementById('global-error').hidden"));
  await key('k',{ctrlKey:true});
  const shots = path.join(root,'.tmp','copy-shots'); await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'copy-menu.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await key('Escape');
  await type('typing after commands');
  check('typing exits command palette',await evalJS("document.getElementById('slash-menu').hidden"));
  await type('/co'); await key('k',{ctrlKey:true});
  await evalJS("document.querySelector('#slash-copy').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(40);
  check('command palette consumes a recognized slash prefix',await inputValue()==='');
  await type('/unknown-path'); await key('k',{ctrlKey:true});
  await evalJS("document.querySelector('#slash-copy').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))"); await sleep(40);
  check('command palette preserves literal slash text',await inputValue()==='/unknown-path');
  check('copy commands do not send, stop or navigate',await evalJS("['chat_send','chat_stop','chat_new'].every(x=>__mock.count(x)===0)"));
  await open('/',{settings:{animations:'off',autoDismiss:0}}); await stub(); await copy();
  check('empty conversation does not write clipboard',await evalJS("clipWrites.length===0&&document.getElementById('command-feedback').textContent.includes('No messages')"));
  await key('Escape');
  check('Escape dismisses feedback before hiding app',await evalJS("document.getElementById('command-feedback').hidden&&__mock.count('hide_main')===0"));
  await stub(); await send('Live unique prompt'); await waitFor("document.querySelector('[data-role=assistant]')?.dataset.status==='done'"); await copy();
  result=await evalJS('clipWrites[0]');
  check('live turn appears once',typeof result==='string' && result.split('Live unique prompt').length===2,String(result));
  await key('n',{ctrlKey:true});
  check('new chat clears copy feedback',await evalJS("document.getElementById('command-feedback').hidden"));
  await open('/',{chats:{v:1,current:chatSeed('quota',{prompt:'Recovered question',reply:'Recovered answer',transcript:[]}),recent:[]},settings:{animations:'off',autoDismiss:0}});
  await stub(); await copy(); result=await evalJS('clipWrites[0]');
  check('quota-reduced history keeps its recoverable prompt',result?.includes('Recovered question')&&result.includes('Recovered answer'),result);
  await open('/',{chats:{v:1,current:chatSeed('media',{prompt:'',reply:'',transcript:[{id:'file-user',role:'user',text:'',hadAttachments:true},{id:'file-assistant',role:'assistant',text:'',media:[{file:'file-test-id',name:'report.csv'}]}]}),recent:[]},settings:{animations:'off',autoDismiss:0}});
  await stub(); await copy(); result=await evalJS('clipWrites[0]');
  check('attachment metadata survives even without hasMedia',result?.includes('## You\n\n[Attachment]')&&result.includes('report.csv'),result);
  const gemini = {...chatSeed('gemini',{prompt:'Gemini-only prompt',reply:'Gemini-only answer'}),provider:'gemini'};
  await open('/',{chats:{v:1,current:gemini,recent:[chatSeed('other',{prompt:'Other provider secret',reply:'Do not copy'})]},settings:{animations:'off',autoDismiss:0}});
  await waitFor("__mock.provider==='gemini'"); await stub(); await copy();
  result=await evalJS('clipWrites[0]');
  check('Gemini copy has its own heading and no other chat',result?.includes('## Gemini') && result.includes('Gemini-only answer') && !/ChatGPT|Other provider secret|Do not copy/.test(result),result);
  await open('/',{settings:{animations:'off',autoDismiss:0,streamStyle:'instant'}}); await stub();
  await evalJS("__mock.hold=true"); await send('Streaming-only prompt');
  await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Visible partial answer.\\n\\n'})");
  await waitFor("document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Visible partial')");
  await copy(); result=await evalJS('clipWrites[0]');
  check('streaming copy includes a consistent visible partial once',result?.includes('Visible partial answer.') && result.split('Streaming-only prompt').length===2,result);
  check('copy leaves a stream running',await evalJS("__mock.count('chat_stop')===0&&document.querySelector('[data-role=assistant]').dataset.status==='streaming'"));
  await open('/',{settings:{animations:'off',autoDismiss:0,streamStyle:'paragraph'}}); await stub();
  await evalJS("__mock.hold=true"); await send('Unfinished block'); await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'```js\\nconst received = 42;'})");
  await sleep(50); await copy(); result=await evalJS('clipWrites[0]');
  check('copy includes received text held by paragraph pacing',result?.includes('const received = 42;'),result);
  await open('/',{chats:{v:1,current:chatSeed('async'),recent:[chatSeed('other')]},settings:{animations:'off',autoDismiss:0}});
  await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>window.finishCopy=resolve)}})");
  await type('/copy'); await key('Enter'); await waitFor("!!window.finishCopy");
  await evalJS("document.querySelector('#tabs [data-key=other]').click()"); await sleep(60);
  await evalJS("finishCopy()"); await sleep(60);
  check('copy completing after chat switch shows no stale notice',await evalJS("document.getElementById('command-feedback').hidden"));
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


