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
  browserPage = await openPage('audit-fixes', { problems });
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
  const chat = (key) => ({key, title:key, lastPrompt:'question', lastResponse:'answer', createdAt:Date.now(), lastActive:Date.now(), transcript:[]});
  await open('/?mock=1', {settings:{animations:'off',keepHistory:true,showTabs:true}, chats:{v:1,current:chat('current'),recent:[chat('a'),chat('b'),chat('c')]}});
  await waitFor(`document.querySelectorAll('#tabs .tab').length===3`);
  check('one tab stop', await evalJS(`document.querySelectorAll('#tabs .tab[tabindex="0"]').length===1`));
  check('labels present', await evalJS(`[...document.querySelectorAll('#tabs .tab')].every(t=>t.getAttribute('aria-label'))`));
  await evalJS(`document.querySelector('#tabs .tab').focus()`);
  await key('ArrowLeft'); check('left wraps', await evalJS(`document.activeElement.dataset.key==='c'`));
  await key('ArrowRight'); check('right wraps', await evalJS(`document.activeElement.dataset.key==='a'`));
  await key('End'); check('End', await evalJS(`document.activeElement.dataset.key==='c'`));
  await key('Home'); check('Home', await evalJS(`document.activeElement.dataset.key==='a'`));
  check('moving does not switch', await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key==='current'`));
  const hides = await count('hide_main'); await key('Escape');
  check('Escape focuses composer without hiding', await evalJS(`document.activeElement.id==='prompt-input'`) && await count('hide_main')===hides);
  await evalJS(`document.querySelector('#tabs .tab').focus()`); await key('Enter');
  check('Enter activates and focuses composer', await waitFor(`JSON.parse(localStorage.getItem('qchat.chats')).current.key==='a' && document.activeElement.id==='prompt-input'`));
  const settings = {animations:'off', autoDismiss:0, keepHistory:true, showTabs:true};
  const empty = {v:1, current:{key:'current',conversationId:null,title:'',lastActive:Date.now(),lastPrompt:'',lastResponse:'',lastHasMedia:false,lastSources:[],draft:'',transcript:[],createdAt:Date.now()}, recent:[]};

  // A list request whose bridge never answers must not leave the list loading forever.
  await open('/?mock=signedin&listTimeout=150', {settings, chats:empty}); await sleep(150);
  await evalJS(`window.listCalls=0;window.realInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='chat_list_conversations'?(listCalls++,Promise.resolve()):realInvoke(c,a)`);
  await key('p',{ctrlKey:true}); await sleep(30);
  check('silent list request shows loading', await evalJS(`document.querySelector('.feature-results').textContent.includes('Loading your chats')`));
  check('silent list request stops loading by itself', await waitFor(`!document.querySelector('.feature-results').textContent.includes('Loading your chats')`, 1500));
  await key('Escape'); await sleep(30); await key('p',{ctrlKey:true}); await sleep(40);
  check('list can be requested again after a silent attempt', await evalJS('listCalls===2'), await evalJS('String(listCalls)'));
  await key('Escape'); await sleep(30);
  await evalJS(`__mock.emit('bridge',{type:'conversations',items:[{id:'remote-late-1',title:'Late chat',updated:Date.now()}],offset:0,total:1})`); await sleep(30);
  await key('p',{ctrlKey:true}); await sleep(30);
  check('a late answer still fills the list', await evalJS(`document.querySelector('.feature-results').textContent.includes('Late chat')`));
  await key('Escape');

  // Space is the one printable key whose accelerator name differs from its value.
  const record = (extra) => evalJS(`(async()=>{const row=[...document.querySelectorAll('.action-row,.row')].find(r=>r.textContent.includes('Global shortcut'));const b=row&&row.querySelector('button');if(!b)throw Error('no shortcut button');b.click();await new Promise(r=>setTimeout(r,30));b.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({bubbles:true,cancelable:true,...extra})}));await new Promise(r=>setTimeout(r,60));return __mock.last('set_hotkey')?.args?.accelerator||''})()`);
  await open('/settings.html', {settings}); await sleep(250);
  const space = await record({key:' ',code:'Space',ctrlKey:true});
  check('Ctrl+Space records the Space accelerator', space==='Ctrl+Space', JSON.stringify(space));
  await open('/settings.html', {settings}); await sleep(250);
  const letter = await record({key:'j',code:'KeyJ',altKey:true});
  check('letter keys still record uppercase', letter==='Alt+J', JSON.stringify(letter));

  // With the prompt kept above the reply, its thinking dots must stop once the reply starts.
  await open('/?mock=1', {settings:{...settings, showPrompt:true}, chats:empty}); await sleep(150);
  await evalJS(`__mock.hold=true`); await type('keep my prompt'); await key('Enter');
  await waitFor(`__mock.last('chat_send')`);
  check('thinking dots show while waiting', await waitFor(`document.querySelector('.turn-row[data-role="user"] .thinking')`));
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:'Unfinished paragr'})`); await sleep(120);
  check('dots stay while no reply text is visible yet', await evalJS(`!!document.querySelector('.turn-row[data-role="user"] .thinking')`));
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:'A finished reply.'})`); await sleep(300);
  check('kept prompt loses its dots once the reply starts', await evalJS(`!!document.querySelector('.turn-row[data-role="user"]') && !document.querySelector('.turn-row[data-role="user"] .thinking')`));
  await open('/?mock=1', {settings, chats:empty}); await sleep(150);
  await evalJS(`__mock.hold=true`); await type('default mode'); await key('Enter'); await waitFor(`__mock.last('chat_send')`);
  check('default mode still shows dots while waiting', await waitFor(`document.querySelector('.turn-row[data-role="user"] .thinking')`));

  // Enter during file preparation must explain itself and keep everything.
  await open('/?mock=1', {settings, chats:empty}); await sleep(150);
  await evalJS(`window.realInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?new Promise(()=>{}):realInvoke(c,a);const d=new DataTransfer();d.items.add(new File(['x'],'slow.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('#attachments [data-state=staging]')`);
  await type('send me later'); const sendsBefore = await count('chat_send'); await key('Enter'); await sleep(60);
  check('Enter while staging explains the wait', await evalJS(`!document.getElementById('command-feedback').hidden&&document.getElementById('command-feedback').textContent.includes('Wait for files')`), await evalJS(`document.getElementById('command-feedback').textContent`));
  check('Enter while staging sends nothing and keeps the draft', await count('chat_send')===sendsBefore && await evalJS(`document.getElementById('prompt-input').value==='send me later'`));

  // Names over the limit are still cut, as designed, but no longer silently.
  const named = {...empty, current:{...empty.current, title:'Old name', lastPrompt:'hi', lastResponse:'yo', transcript:[{id:'u',role:'user',text:'hi'},{id:'a',role:'assistant',text:'yo'}]}};
  await open('/?mock=1', {settings, chats:named}); await sleep(150);
  const rename = async (v) => { await type('/rename'); await key('Enter'); await waitFor(`!document.getElementById('rename-chat').hidden`); await evalJS(`(()=>{const i=document.querySelector('.rename-input');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))})()`); await sleep(50); };
  const notice = () => evalJS(`document.getElementById('command-feedback').textContent`);
  const stored = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.title`);
  await rename('x'.repeat(41));
  check('over-long name is cut and says so', await stored()==='x'.repeat(40) && (await notice()).includes('shortened to 40'), await notice());
  await rename('y'.repeat(40));
  check('exactly forty characters has no shortened notice', await stored()==='y'.repeat(40) && (await notice())==='Renamed in QChat', await notice());
  await rename('😀'.repeat(40));
  check('forty emoji count as forty', await stored()==='😀'.repeat(40) && (await notice())==='Renamed in QChat', await notice());
  await rename('  spaced     out  name  ');
  check('collapsed spaces count, not raw typing', await stored()==='spaced out name' && (await notice())==='Renamed in QChat', await notice());
  // Composer text that comes from settings follows a change straight away.
  await open('/?mock=1', {settings, chats:empty}); await sleep(200);
  await evalJS("__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,placeholderText:'Type a prompt',sendKey:'ctrl'}))"); await sleep(80);
  check('placeholder follows the setting', await evalJS("document.getElementById('prompt-input').placeholder.includes('Type a prompt')"), await evalJS("document.getElementById('prompt-input').placeholder"));
  check('send tooltip follows the setting', await evalJS("document.getElementById('btn-send').title.includes('Ctrl+Enter')"), await evalJS("document.getElementById('btn-send').title"));

  // A preset rebuild must keep the active settings search.
  await open('/settings.html', {settings}); await sleep(250);
  const visibleCards = "[...document.querySelectorAll('.preset-entry')].filter(c=>!c.hidden).length";
  await evalJS("(()=>{const q=document.getElementById('settings-search');q.value='oled';q.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(40);
  const filtered = await evalJS(visibleCards);
  check('settings search filters presets', filtered>0 && filtered<await evalJS("document.querySelectorAll('.preset-entry').length"), String(filtered));
  await evalJS("[...document.querySelectorAll('.preset-entry')].find(c=>!c.hidden).querySelector('.preset-card').click()"); await sleep(80);
  check('applying a preset keeps the search filter', await evalJS(visibleCards)===filtered, String(await evalJS(visibleCards)));
  await evalJS("(()=>{const q=document.getElementById('settings-search');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}))})()"); await sleep(40);
  check('clearing search shows every preset again', await evalJS(visibleCards)===await evalJS("document.querySelectorAll('.preset-entry').length"));
  check('no runtime errors', problems.length===0, problems.slice(0,4).join(' | '));
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
