// Context switching: changing assistant mid-chat keeps the chat and quietly hands its history to
// the new one. Mock backend in an isolated, invisible Edge profile. No account or site access.
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
  browserPage = await openPage('context-switching-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const waitFor = async (expr, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(`!!(${expr})`)) return true; } catch {}
      await sleep(10);
    }
    return false;
  };
  const until = async (expr, ms) => { if (!await waitFor(expr, ms)) throw Error('Timed out: ' + expr); };
  const BASE = { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true };
  const open = async (url = '/?mock=signedin', { settings = BASE, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await waitFor(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings && !document.getElementById('btn-send').disabled || document.getElementById('prompt-input')`);
    await cdp('Page.bringToFront');
    await sleep(70);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const idle = `__mock.count('chat_send')>0 && !document.querySelector('[data-status=streaming]') && !document.getElementById('btn-reasoning').disabled`;
  const send = async (text) => {
    const before = await evalJS(`__mock.count('chat_send')`);
    await type(text); await key('Enter');
    await until(`__mock.count('chat_send')>${before}`);
    // The sent bubble rises away once the reply lands, so read it now.
    const bubble = await evalJS(`[...document.querySelectorAll('[data-role=user]')].at(-1)?.textContent.trim() ?? null`);
    await until(idle, 8000);
    await sleep(60);
    return bubble;
  };
  const switchTo = async (name) => {
    await key('k', { ctrlKey: true });
    await until(`!!document.getElementById("slash-${name}")`);
    await evalJS(`document.getElementById("slash-${name}").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))`);
    await until(`__mock.provider===${JSON.stringify(name)} && !document.getElementById('btn-reasoning').disabled`);
    await sleep(60);
  };
  const lastSend = () => evalJS(`__mock.last('chat_send').args`);
  const current = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current`);
  // The text of the staged history file, read back from the chunks the app uploaded.
  const stagedText = (since) => evalJS(`(()=>{const calls=__mock.calls.slice(${since});const begin=calls.findLast(c=>c.cmd==='attachment_begin');if(!begin)return null;const bytes=calls.filter(c=>c.cmd==='attachment_chunk').map(c=>atob(c.args.data)).join('');return {name:begin.args.name,mime:begin.args.mime,text:new TextDecoder().decode(Uint8Array.from(bytes,ch=>ch.charCodeAt(0)))};})()`);

  // A ready composer can appear during Gemini's reset, before the old chat is gone.
  await open();
  await send('Keep this context while Gemini resets');
  await switchTo('gemini');
  await evalJS(`(() => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== 'chat_new') return invoke(cmd, args);
      window.resetRequested = true;
      __mock.emit('bridge', {type:'status', provider:'gemini', ready:true, loggedIn:true,
        resetting:true, loadId:'gemini-resetting', url:'https://gemini.google.com/app'});
      return Promise.resolve();
    };
  })()`);
  const beforeReset = await evalJS(`__mock.count('chat_send')`);
  await type('Send this together with the history'); await key('Enter');
  await until('window.resetRequested'); await sleep(150);
  check('a ready composer during reset cannot send the hand-off', await evalJS(`__mock.count('chat_send')===${beforeReset}`));
  await evalJS(`__mock.emit('bridge',{type:'chat-reset',provider:'gemini'})`); await sleep(50);
  check('reset completion still waits for a ready composer', await evalJS(`__mock.count('chat_send')===${beforeReset}`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:true,resetting:false,loadId:'gemini-ready',url:'https://gemini.google.com/app'})`);
  await until(`__mock.count('chat_send')>${beforeReset}`); await until(idle);
  check('the settled Gemini page receives the history and new message together', (await lastSend()).prompt.endsWith('Send this together with the history') && (await lastSend()).attachmentIds.length === 1);

  await open();
  await send('History survives a reset that never finishes');
  await switchTo('gemini');
  await evalJS(`(() => {
    const invoke = window.__TAURI__.core.invoke;
    window.__TAURI__.core.invoke = (cmd, args) => {
      if (cmd !== 'chat_new') return invoke(cmd, args);
      __mock.emit('bridge', {type:'status',provider:'gemini',ready:true,loggedIn:true,
        resetting:true,loadId:'stalled-reset',url:'https://gemini.google.com/app'});
      return Promise.resolve();
    };
  })()`);
  const beforeStall = await evalJS(`__mock.count('chat_send')`);
  await type('Keep my unsent question'); await key('Enter');
  await until(`document.querySelector('[data-role=assistant][data-status=error]')`);
  check('a stalled reset returns the question and releases Send', await evalJS(`document.getElementById('prompt-input').value==='Keep my unsent question' && document.getElementById('btn-send').dataset.mode==='send' && __mock.count('chat_send')===${beforeStall}`));
  check('a stalled reset retains the pending history hand-off', Boolean((await current()).carry));

  // Default on, and offered in Settings.
  await open('/settings.html', { settings: null });
  check('Context switching is on by default', await evalJS(`QSettings.settings.contextSwitching===true`));
  check('Settings offers the Context switching toggle', await evalJS(`!!document.querySelector('[data-key="contextSwitching"]') && document.body.textContent.includes('Context switching')`));

  // Signed in: the history goes along as a hidden text file.
  await open();
  await send('Remember the word pineapple');
  const before = await evalJS(`({key:chats_key(),tabs:document.querySelectorAll('#tabs .tab').length})`.replace('chats_key()', `JSON.parse(localStorage.getItem('qchat.chats')).current.key`));
  await switchTo('gemini');
  let chat = await current();
  check('switching keeps the same chat', chat.key === before.key && chat.provider === 'gemini');
  check('the earlier exchange stays in the chat', chat.transcript.some(item => item.text === 'Remember the word pineapple') && chat.transcript.some(item => item.role === 'assistant'));
  check('no tab is split off for the old assistant', await evalJS(`document.querySelectorAll('#tabs .tab').length`) === before.tabs);
  check('the reply stays on screen', await evalJS(`!!document.querySelector('[data-role=assistant]')`));
  check('no attachment chip appears in the composer', await evalJS(`!document.querySelector('#attachments .attachment-chip')`));

  const calls = await evalJS(`__mock.calls.length`);
  const bubble = await send('What was the word?');
  const args = await lastSend();
  const staged = await stagedText(calls);
  check('the first Gemini message starts a fresh conversation', await evalJS(`__mock.calls.slice(${calls}).some(c=>c.cmd==='chat_new')`));
  check('the history goes as a text file', staged?.name === 'chat-history.txt' && staged?.mime === 'text/plain' && args.attachmentIds.length === 1, JSON.stringify(staged?.name));
  check('the file starts with the history note', staged?.text.startsWith('This is the chat history, respond accordingly.'), staged?.text.slice(0, 80));
  check('the file holds the earlier exchange', staged?.text.includes('Remember the word pineapple') && staged?.text.includes('## Assistant') && !staged?.text.includes('What was the word?'));
  check('the message tells the model to continue and ends with what was typed', args.prompt.includes('chat-history.txt') && args.prompt.endsWith('What was the word?'), args.prompt);
  check('the user only sees what they typed', bubble === 'What was the word?', bubble);
  chat = await current();
  check('the message is not marked as having attachments', chat.lastHadAttachments === false);
  check('the whole conversation stays in the transcript', chat.transcript.filter(item => item.text).length === 4 && chat.transcript.find(item => item.text === 'What was the word?'));
  check('the transcript keeps the typed prompt, not the note', !JSON.stringify(chat.transcript).includes('chat-history.txt'));
  check('the hand-off is done once the reply arrives', !chat.carry && chat.carried === true);

  await send('And one more');
  check('later messages go plainly', (await lastSend()).prompt === 'And one more' && (await lastSend()).attachmentIds.length === 0);

  await evalJS(`document.getElementById('btn-history').click()`);
  await until(`document.getElementById('history-panel').textContent.includes('And one more')`);
  const panel = await evalJS(`document.getElementById('history-panel').textContent`);
  check('History shows the whole chat and none of the hand-off', panel.includes('Remember the word pineapple') && panel.includes('What was the word?') && !panel.includes('chat-history') && !panel.includes('Treat it as'));
  check('nothing about the hand-off shows anywhere', !(await evalJS(`document.body.textContent`)).includes('chat-history'));

  await open('/?mock=signedin', { keep: true });
  chat = await current();
  check('a reload keeps the carried chat whole', chat.provider === 'gemini' && chat.carried === true && chat.transcript.filter(item => item.text).length === 6);

  // The account only holds what was said since the hand-off, so it never replaces the local record.
  const accountChat = (carried) => ({ v: 1, current: { key: 'acct', provider: 'gemini', conversationId: 'gem-1', ...(carried ? { carried: true } : {}), title: 'Carried', lastActive: 1000, createdAt: 900, lastPrompt: 'Second', lastResponse: 'Reply two', transcript: [{ id: 'u1', role: 'user', text: 'First' }, { id: 'a1', role: 'assistant', text: 'Reply one' }, { id: 'u2', role: 'user', text: 'Second' }, { id: 'a2', role: 'assistant', text: 'Reply two' }] }, recent: [] });
  const historyReads = async (carried) => {
    await open('/?mock=signedin', { chats: accountChat(carried) });
    await evalJS(`document.getElementById('btn-history').click()`);
    await until(`!document.getElementById('history-panel').hidden`); await sleep(200);
    return evalJS(`__mock.count('chat_read_transcript')`);
  };
  check('History reads the account copy of an ordinary chat', await historyReads(false) > 0);
  check('History never swaps a carried chat for the account copy', await historyReads(true) === 0);

  // Going straight back before sending reopens the old conversation as it was.
  const seeded = { v: 1, current: { key: 'seeded', provider: 'chatgpt', conversationId: 'conv-old', title: 'Seeded', lastActive: 1000, createdAt: 900, lastPrompt: 'Old question', lastResponse: 'Old reply', transcript: [{ id: 'u1', role: 'user', text: 'Old question' }, { id: 'a1', role: 'assistant', text: 'Old reply' }] }, recent: [] };
  await open('/?mock=signedin', { chats: seeded });
  await switchTo('gemini');
  chat = await current();
  check('a pending hand-off remembers where it came from', chat.conversationId === null && chat.carry?.provider === 'chatgpt' && chat.carry?.conversationId === 'conv-old');
  await switchTo('chatgpt');
  chat = await current();
  check('returning before sending restores the old conversation', chat.provider === 'chatgpt' && chat.conversationId === 'conv-old' && !chat.carry && !chat.carried);
  await send('Back again');
  check('the restored conversation gets a plain message', (await lastSend()).prompt === 'Back again' && (await lastSend()).attachmentIds.length === 0);

  // A failed hand-off still adds a question to the local chat. Returning must carry that
  // changed conversation, rather than treating it as an untouched switch that can be undone.
  await open('/?mock=signedin', { chats: seeded });
  await switchTo('gemini');
  await evalJS(`__mock.sendError='send_failed'`);
  await send('Keep this attempted Gemini question too');
  await evalJS(`__mock.sendError=null`);
  await open('/?mock=signedin', { keep: true });
  await switchTo('chatgpt');
  chat = await current();
  check('returning after a failed hand-off does not reuse the old ChatGPT thread', chat.conversationId === null && chat.carry?.provider === 'gemini');
  const afterFailure = await evalJS(`__mock.calls.length`);
  await send('Continue with all of that');
  check('returning after failure carries the changed chat and the next question', (await stagedText(afterFailure))?.text.includes('Keep this attempted Gemini question too') && (await lastSend()).prompt.endsWith('Continue with all of that') && (await lastSend()).attachmentIds.length === 1);

  // A pending hand-off survives a restart.
  await open('/?mock=signedin', { chats: seeded });
  await switchTo('gemini');
  await open('/?mock=signedin', { keep: true });
  await until(`__mock.provider==='gemini' || document.querySelector('.reasoning-mark')?.dataset.provider==='gemini'`);
  const sinceReload = await evalJS(`__mock.calls.length`);
  await send('After restart');
  const restarted = await stagedText(sinceReload);
  check('a hand-off pending across a restart still brings the history', restarted?.text.includes('Old question') && (await lastSend()).provider === 'gemini');

  // Signed out: the site may not take files, so the history goes inside the message.
  await open('/?mock=1');
  await send('Guest question');
  await switchTo('gemini');
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:false})`); await sleep(50);
  const guestCalls = await evalJS(`__mock.calls.length`);
  const guestBubble = await send('Guest follow-up');
  const guest = await lastSend();
  check('signed out, the history goes inside the message', guest.attachmentIds.length === 0 && guest.prompt.includes('<chat_history>') && guest.prompt.includes('Guest question') && guest.prompt.endsWith('Guest follow-up'), guest.prompt.slice(0, 120));
  check('signed out, nothing is staged', await evalJS(`!__mock.calls.slice(${guestCalls}).some(c=>c.cmd==='attachment_begin')`));
  check('signed out, the user still only sees what they typed', guestBubble === 'Guest follow-up', guestBubble);

  // The user's own files still go, alongside the history.
  await open();
  await send('With files later');
  await switchTo('gemini');
  await evalJS(`(()=>{const input=document.getElementById('attachment-input');const dt=new DataTransfer();dt.items.add(new File(['hello'],'notes.txt',{type:'text/plain'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.querySelectorAll('#attachments .attachment-chip').length===1`);
  await waitFor(`!document.querySelector('#attachments [data-state=staging]')`); await sleep(150);
  const fileBubble = await send('See my notes');
  check('the history rides along with the user\'s own file', (await lastSend()).attachmentIds.length === 2);
  check('only the user\'s own file shows on their message', fileBubble?.includes('notes.txt') && !fileBubble.includes('chat-history'), fileBubble);

  // Off: the old behaviour, a fresh chat and the old one kept as a tab.
  await open('/?mock=signedin', { settings: { ...BASE, contextSwitching: false } });
  await send('Separate chats please');
  const offKey = (await current()).key;
  await switchTo('gemini');
  chat = await current();
  check('with Context switching off, a switch starts a fresh chat', chat.key !== offKey && !chat.transcript?.length && !chat.carry);
  check('with Context switching off, the old chat is kept as a tab', await evalJS(`!!document.querySelector('#tabs .tab[data-key="${offKey}"]')`));
  await send('Fresh start');
  check('with Context switching off, nothing extra is sent', (await lastSend()).prompt === 'Fresh start' && (await lastSend()).attachmentIds.length === 0);

  // An empty chat has nothing to carry.
  await open();
  await switchTo('gemini');
  chat = await current();
  check('an empty chat switches the usual way', chat.provider === 'gemini' && !chat.carry && !chat.carried && !chat.transcript.length);

  // A temporary chat never hands its history to a saved one.
  await open();
  await type('/temp'); await key('Enter');
  await until(`__mock.calls.some(c=>c.cmd==='chat_new'&&c.args.temporary)`);
  await evalJS('__mock.emit("bridge",{type:"status",ready:true,loggedIn:true,temporary:true,setupId:__mock.setupId,url:"https://chatgpt.com/?temporary-chat=true"})');
  await send('Private temporary words');
  const tempCalls = await evalJS(`__mock.calls.length`);
  await switchTo('gemini');
  await send('Now on Gemini');
  const tempArgs = await lastSend();
  check('a temporary chat is not carried over', tempArgs.attachmentIds.length === 0 && !tempArgs.prompt.includes('Private temporary words') && await evalJS(`!__mock.calls.slice(${tempCalls}).some(c=>c.cmd==='attachment_begin')`));

  check('no runtime errors', problems.length === 0, problems.join(' | '));
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
