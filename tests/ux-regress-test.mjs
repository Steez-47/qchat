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
  browserPage = await openPage('ux-regress', { problems });
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
  const section = async (label, fn) => {
    try { await fn(); } catch (e) { check(`${label} completed`, false, e.message); }
  };
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

  await section('1 dismiss during streaming', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('dismiss the stream');
    await waitFor(`__mock.last('chat_send')`);
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Partial text before dismissal.'})`);
    await waitFor(`(document.querySelector('[data-role=assistant] .turn-content')?.textContent||'').includes('Partial')`);
    const before = await count('chat_stop');
    await evalJS(`document.querySelector('[data-action=dismiss-turn]').click()`);
    const stopped = await waitFor(`__mock.count('chat_stop')>${before}`);
    const gone = await waitFor(`!document.querySelector('[data-role=assistant]')`);
    check('dismissing a streaming reply stops the backend', stopped && gone);
    await evalJS(`__mock.hold=false`);
    const sends = await count('chat_send');
    await send('send after dismissal');
    const accepted = await waitFor(`__mock.count('chat_send')>${sends}`);
    check('the next send is not blocked as busy', accepted);
  });

  await section('2 attachment error and sign-in state', async () => {
    await open('/?mock=signedin', { settings: { animations: 'off', autoDismiss: 0 } });
    await waitFor(`document.getElementById('status-dot').dataset.state==='ready'`);
    const beforeNotice = await evalJS(`document.getElementById('guest-notice').hidden`);
    const beforeLabel = await evalJS(`document.getElementById('status-label').textContent`);
    await evalJS(`(()=>{const d=new DataTransfer();for(let i=0;i<11;i++)d.items.add(new File(['x'],'file'+i+'.txt'));document.getElementById('prompt-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,cancelable:true,bubbles:true}));})()`);
    await waitFor(`!document.getElementById('global-error').hidden`);
    const state = await evalJS(`({label:document.getElementById('status-label').textContent,dot:document.getElementById('status-dot').dataset.state,guest:document.getElementById('guest-notice').hidden,text:document.getElementById('global-error-text').textContent})`);
    check('an attachment error never turns a signed-in user into a guest', beforeNotice && state.guest && state.dot !== 'signed-out' && state.label !== 'Signed out' && state.label !== 'Guest', JSON.stringify(state));
    check('the attachment error is still shown', state.text.includes('512 MB'));
    await evalJS(`document.getElementById('btn-error-dismiss').click()`);
    await sleep(30);
    check('dismissing the error keeps the signed-in ready state', await evalJS(`document.getElementById('status-dot').dataset.state==='ready' && document.getElementById('status-label').textContent===${JSON.stringify(beforeLabel)}`));
  });

  await section('3 clear recent chats', async () => {
    const chats = { v: 1, current: chatSeed('clear-current', { prompt: 'remember this', reply: 'remembered reply' }), recent: [chatSeed('clear-old')] };
    await open('/', { chats, settings: { animations: 'off', autoDismiss: 0 } });
    await waitFor(`document.querySelector('[data-role=assistant]')`);
    await evalJS(`__mock.emit('qchat://clear-chats',null)`);
    await sleep(50);
    const stored = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));return {recent:s.recent.length,transcript:s.current.transcript.length,prompt:s.current.lastPrompt,response:s.current.lastResponse};})()`);
    check('clearing always resets the current chat', stored.recent === 0 && stored.transcript === 0 && !stored.prompt && !stored.response, JSON.stringify(stored));
    check('clearing dismisses the visible exchange', await evalJS(`!document.querySelector('.turn-row')`));
    await open('/', { keep: true });
    await sleep(80);
    check('nothing returns after a restart', await evalJS(`!document.querySelector('.turn-row') && !document.querySelector('#tabs .tab')`));
  });

  await section('4 stop before text', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('restore this prompt');
    await waitFor(`__mock.last('chat_send')`);
    await sleep(30);
    await evalJS(`document.getElementById('btn-send').click()`);
    const restored = await waitFor(`document.getElementById('prompt-input').value==='restore this prompt'`);
    const cleared = await waitFor(`!document.querySelector('.turn-row')`);
    check('stopping before any text restores the prompt and removes the exchange', restored && cleared);
    check('the restored composer can send again', await evalJS(`!document.getElementById('btn-send').disabled && document.getElementById('btn-send').dataset.mode==='send'`));
    const sends = await count('chat_send');
    await send('keep the typed draft');
    await waitFor(`__mock.count('chat_send')>${sends}`);
    await sleep(30);
    await type('my newer draft');
    await evalJS(`document.getElementById('btn-send').click()`);
    await sleep(60);
    check('a newer draft is not overwritten by the stopped prompt', await inputValue() === 'my newer draft' && await evalJS(`!document.querySelector('.turn-row')`));
  });

  await section('5 composer before ready', async () => {
    await open('/?status=hold&connect=60000', { settings: { animations: 'off', autoDismiss: 0 } });
    const connecting = await evalJS(`document.getElementById('prompt-input').placeholder`);
    await type('draft while connecting');
    const disabled = await evalJS(`document.getElementById('btn-send').disabled`);
    check('the placeholder explains the wait and Send stays disabled', connecting === 'Connecting…' && disabled, connecting);
    const before = await count('chat_send');
    await key('Enter');
    await sleep(30);
    check('Enter while connecting keeps the draft and sends nothing', await count('chat_send') === before && await inputValue() === 'draft while connecting');
    await evalJS(`__mock.emit('bridge',{type:'status',ready:true,loggedIn:false,url:'https://chatgpt.com/'})`);
    await sleep(30);
    check('ready restores the command hint and enables Send', await evalJS(`document.getElementById('prompt-input').placeholder==='Ask anything · / commands' && !document.getElementById('btn-send').disabled`));
    await key('Enter');
    check('Enter sends once ready', await waitFor(`__mock.count('chat_send')>${before}`));
  });

  await section('6 connection deadline and retry', async () => {
    await open('/?mock=signedin&status=hold&connect=300', { settings: { animations: 'off', autoDismiss: 0 } });
    const shown = await waitFor(`!document.getElementById('global-error').hidden`, 4000);
    const state = await evalJS(`({text:document.getElementById('global-error-text').textContent,retry:document.getElementById('btn-error-signin').textContent,hidden:document.getElementById('btn-error-signin').hidden,dot:document.getElementById('status-dot').dataset.state})`);
    check('a silent connection shows the deadline error and a retry', shown && state.text === "Can't reach ChatGPT. Check your connection, then try again." && state.retry === 'Try again' && !state.hidden && state.dot === 'error', JSON.stringify(state));
    await evalJS(`__mock.statusHold=false; document.getElementById('btn-error-signin').click()`);
    const ready = await waitFor(`document.getElementById('status-dot').dataset.state==='ready'`);
    check('retry checks the connection and clears the error when ready', ready && await evalJS(`document.getElementById('global-error').hidden && document.getElementById('prompt-input').placeholder==='Ask anything · / commands'`));
    check('the retry button returns to Sign in afterwards', await evalJS(`document.getElementById('btn-error-signin').textContent==='Sign in' && document.getElementById('btn-error-signin').dataset.action==='signin'`));
    await evalJS(`__mock.statusHold=true; __mock.emit('bridge',{type:'status',ready:false,loggedIn:true,url:'https://chatgpt.com/'}); __mock.emit('qchat://shown',null)`);
    const rearmed = await waitFor(`!document.getElementById('global-error').hidden`, 4000);
    check('showing the window again re-arms the deadline', rearmed);
  });

  await section('7 slash selection reset', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await type('/');
    await key('ArrowDown');
    await key('ArrowDown');
    check('arrow keys still move the selection', await evalJS(`document.getElementById('prompt-input').getAttribute('aria-activedescendant')==='slash-signin'`));
    await type('/s');
    check('a changed match set selects the first row again', await evalJS(`document.getElementById('prompt-input').getAttribute('aria-activedescendant')==='slash-settings' && document.getElementById('slash-settings').getAttribute('aria-selected')==='true'`));
  });

  await section('slash menu geometry and stability', async () => {
    const current = chatSeed('slash-layout');
    await open('/?mock=signedin', { chats: { v: 1, current, recent: [chatSeed('slash-recent')] }, settings: { animations: 'on', autoDismiss: 0 } });
    await waitFor(`document.querySelector('.bubble-response') && !document.getElementById('tabs').hidden`);
    await sleep(700);
    const frames = await evalJS(`(async()=>{
      const input=document.getElementById('prompt-input'), bar=document.getElementById('bar'), menu=document.getElementById('slash-menu');
      const geometry=()=>({bar:bar.getBoundingClientRect().top,bubble:document.querySelector('.bubble-response').getBoundingClientRect().top,menuTop:menu.getBoundingClientRect().top,menuBottom:menu.getBoundingClientRect().bottom,open:!menu.hidden});
      const baseline=geometry(), samples=[];
      for(const value of ['/', '/s', '/settings', '']) {
        input.value=value; input.dispatchEvent(new Event('input',{bubbles:true}));
        for(let i=0;i<22;i++) { await new Promise(requestAnimationFrame); samples.push(geometry()); }
      }
      return {baseline,samples};
    })()`);
    check('slash commands stay above the chat input', frames.samples.filter(s => s.open).every(s => s.menuBottom <= s.bar + 1 && s.menuTop >= 0), JSON.stringify(frames.samples.filter(s => s.open).slice(0, 2)));
    check('opening, filtering and closing commands keeps the input still', frames.samples.every(s => Math.abs(s.bar - frames.baseline.bar) <= 1));
    check('opening, filtering and closing commands keeps the reply still', frames.samples.every(s => Math.abs(s.bubble - frames.baseline.bubble) <= 1));
    await key('k', { ctrlKey: true });
    await sleep(350);
    check('Ctrl+K command menu also opens above the input', await evalJS(`(()=>{const m=document.getElementById('slash-menu'),b=document.getElementById('bar');return !m.hidden && m.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+1;})()`));
    await mkdir(path.join(root, '.tmp/slash-menu'), { recursive: true });
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(root, '.tmp/slash-menu/commands.png'), Buffer.from(shot.data, 'base64'));
    await key('Escape');
  });

  await section('8 history mirrors the live reveal', async () => {
    const current = chatSeed('mirror', { conv: 'conv-mirror' });
    await open('/', { chats: { v: 1, current, recent: [] }, settings: { animations: 'on', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('mirror this reply');
    await waitFor(`__mock.last('chat_send')`);
    await evalJS(`QSettings.apply(document.documentElement,{...QSettings.settings,streamStyle:'fade'})`);
    const full = 'A completed paragraph.\n\n'+'abcdefghij '.repeat(20);
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(full)}})`);
    const growing = await waitFor(`(document.querySelector('#bubble-zone [data-role=assistant] .turn-content')?.textContent||'').length>2`, 3000);
    await evalJS(`document.getElementById('btn-history').click()`);
    await sleep(80);
    const state = await evalJS(`(()=>{const live=(document.querySelector('#bubble-zone [data-role=assistant] .turn-content')?.textContent||'').trimEnd();const rows=[...document.querySelectorAll('#history-panel [data-role=assistant] .turn-content')];return {live,last:(rows.at(-1)?.textContent||'').trimEnd(),full:${JSON.stringify(full)}};})()`);
    check('History shows the same text as the live bubble while streaming', growing && state.last === state.live && state.last.length < state.full.length, JSON.stringify(state));
  });

  await section('9 backfill retries after a chat switch', async () => {
    const current = chatSeed('retry-a', { conv: 'conv-retry-a' });
    const other = chatSeed('retry-b', { prompt: 'b prompt', reply: 'b reply' });
    await open('/', { chats: { v: 1, current, recent: [other] }, settings: { animations: 'off', autoDismiss: 0 } });
    const before = await count('chat_read_transcript');
    await evalJS(`(()=>{document.getElementById('btn-history').click();document.querySelector('#tabs .tab[data-key=retry-b]').click();})()`);
    await sleep(120);
    await evalJS(`document.querySelector('#tabs .tab[data-key=retry-a]').click()`);
    await sleep(80);
    await evalJS(`document.getElementById('btn-history').click()`);
    const retried = await waitFor(`__mock.count('chat_read_transcript')>${before}`, 2500);
    check('opening the chat again retries a skipped backfill', retried);
  });

  await section('10 retry focus', async () => {
    await open('/?mock=error', { settings: { animations: 'off', autoDismiss: 0 } });
    await send('retry this');
    const offered = await waitFor(`document.querySelector('[data-action=retry-turn]')`);
    const before = await count('chat_send');
    await evalJS(`document.querySelector('[data-action=retry-turn]').click()`);
    await sleep(30);
    check('Retry sends again and focuses the prompt', offered && await count('chat_send') > before && await evalJS(`document.activeElement===document.getElementById('prompt-input')`));
  });

  await section('11 enter while streaming', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('streaming reply');
    await waitFor(`__mock.last('chat_send')`);
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'A streaming reply'})`);
    await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='streaming'`);
    await type('line one');
    const before = await count('chat_send');
    const canceled = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});document.getElementById('prompt-input').dispatchEvent(e);return e.defaultPrevented;})()`);
    await sleep(30);
    check('Enter during a stream is not consumed and sends nothing', canceled === false && await inputValue() === 'line one' && await count('chat_send') === before);
  });

  await section('12 drafts are per chat', async () => {
    const a = chatSeed('draft-a');
    const b = chatSeed('draft-b');
    await open('/', { chats: { v: 1, current: a, recent: [b] }, settings: { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true } });
    await type('draft for A');
    await evalJS(`document.querySelector('#tabs .tab[data-key=draft-b]').click()`);
    await sleep(40);
    check('switching loads the target chat draft', await inputValue() === '');
    await type('draft for B');
    await evalJS(`document.querySelector('#tabs .tab[data-key=draft-a]').click()`);
    await sleep(40);
    check('switching back restores the saved draft', await inputValue() === 'draft for A');
    const stored = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));return {current:s.current.draft,recent:s.recent.map(c=>({key:c.key,draft:c.draft}))};})()`);
    check('drafts persist through saveChats', stored.current === 'draft for A' && stored.recent.some(c => c.key === 'draft-b' && c.draft === 'draft for B'), JSON.stringify(stored));
    await open('/', { keep: true });
    await sleep(40);
    check('the current draft survives a restart', await inputValue() === 'draft for A');
    await type('outgoing draft');
    await evalJS(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await sleep(320);
    const fresh = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));const old=s.recent.find(c=>c.key==='draft-a');return {input:document.getElementById('prompt-input').value,rows:document.querySelectorAll('.turn-row').length,oldDraft:old?.draft,currentKey:s.current.key};})()`);
    check('New chat starts empty and keeps the outgoing draft on the old chat', fresh.input === '' && fresh.rows === 0 && fresh.oldDraft === 'outgoing draft' && fresh.currentKey !== 'draft-a', JSON.stringify(fresh));
  });

  await section('13 escape during composition', async () => {
    const current = chatSeed('escape-chat', { prompt: 'escape prompt', reply: 'escape reply' });
    await open('/', { chats: { v: 1, current, recent: [] }, settings: { animations: 'off', autoDismiss: 0 } });
    await waitFor(`document.querySelector('[data-role=assistant]')`);
    const hides = await count('hide_main');
    const composing = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true});window.dispatchEvent(e);return e.defaultPrevented;})()`);
    const composing229 = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,keyCode:229});window.dispatchEvent(e);return e.defaultPrevented;})()`);
    await sleep(30);
    check('Esc is ignored while the IME is composing', composing === false && composing229 === false && await count('hide_main') === hides && await evalJS(`!!document.querySelector('[data-role=assistant]')`));
    const normal = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()`);
    await sleep(60);
    check('a normal Esc still dismisses the reply', normal === true && await evalJS(`!document.querySelector('[data-role=assistant]')`));
  });

  await section('14 paste and drop while streaming', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('busy paste');
    await waitFor(`__mock.last('chat_send')`);
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Working on it'})`);
    await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='streaming'`);
    const state = await evalJS(`(()=>{
      const input=document.getElementById('prompt-input');
      const files=new DataTransfer();files.items.add(new File(['x'],'busy.txt'));
      const pasted=input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:files,cancelable:true,bubbles:true}));
      const dropped=document.getElementById('stage').dispatchEvent(new DragEvent('drop',{dataTransfer:files,cancelable:true,bubbles:true}));
      const text=new DataTransfer();text.setData('text/plain','plain text');
      const plain=input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:text,cancelable:true,bubbles:true}));
      return {pasted,dropped,plain,error:document.getElementById('global-error-text').textContent};
    })()`);
    check('file paste and drop during a stream are explained, not swallowed', state.pasted === true && state.dropped === true && state.error === 'Finish or stop the reply first.', JSON.stringify(state));
    check('plain text paste stays native during a stream', state.plain === true);
    await evalJS(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await sleep(120);
    const accepted = await evalJS(`(()=>{const d=new DataTransfer();d.items.add(new File(['y'],'accepted.txt'));return document.getElementById('prompt-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,cancelable:true,bubbles:true}));})()`);
    const staged = await waitFor(`document.querySelector('#attachments [data-state=ready]')`);
    check('an accepted file paste is taken over and staged', accepted === false && staged && await evalJS(`document.getElementById('attachments').textContent.includes('accepted.txt')`));
  });

  await section('15 failed attachment does not block send', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`window.__realInvoke=window.__TAURI__.core.invoke;window.__TAURI__.core.invoke=(cmd,args)=>cmd==='attachment_finish'?Promise.reject(new Error('synthetic failure')):window.__realInvoke(cmd,args)`);
    await evalJS(`(()=>{const d=new DataTransfer();d.items.add(new File(['z'],'broken.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'));})()`);
    const errored = await waitFor(`document.querySelector('#attachments [data-state=error]')`);
    await evalJS(`window.__TAURI__.core.invoke=window.__realInvoke;delete window.__realInvoke`);
    await type('send with a failed attachment');
    const disabled = await evalJS(`document.getElementById('btn-send').disabled`);
    const before = await count('chat_send');
    await evalJS(`document.getElementById('btn-send').click()`);
    const sent = await waitFor(`__mock.count('chat_send')>${before}`);
    const args = await evalJS(`__mock.last('chat_send')?.args`);
    check('a failed attachment leaves Send enabled but is not sent', errored && disabled === false && sent && args.prompt === 'send with a failed attachment' && Array.isArray(args.attachmentIds) && args.attachmentIds.length === 0, JSON.stringify(args));
    check('the failed chip remains until dismissed', await evalJS(`!!document.querySelector('#attachments [data-state=error]')`));
  });

  await section('16 new chat while streaming', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`__mock.hold=true`);
    await send('stop with new chat');
    await waitFor(`__mock.last('chat_send')`);
    const firstKey = await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key`);
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Partial answer'})`);
    await waitFor(`(document.querySelector('[data-role=assistant] .turn-content')?.textContent||'').includes('Partial')`);
    const stops = await count('chat_stop');
    await evalJS(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}))`);
    const cleared = await waitFor(`!document.querySelector('.turn-row')`, 3000);
    const stored = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));const old=s.recent.find(c=>c.key===${JSON.stringify(firstKey)});const a=old?.transcript.filter(i=>i.role==='assistant').at(-1);return {newKey:s.current.key,text:a?.text,stopped:a?.stopped,last:old?.lastResponse};})()`);
    check('New chat stops the reply and keeps its partial in history', cleared && await count('chat_stop') > stops && stored.newKey !== firstKey && stored.text === 'Partial answer' && stored.stopped === true && stored.last === 'Partial answer', JSON.stringify(stored));
    await open('/', { keep: true });
    await sleep(100);
    await evalJS(`document.querySelector('#tabs .tab[data-key=${JSON.stringify(firstKey)}]').click()`);
    await sleep(80);
    await evalJS(`document.getElementById('btn-history').click()`);
    const noted = await waitFor(`document.querySelector('#history-panel .turn-note')`);
    check('a stopped reply is marked in history after a restart', noted && await evalJS(`document.querySelector('#history-panel .turn-note').textContent==='Stopped'`));
  });

  await section('17 reply announcement', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    check('the streamed log is no longer a live region', await evalJS(`document.getElementById('bubble-zone').getAttribute('aria-live')==='off'`));
    await evalJS(`__mock.reply='Short reply.';__mock.interval=1`);
    await send('announce this');
    const done = await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`);
    check('finishing a reply is announced once through the polite status', done && await evalJS(`document.getElementById('status-label').textContent==='ChatGPT replied'`));
  });

  await section('18 stored text cap and quota', async () => {
    await open('/', { settings: { animations: 'off', autoDismiss: 0 } });
    const long = 'a'.repeat(45000);
    await evalJS(`__mock.reply=${JSON.stringify(long)};__mock.interval=1`);
    await send('store a long reply');
    const done = await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 8000);
    const stored = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));const a=s.current.transcript.filter(i=>i.role==='assistant').at(-1);return {last:s.current.lastResponse.length,message:a?.text.length,end:a?.text.endsWith('…')};})()`);
    check('long replies stay complete when storage has room', done && stored.last === 45000 && stored.message === 45000 && !stored.end, JSON.stringify(stored));

    // Only quota pressure caps stored copies; the existing history reload check
    // requires normal saves to keep the full transcript.
    await evalJS(`(()=>{const real=Storage.prototype.setItem;window.__restoreSetItem=()=>{Storage.prototype.setItem=real;};Storage.prototype.setItem=function(key,value){if(key==='qchat.chats'&&value.length>85000)throw new DOMException('quota','QuotaExceededError');return real.call(this,key,value);};})()`);
    await evalJS(`__mock.reply=${JSON.stringify(long)};__mock.interval=1`);
    await send('store another long reply');
    await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 8000);
    const capped = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));const a=s.current.transcript.filter(i=>i.role==='assistant').at(-1);return {last:s.current.lastResponse.length,lastEnd:s.current.lastResponse.endsWith('…'),message:a?.text.length,messageEnd:a?.text.endsWith('…')};})()`);
    await evalJS(`window.__restoreSetItem()`);
    check('under quota pressure, stored messages cap at 40000 with an ellipsis', capped.last === 40000 && capped.lastEnd && capped.message === 40000 && capped.messageEnd, JSON.stringify(capped));

    const current = chatSeed('quota-current', { prompt: 'quota prompt', reply: 'current reply' });
    const old = chatSeed('quota-old', { transcript: [{ id: 'old-u', role: 'user', text: 'old transcript only marker', hasMedia: false, sources: [] }, { id: 'old-a', role: 'assistant', text: 'old transcript only marker', hasMedia: false, stopped: false, sources: [] }] });
    await open('/', { chats: { v: 1, current, recent: [old] }, settings: { animations: 'off', autoDismiss: 0 } });
    await evalJS(`(()=>{const real=Storage.prototype.setItem;window.__restoreSetItem=()=>{Storage.prototype.setItem=real;};Storage.prototype.setItem=function(key,value){if(key==='qchat.chats'&&value.includes('old transcript only marker')){window.__quotaHit=true;throw new DOMException('quota','QuotaExceededError');}return real.call(this,key,value);};})()`);
    await evalJS(`__mock.hold=true`);
    await send('quota trigger');
    await waitFor(`window.__quotaHit`);
    await evalJS(`window.__restoreSetItem()`);
    const after = await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.chats'));const oldChat=s.recent.find(c=>c.key==='quota-old');return {oldTranscript:oldChat?.transcript.length,currentTranscript:s.current.transcript.length,response:s.current.lastResponse,prompt:s.current.lastPrompt};})()`);
    check('quota pressure drops the oldest recent transcript but keeps the current chat', after.oldTranscript === 0 && after.currentTranscript > 0 && after.response === 'current reply' && after.prompt, JSON.stringify(after));
  });

  await section('19 settings upgrade', async () => {
    await open('/', { settings: { v: 1, glassOpacity: 90, shimmer: true, look: 'frost', textSize: 16 } });
    const upgraded = await evalJS(`(()=>{const s=QSettings.settings;const stored=JSON.parse(localStorage.getItem('qchat.settings'));return {glass:s.glassOpacity,shimmer:s.shimmer,look:s.look,textSize:s.textSize,v:stored.v,version:QSettings.VERSION,storedGlass:stored.glassOpacity};})()`);
    check('older saved settings get the new glass default and keep the rest', upgraded.glass === 62 && upgraded.shimmer === false && upgraded.look === 'frost' && upgraded.textSize === 16, JSON.stringify(upgraded));
    check('the upgrade is written back once as the current version', upgraded.v === upgraded.version && upgraded.storedGlass === 62, JSON.stringify(upgraded));
    await open('/', { settings: { v: 2, glassOpacity: 90 } });
    const current = await evalJS(`(()=>{const stored=JSON.parse(localStorage.getItem('qchat.settings'));return {glass:QSettings.settings.glassOpacity,storedGlass:stored.glassOpacity,v:stored.v,version:QSettings.VERSION};})()`);
    check('version 2 settings keep their glass through the upgrade', current.glass === 90 && current.storedGlass === 90 && current.v === current.version, JSON.stringify(current));
  });

  check('no runtime errors', problems.length === 0, problems.slice(0, 3).join(' | '));
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
