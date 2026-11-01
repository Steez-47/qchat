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
  browserPage = await openPage('keyboard-copy', { problems });
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

  const shortcut = async (k, extra={}) => { const prevented=await evalJS(`(()=>{const e=new KeyboardEvent('keydown',${JSON.stringify({key:k,ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true,...extra})});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`); await sleep(80); return prevented; };
  const reply='Answer <Entity name="kiwi"/> citeturn0search0\n\n```js\nfirst()\n```\n\n```js\nsecond()\n```';
  const transcript=[{id:'a',role:'assistant',text:reply,sources:[{id:'turn0search0',url:'https://example.com/kiwi',title:'Kiwi'}]}];
  const seed={v:1,current:chatSeed('copy',{transcript,reply}),recent:[chatSeed('other')]};
  await open('/?mock=signedin',{chats:seed,settings:{animations:'off',autoDismiss:0}}); await stub();
  await shortcut('C'); let value=await evalJS('clipWrites.at(-1)');
  await evalJS("document.querySelector('[data-action=copy-turn]').click()"); await sleep(50);
  check('reply matches button and resolves citations',value===await evalJS('clipWrites.at(-1)')&&value.includes('https://example.com/kiwi'),value);
  await shortcut('X'); check('last code block',await evalJS("clipWrites.at(-1).includes('second()')&&!clipWrites.at(-1).includes('first()')"));
  await open('/?mock=signedin',{keep:true}); await stub(); await shortcut('C'); check('restored reply',await evalJS("clipWrites.at(-1).includes('kiwi')"));
  await evalJS("document.querySelector('[data-action=dismiss-turn]').click()"); await shortcut('C'); check('dismissed reply',await evalJS("clipWrites.at(-1).includes('kiwi')"));
  await open('/?mock=signedin',{settings:{animations:'off',autoDismiss:0,streamStyle:'instant'}}); await stub(); await shortcut('C'); check('no reply',await evalJS("document.getElementById('command-feedback').textContent==='No reply to copy yet'"));
  await evalJS('__mock.hold=true'); await send('stream'); await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Partial reply'})"); await waitFor("document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Partial')"); await shortcut('C'); check('streaming partial',await evalJS("clipWrites.at(-1)==='Partial reply'")); await shortcut('X'); check('no code',await evalJS("document.getElementById('command-feedback').textContent==='No code in this reply'"));
  check('unfinished streamed paragraph stays buffered',await evalJS("!document.querySelector('[data-role=assistant] .turn-content p')"));
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Partial reply\\n\\n'})");
  await waitFor("document.querySelector('[data-role=assistant] .turn-content p')?.textContent==='Partial reply'");
  await evalJS("(()=>{const n=document.querySelector('[data-role=assistant] .turn-content p').firstChild,r=document.createRange();r.setStart(n,0);r.setEnd(n,7);getSelection().removeAllRanges();getSelection().addRange(r)})()"); await shortcut('C'); check('reply selection',await evalJS("clipWrites.at(-1)==='Partial'&&getSelection().toString()==='Partial'"));
  await type('draft text'); await evalJS("(()=>{const i=document.getElementById('prompt-input');i.focus();i.setSelectionRange(0,5)})()"); await shortcut('C'); check('composer selection and focus',await evalJS("clipWrites.at(-1)==='draft'&&document.activeElement.id==='prompt-input'&&document.activeElement.selectionStart===0&&document.activeElement.selectionEnd===5"));
  await key('p',{ctrlKey:true}); await waitFor("!!document.querySelector('.feature-search')"); await evalJS("document.querySelector('.feature-search').focus()"); let n=await evalJS('clipWrites.length'); let prevented=await shortcut('C'); check('chat search unaffected',!prevented&&await evalJS('clipWrites.length')===n);
  await evalJS("document.getElementById('prompt-input').focus()"); prevented=await shortcut('C',{isComposing:true}); check('IME ignored',!prevented&&await evalJS('clipWrites.length')===n);
  await stub('throw'); await shortcut('C'); check('clipboard failure',await evalJS("document.body.textContent.includes(\"Couldn't copy. Try again.\") && document.getElementById('command-feedback').textContent!=='Reply copied'"));
  await open('/?mock=signedin',{settings:{animations:'off',autoDismiss:0,streamStyle:'instant'}}); await stub(); await evalJS('__mock.hold=true'); await send('code stream'); await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'```js\\nstreamed()'})");
  await shortcut('X'); check('streaming code block',await evalJS("clipWrites.at(-1).includes('streamed()')"));
  check('unfinished streamed code stays buffered',await evalJS("!document.querySelector('[data-role=assistant] pre code')"));
  await open('/?mock=signedin',{chats:seed,settings:{animations:'off',autoDismiss:0}}); await stub(); await key('p',{ctrlKey:true}); await waitFor("!!document.querySelector('.feature-search')"); await evalJS("[...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent==='other').querySelector('[aria-label=\"Remove chat\"]').click()"); await evalJS("document.getElementById('prompt-input').focus()"); await shortcut('C'); check('undo retained',await evalJS("!!document.querySelector('#command-feedback button')"));
  await key('Escape'); await type('/keys'); await key('Enter'); await sleep(100); check('/keys lists shortcuts',await evalJS("document.body.textContent.includes('Ctrl+Shift+C')&&document.body.textContent.includes('Ctrl+Shift+X')"));
  await key('Escape'); await key('k',{ctrlKey:true,shiftKey:true}); check('Ctrl+Shift+K opens menu',await evalJS("!document.getElementById('slash-menu').hidden"));
  await open('/?mock=signedin',{chats:seed,settings:{animations:'off',autoDismiss:0}});await stub();
  await evalJS("(()=>{const editor=document.createElement('div');editor.id='embedded-editor';editor.contentEditable='plaintext-only';editor.tabIndex=0;editor.textContent='editable text';document.body.append(editor);editor.focus()})()");
  prevented=await shortcut('C');check('plaintext-only editors keep their keyboard behavior',!prevented&&await evalJS('clipWrites.length===0'));
  await open('/?mock=signedin',{settings:{animations:'off',autoDismiss:0,streamStyle:'paragraph'}});await stub();await evalJS('__mock.hold=true');await send('two streamed code blocks');await waitFor("__mock.count('chat_send')===1");
  await evalJS("__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'```js\\nfirst()\\n```\\n\\n```js\\nsecond()'})");await waitFor("document.querySelector('[data-role=assistant] pre code')?.textContent.includes('first()')");await shortcut('X');
  check('last code uses the received snapshot while paragraph reveal buffers',await evalJS("clipWrites.at(-1).includes('second()')&&!clipWrites.at(-1).includes('first()')"));
  const mediaReply='![Illustration](qchat-web:photo)\n\n```md\n![literal](qchat-web:example)\n![public](https://example.com/p.png)\n```\n\n`![inline](qchat-web:example)`';
  await open('/?mock=signedin',{chats:{v:1,current:chatSeed('image-copy',{reply:mediaReply}),recent:[]},settings:{animations:'off',autoDismiss:0}});await stub();await shortcut('C');value=await evalJS('clipWrites.at(-1)');
  check('reply copy replaces image references and preserves code examples',value?.includes('[Image: Illustration]')&&value.includes('![literal](qchat-web:example)')&&value.includes('![public](https://example.com/p.png)')&&value.includes('`![inline](qchat-web:example)`')&&!value.includes('qchat-web:photo'),value);
  await evalJS("document.querySelector('[data-action=copy-turn]').click()");await sleep(30);check('reply button shares readable copy formatting',value===await evalJS('clipWrites.at(-1)'));
  await evalJS("document.getElementById('btn-history').click();document.querySelector('#history-panel [data-action=history-copy]').click()");await sleep(30);check('history reply copy shares readable formatting',value===await evalJS('clipWrites.at(-1)'));
  const privateReply='```text\nhttps://files.oaiusercontent.com/test-only-private\n```';
  await open('/?mock=signedin',{chats:{v:1,current:chatSeed('private-copy',{reply:privateReply}),recent:[]},settings:{animations:'off',autoDismiss:0}});await stub();await shortcut('C');
  check('signed media references remain redacted inside code',await evalJS("!(clipWrites.at(-1)||'').includes('test-only-private')&&!localStorage.getItem('qchat.chats').includes('test-only-private')"));
  await open('/?mock=signedin',{chats:seed,settings:{animations:'off',autoDismiss:0}});await stub();
  await evalJS("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>window.finishClipboard=resolve)}})");
  const pendingKey=await evalJS("(()=>{const e=new KeyboardEvent('keydown',{key:'C',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true});document.getElementById('prompt-input').dispatchEvent(e);return e.defaultPrevented})()");
  await waitFor('!!window.finishClipboard');await evalJS("document.querySelector('[data-action=dismiss-turn]').click();finishClipboard()");await sleep(50);
  check('late copy completion does not reopen dismissed feedback',pendingKey&&await evalJS("document.getElementById('command-feedback').hidden"));
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


