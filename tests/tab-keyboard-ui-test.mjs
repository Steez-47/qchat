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
  browserPage = await openPage('reconnect-ui', { problems });
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
  const seed = (recent = [chat('a'), chat('b'), chat('c')]) => ({v:1, current:chat('current'), recent});
  const setup = async (data = seed()) => {
    await open('/?mock=signedin', {settings, chats:data});
    if (!await waitFor(`document.querySelectorAll('#tabs .tab').length===${data.recent.length}`)) throw Error('tabs did not appear');
    // Startup ends by focusing the composer, which would take focus back from a tab.
    await waitFor(`document.activeElement===document.getElementById('prompt-input')`);
  };
  const focusTab = (key) => evalJS(`document.querySelector('#tabs [data-key="${key}"]').focus()`);
  const list = async () => {
    await key('p', {ctrlKey:true});
    if (!await waitFor(`!document.querySelector('.feature-list').hidden`)) throw Error('chat list did not open');
  };
  const remove = (title) => evalJS(`(()=>{const row=[...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent===${JSON.stringify(title)}); if(!row) throw Error('missing row'); row.querySelector('[aria-label="Remove chat"]').click()})()`);

  const other = chat('b'); other.provider = 'gemini';
  await setup(seed([chat('a'), other, chat('c')]));
  await focusTab('b'); await key(' ');
  check('Space activates different-provider tab and focuses composer', await waitFor(`JSON.parse(localStorage.getItem('qchat.chats')).current.key==='b' && document.activeElement.id==='prompt-input'`));
  check('different-provider activation preserves provider', await evalJS(`__mock.provider==='gemini' && JSON.parse(localStorage.getItem('qchat.chats')).current.provider==='gemini'`));

  await setup(); await focusTab('b');
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings})`);
  check('render keeps focused chat key', await waitFor(`document.activeElement.classList.contains('tab') && document.activeElement.dataset.key==='b'`));
  await focusTab('c');
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,tabCount:2})`);
  check('focused tab removed from row moves focus to nearest visible tab', await waitFor(`document.activeElement.classList.contains('tab') && document.activeElement.dataset.key==='b'`));

  await setup(); await list(); await focusTab('b'); await remove('a');
  check('notice preserves focus on an unchanged tab', await evalJS(`document.activeElement.dataset.key==='b' && !document.getElementById('command-feedback').hidden`));

  await setup(); await list(); await focusTab('b');
  const beforePill = await evalJS(`({height:document.querySelector('#stack').offsetHeight, content:__mock.fit.content})`);
  await remove('b');
  check('focused removed tab moves to nearest while undo is visible', await evalJS(`document.activeElement.dataset.key==='c' && !document.getElementById('command-feedback').hidden`));
  const pillFits = await waitFor(`(()=>{const tabs=document.getElementById('tabs').getBoundingClientRect(),pill=document.getElementById('command-feedback').getBoundingClientRect(),stack=document.getElementById('stack');return getComputedStyle(document.getElementById('tabs')).display!=='none' && tabs.width>0 && pill.width>0 && (tabs.bottom<=pill.top || pill.bottom<=tabs.top || tabs.right<=pill.left || pill.right<=tabs.left) && stack.offsetHeight>${beforePill.height} && __mock.fit.content>${beforePill.content} && __mock.fit.content>=stack.offsetHeight})()`);
  check('tabs and undo remain visible without overlap and fit grows', pillFits);
  const hidesUndo = await count('hide_main'); await key('Escape');
  check('Escape dismisses undo first and retains tab focus without hiding', await evalJS(`document.getElementById('command-feedback').hidden && document.activeElement.dataset.key==='c'`) && await count('hide_main')===hidesUndo);
  await key('Escape'); check('next Escape returns focus to composer', await evalJS(`document.activeElement.id==='prompt-input'`) && await count('hide_main')===hidesUndo);

  await setup(); await list(); await sleep(250);
  await evalJS(`(()=>{const button=[...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent==='b').querySelector('[aria-label="Remove chat"]');button.focus();button.click()})()`);
  const hidesReal = await count('hide_main'); await key('Escape');
  check('Escape after removing from list dismisses undo without hiding', await evalJS(`!document.querySelector('#tabs [data-key="b"]') && document.getElementById('command-feedback').hidden`) && await count('hide_main')===hidesReal);

  await setup(); await evalJS(`document.getElementById('prompt-input').focus()`); await type('draft');
  const untouched = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return !e.defaultPrevented && document.activeElement.id==='prompt-input' && document.activeElement.value==='draft'})()`);
  check('composer horizontal arrows unaffected', untouched);
  await type(''); await key('ArrowUp');
  check('composer recall still works', await inputValue()==='question');
  await key('ArrowDown'); check('composer recall returns to empty draft', await inputValue()==='');

  await setup(); await evalJS(`__mock.hold=true; document.getElementById('prompt-input').focus()`); await send('busy prompt');
  if (!await waitFor(`document.querySelector('#tabs .tab')?.getAttribute('aria-disabled')==='true'`)) throw Error('busy state did not appear');
  if (!await waitFor(`__mock.count('chat_send')===1`)) throw Error('setup send did not reach mock');
  const sends = await count('chat_send');
  const current = await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key`);
  await focusTab('a'); await key('ArrowRight');
  check('busy tabs remain focusable and expose disabled state', await evalJS(`document.activeElement.dataset.key==='b' && document.activeElement.getAttribute('aria-disabled')==='true'`));
  await key('Enter'); await key(' '); await evalJS(`document.querySelector('#tabs [data-key="a"]').click()`); await sleep(50);
  const busyAfter = await evalJS(`({active:document.activeElement.dataset.key,current:JSON.parse(localStorage.getItem('qchat.chats')).current.key,sends:__mock.count('chat_send')})`);
  check('busy keyboard and mouse activation do not switch or send', busyAfter.current===current && busyAfter.sends===sends, JSON.stringify({before:{current,sends},after:busyAfter}));

  await setup(seed([chat('a')])); await focusTab('a');
  const oneArrow = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return !e.defaultPrevented && document.activeElement.dataset.key==='a'})()`);
  check('single tab arrow does nothing', oneArrow);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  check('single tab does not trap Tab focus', await evalJS(`document.activeElement.dataset.key!=='a'`));
  check('no runtime errors', problems.length===0, problems.join(' | '));
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
