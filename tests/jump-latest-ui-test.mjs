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
  browserPage = await openPage('reading-position-ui', { problems });
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
  const rows = (prefix) => Array.from({ length: 30 }, (_, i) => ({
    id: `${prefix}-${i}`, role: i % 2 ? 'assistant' : 'user',
    text: `${prefix} message ${i} ${'long text '.repeat(15)}`
  }));
  const chat = (key, extra = {}) => {
    const transcript = rows(key);
    return { key, title: key, conversationId: `conv-${key}`, lastPrompt: transcript.at(-2).text,
      lastResponse: transcript.at(-1).text, createdAt: Date.now(), lastActive: Date.now(), transcript, ...extra };
  };
  const settings = { animations: 'off', keepHistory: true, showTabs: true, autoDismiss: 0 };
  const setup = async (a = chat('a'), b = chat('b')) => {
    await open('/?mock=1', { settings, chats: { v: 1, current: a, recent: [b] } });
    await sleep(150);
  };
  const until = async (expr, label) => {
    if (!await waitFor(expr)) throw Error(`Timed out: ${label}`);
  };

  const shortcut = () => evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'End',ctrlKey:true,bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`);
  await open('/?mock=1', { settings });
  await evalJS(`document.getElementById('prompt-input').focus()`);
  check('no reply leaves default alone', !await shortcut());
  await evalJS(`__mock.hold=true`); await send('Stream test');
  await until(`__mock.last('chat_send')`, 'send');
  const text = Array.from({length:120}, (_,i)=>`Line ${i} streaming words words words`).join('\n\n');
  const emit = value => evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(value)}})`);
  await emit(text); await until(`document.querySelector('[data-role=assistant][data-capped]')`, 'capped reply'); await sleep(300);
  const scroll = `document.querySelector('[data-role=assistant] .bubble-scroll')`;
  await until(scroll, 'reply scroller');
  const hold = () => evalJS(`(()=>{const s=${scroll};s.scrollTop=0;s.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));})()`);
  const bottom = () => evalJS(`(()=>{const s=${scroll};return s.scrollHeight-s.clientHeight-s.scrollTop<=3})()`);
  await hold(); await type('draft text'); await evalJS(`document.getElementById('prompt-input').focus();document.getElementById('prompt-input').setSelectionRange(3,3)`);
  check('mid-text caret stays native and does not jump', !await shortcut() && !await bottom());
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(10,10)`);
  const sends = await evalJS(`__mock.count('chat_send')`);
  check('caret at end jumps', await shortcut() && await bottom());
  check('draft focus and send count preserved', await evalJS(`document.activeElement.id==='prompt-input'&&document.activeElement.value==='draft text'&&__mock.count('chat_send')===${sends}`));
  await emit(text+'\n\n'+text); await sleep(400);
  check('new streaming text follows', await bottom());
  await hold(); await type(''); check('empty composer jumps', await shortcut() && await bottom());
  await evalJS(`document.getElementById('btn-history').click()`); await sleep(100);
  await evalJS(`(()=>{const p=document.getElementById('history-panel');p.scrollTop=0;p.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));document.getElementById('prompt-input').focus()})()`);
  check('history jumps and stays open', await shortcut() && await evalJS(`(()=>{const p=document.getElementById('history-panel');return !p.hidden&&p.scrollHeight-p.scrollTop-p.clientHeight<=2})()`));
  await key('f',{ctrlKey:true}); await sleep(100);
  check('find input keeps native shortcut', await evalJS(`document.activeElement.id==='find-input'`) && !await shortcut());
  await evalJS(`document.getElementById('find-close').click();document.getElementById('btn-history').click()`);
  await type('/keys'); await key('Enter'); await sleep(100);
  check('/keys lists shortcut', await evalJS(`document.querySelector('.feature-list').textContent.includes('Ctrl+End')&&document.querySelector('.feature-list').textContent.includes('Jump to latest')`));
  const fire = (extra) => evalJS(`(()=>{const e=new KeyboardEvent('keydown',${JSON.stringify({ key: 'End', ctrlKey: true, bubbles: true, cancelable: true, ...extra })});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`);
  await setup(); await type('composing'); await evalJS(`document.getElementById('prompt-input').focus();document.getElementById('prompt-input').setSelectionRange(9,9)`);
  check('IME composition leaves the shortcut alone', !await fire({ isComposing: true }) && !await fire({ keyCode: 229 }));
  check('Ctrl+Shift+End keeps native selection in the composer', !await fire({ shiftKey: true }) && await evalJS(`document.getElementById('prompt-input').value==='composing'`));
  await setup(); await type('/rename'); await key('Enter'); await until(`!document.getElementById('rename-chat').hidden`, 'rename open');
  const renameBefore = await evalJS(`document.activeElement.value`);
  check('rename input keeps native shortcut and stays open', await evalJS(`document.activeElement.tagName==='INPUT'`) && !await shortcut() && await evalJS(`!document.getElementById('rename-chat').hidden&&document.activeElement.value===${JSON.stringify(renameBefore)}`));
  await open('/?mock=1', { settings, chats: { v: 1, current: chat('a'), recent: [chat('b'), chat('c'), chat('d')] } }); await sleep(150);
  await evalJS(`document.querySelector('#tabs [data-key="b"]').focus()`);
  const tabSends = await evalJS(`__mock.count('chat_send')`);
  const currentKey = await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.key`);
  await shortcut(); await sleep(80);
  check('shortcut on a focused tab does not activate it, send, or move focus', await evalJS(`document.activeElement.dataset.key==='b'&&__mock.count('chat_send')===${tabSends}&&JSON.parse(localStorage.getItem('qchat.chats')).current.key===${JSON.stringify(currentKey)}`));
  check('no runtime errors', problems.length===0, problems.join(' | '));
  if (failed) process.exitCode = 1;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
