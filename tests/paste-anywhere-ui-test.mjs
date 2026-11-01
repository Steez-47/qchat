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
  browserPage = await openPage('chat-undo', { problems });
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


  const settings = { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true };
  const seed = () => ({v:1, current:chatSeed('current',{draft:'current draft'}), recent:[chatSeed('a',{draft:'draft a'}),chatSeed('b',{draft:'draft b'}),chatSeed('c')]});
  const state = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const setup = async (data=seed(), opts=settings) => { await open('/?mock=signedin', {chats:data,settings:opts}); await sleep(150); };
  const run = expression => evalJS(`(async()=>{${expression}})()`);
  const setupPaste = async () => { await setup(); await run(`
    window.pasteTest = (target, mode, text='') => {
      const f = new File(['image'], 'shot.png', {type:'image/png'});
      const dt = new DataTransfer();
      if (mode === 'file' || mode === 'both') dt.items.add(f);
      if (text) dt.setData('text/plain', text);
      const event = new Event('paste', {bubbles:true,cancelable:true});
      const data = mode === 'items' ? {files:[], items:[{kind:'file',getAsFile:()=>f}], getData:()=>text} : dt;
      Object.defineProperty(event, 'clipboardData', {value:data});
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.chips = () => document.querySelectorAll('#attachments .attachment-chip').length;
  `); };
  await setupPaste();
  check('image paste on body stages and focuses', await run(`document.activeElement.blur(); const prevented=pasteTest(document.body,'file'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1 && document.activeElement.id==='prompt-input';`));
  await setupPaste();
  check('image paste on tab stages and focuses', await run(`const tab=document.querySelector('#tabs button'); if(!tab)return false; tab.focus(); const prevented=pasteTest(tab,'file'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1 && document.activeElement.id==='prompt-input';`));
  await setupPaste();
  check('items-only file stages', await run(`const prevented=pasteTest(document.body,'items'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1;`));
  await setupPaste();
  check('file present in files and items stages once', await run(`const prevented=pasteTest(document.body,'both'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1;`));
  await setupPaste();
  check('mixed clipboard follows composer file behavior', await run(`const p=document.querySelector('#prompt-input'), before=p.value; const prevented=pasteTest(document.body,'both','ignored text'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1 && p.value===before;`));
  await setupPaste();
  check('text inserts at saved selection and focuses', await run(`const p=document.querySelector('#prompt-input'); p.value='hello world'; p.setSelectionRange(6,11); document.body.focus(); p.blur(); const prevented=pasteTest(document.body,'none','friend'); return prevented && p.value==='hello friend' && p.selectionStart===12 && p.selectionEnd===12 && document.activeElement===p;`));
  await sleep(900);
  check('pasted text persists as draft', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.draft==='hello friend'`));
  await setupPaste(); await key('p',{ctrlKey:true}); await waitFor(`!!document.querySelector('.feature-search')`);
  check('search input paste remains native', await run(`const p=document.querySelector('#prompt-input'), search=document.querySelector('.feature-search'); search.focus(); const before=p.value; const prevented=pasteTest(search,'file','text'); return !prevented && p.value===before && chips()===0 && document.activeElement===search;`));
  await setupPaste();
  check('composer text paste is not intercepted twice', await run(`const p=document.querySelector('#prompt-input'); p.focus(); const before=p.value; const prevented=pasteTest(p,'none','text'); return !prevented && p.value===before && document.activeElement===p;`));
  check('composer items-only paste stages once', await run(`const p=document.querySelector('#prompt-input'); const prevented=pasteTest(p,'items'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1;`));
  await setupPaste();
  check('composer files and items stage once', await run(`const p=document.querySelector('#prompt-input'); const prevented=pasteTest(p,'both','ignored text'); await new Promise(r=>setTimeout(r,80)); return prevented && chips()===1 && p.value==='current draft';`));
  await setupPaste();
  check('file limit shows existing notice', await run(`for(let i=0;i<11;i++) pasteTest(document.body,'file'); await new Promise(r=>setTimeout(r,100)); return chips()===10 && document.body.textContent.includes('Attach up to 10 files, totalling at most 512 MB.');`));
  await setupPaste();
  check('empty clipboard does nothing', await run(`const p=document.querySelector('#prompt-input'); p.blur(); const before=p.value; const prevented=pasteTest(document.body,'none'); return !prevented && p.value===before && chips()===0 && document.activeElement!==p;`));
  await setupPaste(); await key('k',{ctrlKey:true}); await evalJS(`document.querySelector('#slash-clear').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`); await waitFor(`!document.getElementById('clear-confirm').hidden`);
  check('clear confirmation blocks paste', await run(`const p=document.querySelector('#prompt-input'); const before=p.value; const prevented=pasteTest(document.body,'file','text'); return !prevented && p.value===before && chips()===0;`));
  check('clear confirmation blocks composer file paste', await run(`const p=document.querySelector('#prompt-input'); return !pasteTest(p,'file') && chips()===0;`));
  await setupPaste(); await evalJS(`__mock.hold=true`); await send('start stream'); await sleep(150);
  check('paste during held stream fills composer without sending', await run(`const before=__mock.count('chat_send'); const p=document.querySelector('#prompt-input'); p.blur(); const prevented=pasteTest(document.body,'none','next message'); await new Promise(r=>setTimeout(r,50)); return prevented && p.value==='next message' && __mock.count('chat_send')===before && document.activeElement===p;`));
  check('no runtime errors',problems.length===0,problems.slice(0,4).join(' | '));
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



