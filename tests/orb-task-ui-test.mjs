// Minimize-while-waiting and the orb task state, in an isolated invisible Edge profile. Mock backend only.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, serveUI, sleep, timerMs } from './lib/ui-harness.mjs';

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
  browserPage = await openPage('orb-task-ui', { problems });
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
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const shots = path.join(root, 'dist', 'qa-picker');
  await mkdir(shots, { recursive: true });
  const shot = async (name) => writeFile(path.join(shots, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const mouse = (t, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type: t, x, y, button: t === 'mouseMoved' ? 'none' : 'left', buttons: t === 'mousePressed' ? 1 : 0, clickCount: t === 'mouseMoved' ? 0 : 1, ...extra });
  const rectOf = (sel) => evalJS(`(()=>{const r=${q(sel)}.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2,right:r.right,top:r.top}})()`);
  const blur = () => evalJS(`window.__focused=false;window.dispatchEvent(new Event('blur'))`);
  const focus = () => evalJS(`window.__focused=true;window.dispatchEvent(new Event('focus'))`);
  const state = () => evalJS(`document.documentElement.dataset.collapse||'open'`);
  const task = () => evalJS(`document.documentElement.dataset.orbTask||''`);
  const said = async (text) => { await evalJS(`document.getElementById('prompt-input').focus()`); await send(text); };
  const gone = (expr, ms) => waitFor(`!(${expr})`, ms);
  const REPLY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango omega';
  const SETTINGS = { v: 4, animations: 'on', autoDismiss: 0, speed: 3, idleCollapse: 0 };
  const open1 = async (url = '/?mock=signedin', settings = {}, chats) => {
    await open(url, { settings: { ...SETTINGS, ...settings }, chats });
    await waitFor(`window.QCollapse && document.getElementById('orb')`);
    await evalJS(`window.__focused=true;document.hasFocus=()=>window.__focused;window.__drags=0;window.__TAURI__.window={getCurrentWindow:()=>({startDragging:async()=>{window.__drags++;}})};__mock.reply=${JSON.stringify(REPLY)};__mock.interval=40`);
    await mouse('mouseMoved', 4, 4);
    await sleep(80);
  };
  const clickOrb = async () => { const o = await rectOf('#orb'); await mouse('mouseMoved', o.cx, o.cy); await mouse('mousePressed', o.cx, o.cy); await mouse('mouseReleased', o.cx, o.cy); };
  const clickCircle = async () => { const b = await rectOf('#bar'); await mouse('mouseMoved', b.cx, b.cy); await focus(); await mouse('mousePressed', b.cx, b.cy); await mouse('mouseReleased', b.cx, b.cy); await mouse('mouseMoved', 4, 4); };
  const foldNow = async () => { await clickOrb(); await waitFor(`document.documentElement.dataset.collapse==='closed'`, 3000); await mouse('mouseMoved', 4, 4); await blur(); };
  const streaming = () => evalJS(`!!document.querySelector('[data-status=streaming]')`);
  const lum = (rgb) => { const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
  const LAST = `[...document.querySelectorAll('[data-role=assistant] .turn-content')].at(-1)`;
  const tokens = () => evalJS(`(${LAST}?.textContent||'').trim()`);

  // ---- click folds, drag does not
  await open1();
  check('minimize button is hidden while idle', await evalJS(`${q('#btn-minimize')}.hidden`));
  check('no task state while open', (await task()) === '');
  let o = await rectOf('#orb');
  await mouse('mouseMoved', o.cx, o.cy); await mouse('mousePressed', o.cx, o.cy);
  await mouse('mouseMoved', o.cx + 20, o.cy - 10, { button: 'left', buttons: 1 }); await mouse('mouseReleased', o.cx + 20, o.cy - 10);
  await sleep(300);
  check('dragging the open orb moves the window without folding', (await state()) === 'open' && await evalJS(`window.__drags`) === 1);
  await mouse('mouseMoved', 4, 4);
  await clickOrb();
  check('a plain click on the orb folds the bar', await waitFor(`document.documentElement.dataset.collapse==='closing'||document.documentElement.dataset.collapse==='closed'`, 1500));
  await waitFor(`document.documentElement.dataset.collapse==='closed'`, 3000);
  check('an idle fold shows no task state', (await task()) === '' && await evalJS(`${q('#orb-badge')}.hidden && !${q('#bar')}.hasAttribute('title')`));
  await clickCircle();
  check('click opens it again', await waitFor(`!document.documentElement.dataset.collapse`, 3000));

  // ---- minimize while a reply is in flight, ring only when folded and in flight
  await evalJS(`__mock.hold=true`);
  await said('hold the reply');
  await sleep(250);
  check('minimize button appears with its title, label and glyph', await evalJS(`(()=>{const b=${q('#btn-minimize')};return !b.hidden&&b.title==='Minimize while waiting'&&b.getAttribute('aria-label')==='Minimize while waiting'&&b.querySelector('.icon').textContent==='\\uE921'&&b.nextElementSibling.id==='btn-send'})()`));
  check('in flight but open: no ring and no state', (await task()) === '' && await evalJS(`getComputedStyle(${q('#orb')},'::after').content==='none'`));
  await evalJS(`${q('#btn-minimize')}.click()`);
  await waitFor(`document.documentElement.dataset.collapse==='closed'`, 3000);
  check('minimize folds and the orb shows working', (await task()) === 'working');
  check('working title reads exactly', await evalJS(`${q('#bar')}.title==='Waiting for a reply…'`));
  check('working ring is a 2px arc inset -5px that spins about 1.1s', await evalJS(`(()=>{const s=getComputedStyle(${q('#orb')},'::after');return s.animationName==='orb-spin'&&s.animationDuration==='1.1s'&&s.animationTimingFunction==='linear'&&s.top==='-5px'&&s.content!=='none'})()`));
  check('the status ring is replaced while shown', await evalJS(`getComputedStyle(${q('#status-dot')}).display==='none'`));
  await shot('orb-working-dark.png');
  // ---- finish while folded: ready
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  check('reply keeps running while folded and the orb turns ready', await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000));
  await sleep(450);
  const orbInfo = await evalJS(`(()=>{const b=${q('#orb-badge')};const cs=getComputedStyle(b);return {text:b.textContent,hidden:b.hidden,aria:b.getAttribute('aria-hidden'),bg:cs.backgroundColor,fg:cs.color,w:b.getBoundingClientRect().width,fs:cs.fontSize,fw:cs.fontWeight,title:${q('#bar')}.title,label:${q('#status-label')}.textContent,before:getComputedStyle(${q('#orb')},'::before').opacity,after:getComputedStyle(${q('#orb')},'::after').content}})()`);
  check('ready shows badge 1, 15px bold 10px', orbInfo.text === '1' && !orbInfo.hidden && orbInfo.aria === 'true' && Math.round(orbInfo.w) === 15 && orbInfo.fs === '10px' && Number(orbInfo.fw) >= 700, JSON.stringify(orbInfo));
  check('badge contrast is at least 4.5:1', ratio(orbInfo.fg, orbInfo.bg) >= 4.5, `${orbInfo.fg} on ${orbInfo.bg} = ${ratio(orbInfo.fg, orbInfo.bg)}`);
  check('ready title and announcement', orbInfo.title === 'Reply ready. Click to open' && orbInfo.label === 'Reply ready', JSON.stringify(orbInfo));
  check('ready turns the orb green and drops the ring', Number(orbInfo.before) === 1 && orbInfo.after === 'none');
  const circle = await rectOf('#bar');
  const badge = await rectOf('#orb-badge');
  const corner = { x: circle.cx + circle.w / 2 * Math.SQRT1_2, y: circle.cy - circle.h / 2 * Math.SQRT1_2 };
  check('badge sits on the circle rim at the top right', Math.hypot(badge.cx - corner.x, badge.cy - corner.y) <= 7, JSON.stringify({ badge, corner }));
  check('badge is not clipped by the closed bar', await evalJS(`getComputedStyle(${q('#bar')}).overflow==='visible'`));
  await shot('orb-ready-dark.png');
  // every orb style turns green with the badge on the circle
  for (const style of ['solid', 'ring', 'hidden', 'gradient']) {
    await evalJS(`document.documentElement.dataset.orbstyle=${JSON.stringify(style)}`);
    await sleep(450);
    const r = await evalJS(`(()=>{const b=${q('#orb-badge')}.getBoundingClientRect(),c=${q('#bar')}.getBoundingClientRect();return {bx:b.x+b.width/2,by:b.y+b.height/2,cx:c.x+c.width/2,cy:c.y+c.height/2,rad:c.width/2,before:getComputedStyle(${q('#orb')},'::before').opacity}})()`);
    check(`${style} orb turns green with the badge on the circle`, Number(r.before) === 1 && Math.abs(Math.hypot(r.bx - r.cx, r.by - r.cy) - r.rad) <= 6, JSON.stringify(r));
  }
  await evalJS(`document.documentElement.dataset.orbstyle='gradient'`);
  // opening clears at once, and the reply is complete and sized
  await clickCircle();
  check('opening clears the task state at once', await waitFor(`!document.documentElement.dataset.orbTask && ${q('#orb-badge')}.hidden`, 400));
  await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await sleep(300);
  check('title is removed and the status line is restored', await evalJS(`!${q('#bar').replace('#bar', '#bar')}.hasAttribute('title')&&${q('#status-label')}.textContent!=='Reply ready'`));
  check('the full reply is there after opening', (await tokens()).endsWith('omega'), '[' + await tokens() + '] ' + await evalJS(`document.querySelectorAll('[data-role=assistant]').length`));
  check('the reply bubble fits its text', await evalJS(`(()=>{const b=${q('.bubble-response')},t=${q('[data-role=assistant] .turn-content')};return b.getBoundingClientRect().height>=t.getBoundingClientRect().height-1&&b.scrollHeight<=b.clientHeight+2})()`));

  // ---- opening mid-reply shows the live reply
  const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ' omega';
  await evalJS(`__mock.interval=150;__mock.reply=${JSON.stringify(LONG)}`);
  await said('stream while folded');
  await waitFor(`${LAST}&&${LAST}.textContent.length>3`, 4000);
  await foldNow();
  await sleep(500);
  check('working while folded mid-stream', (await task()) === 'working');
  const partial = (await tokens()).length;
  await clickCircle();
  await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await sleep(150);
  const mid = await evalJS(`(()=>{const t=${LAST},b=[...document.querySelectorAll('.bubble-response')].at(-1);return {len:t.textContent.length,streaming:!!document.querySelector('[data-status=streaming]'),bubble:b.getBoundingClientRect().height,text:t.getBoundingClientRect().height,scroll:b.scrollHeight-b.clientHeight}})()`);
  check('opening mid-reply shows the live reply, still streaming', mid.len >= partial && mid.streaming && mid.bubble >= mid.text - 1, JSON.stringify({ partial, mid }));
  await waitFor(`!document.querySelector('[data-status=streaming]')`, 10000);
  await sleep(500);
  check('the reply completes after the mid-reply open', (await tokens()).endsWith('omega'), '[' + await tokens() + '] ' + await evalJS(`document.querySelectorAll('[data-role=assistant]').length`));
  await evalJS(`__mock.interval=40;__mock.reply=${JSON.stringify(REPLY)}`);

  // ---- never folded / finished before the fold
  await said('plain reply');
  await waitFor(`document.querySelector('[data-status=streaming]')`, 3000);
  let sawState = false;
  const end = Date.now() + 5000;
  while (Date.now() < end && await streaming()) { if ((await task()) !== '') sawState = true; await sleep(30); }
  await sleep(300);
  check('a reply that is never folded shows no state', !sawState && (await task()) === '' && await evalJS(`${q('#orb-badge')}.hidden`));
  await foldNow();
  await sleep(300);
  check('a reply that finished before the fold shows nothing', (await task()) === '' && await evalJS(`${q('#orb-badge')}.hidden`), await task());
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);

  // ---- attention
  await evalJS(`__mock.hold=true`);
  await said('will need attention');
  await sleep(200);
  const id = await evalJS(`__mock.last('chat_send').args.id`);
  await foldNow();
  await evalJS(`__mock.emit('bridge',{type:'conversation',id:${JSON.stringify(id)},conversationId:'paused-thread-1'})`);
  await evalJS(`__mock.emit('bridge',{type:'error',id:${JSON.stringify(id)},code:'needs_attention',message:'Check the ChatGPT window.'})`);
  check('an error while folded raises attention', await waitFor(`document.documentElement.dataset.orbTask==='attention'`, 3000));
  check('a paused task keeps its thread on the chat', await waitFor(`JSON.parse(localStorage.getItem('qchat.chats')).current.conversationId==='paused-thread-1'`, 3000));
  const att = await evalJS(`({text:${q('#orb-badge')}.textContent,title:${q('#bar')}.title,label:${q('#status-label')}.textContent,bg:getComputedStyle(${q('#orb-badge')}).backgroundColor,fg:getComputedStyle(${q('#orb-badge')}).color})`);
  check('attention shows ! with its own copy and contrast', att.text === '!' && att.title === 'Needs your attention. Click to open' && att.label === 'Needs your attention' && ratio(att.fg, att.bg) >= 4.5, JSON.stringify(att));
  await shot('orb-attention-dark.png');
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await evalJS(`__mock.hold=false`);

  // ---- a stopped reply clears
  await evalJS(`__mock.hold=true;__mock.interval=200`);
  await said('stop me');
  await sleep(200);
  await foldNow();
  check('working before the stop', (await task()) === 'working');
  await evalJS(`${q('#btn-send')}.click()`);
  await sleep(500);
  check('a reply the user stopped leaves no state', (await task()) === '' && await evalJS(`${q('#orb-badge')}.hidden`), await task() + ' ' + await state());
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await evalJS(`__mock.hold=false;__mock.interval=40`);

  // ---- hiding the window resets
  await evalJS(`__mock.hold=true`);
  await said('hide me');
  await sleep(200);
  await foldNow();
  check('working before hide', (await task()) === 'working');
  await evalJS(`__mock.emit('qchat://hidden')`);
  await sleep(100);
  check('collapse.reset clears the state', (await task()) === '' && (await state()) === 'open');
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  await sleep(1500);
  await evalJS(`__mock.hold=false`);

  // ---- idle folding: any reply may fold while waiting, words on screen hold an ordinary reply open
  await open1('/?mock=signedin', { idleCollapse: 1 });
  await evalJS(`__mock.hold=true`);
  await said('ordinary reply');
  await sleep(200);
  await blur();
  check('an ordinary reply still waiting may fold from idle', await waitFor(`document.documentElement.dataset.collapse==='closed'`, 4000));
  check('and the orb shows the wait', (await task()) === 'working' && await evalJS(`${q('#bar')}.title==='Waiting for a reply…'`));
  await shot('orb-working-chat-dark.png');
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  check('an ordinary reply finishing folded ends ready', await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000));
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  check('the ordinary reply is complete after opening', (await tokens()).endsWith('omega'), await tokens());
  await evalJS(`__mock.interval=400;__mock.reply=${JSON.stringify(LONG)}`);
  await said('reply being read');
  await waitFor(`${LAST}&&${LAST}.textContent.includes('word')`, 4000);
  await blur();
  await sleep(2600);
  check('an ordinary reply with words on screen never auto-folds', (await state()) === 'open' && await streaming());
  await evalJS(`${q('#btn-send')}.click()`);
  await waitFor(`!document.querySelector('[data-status=streaming]')`, 8000);
  await open1('/?mock=signedin', { idleCollapse: 1 }, { v: 1, current: { key: 'w', provider: 'chatgpt', title: '', mode: 'work' }, recent: [] });
  check('the Work chat is restored', await evalJS(`${q('.reasoning-label')}.textContent==='Work'`));
  await evalJS(`__mock.hold=true`);
  await said('work reply');
  await sleep(200);
  await blur();
  check('a Work reply in flight may fold from idle', await waitFor(`document.documentElement.dataset.collapse==='closed'`, 4000));
  check('and the orb shows it working', (await task()) === 'working');
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000);
  check('a Work reply finishing folded ends ready', (await task()) === 'ready');
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);

  // ---- motion off: a static ring
  await open1('/?mock=signedin', { animations: 'off' });
  await evalJS(`__mock.hold=true`);
  await said('quiet');
  await sleep(200);
  await foldNow();
  check('motion off: static ring at reduced opacity, no rotation', await evalJS(`(()=>{const s=getComputedStyle(${q('#orb')},'::after');return s.animationName==='none'&&Number(s.opacity)<.6&&s.content!=='none'})()`));
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000);
  check('motion off: the badge has no entrance animation', await evalJS(`getComputedStyle(${q('#orb-badge')}).animationName==='none'`));

  // ---- auto-dismiss waits for the orb to open, then restarts
  await open1('/?mock=signedin', { autoDismiss: 5 });
  await said('dismiss me');
  await waitFor(`!document.querySelector('[data-status=streaming]')`, 8000);
  await foldNow();
  await sleep(timerMs(6800));
  check('auto-dismiss does not run while folded', (await state()) === 'closed' && await evalJS(`!!${q('[data-role=assistant]')}`));
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await mouse('mouseMoved', 4, 4);
  await sleep(timerMs(2500));
  check('opening restarts the count so the reply is still there', await evalJS(`!!${q('[data-role=assistant]')}`));
  check('and then it is dismissed', await waitFor(`!document.querySelector('[data-role=assistant]')`, 7000));

  // ---- update badge is hidden under a task state and restored
  await open1('/?mock=signedin&update=1.9.0');
  await waitFor(`!document.getElementById('update-badge').hidden`, 8000);
  check('update badge is visible before a task', await evalJS(`!${q('#update-badge')}.hidden`));
  await evalJS(`__mock.hold=true`);
  await said('update check');
  await sleep(200);
  await foldNow();
  check('update badge hides while working', await evalJS(`${q('#update-badge')}.hidden`));
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000);
  const b0 = await rectOf('#bar');
  await mouse('mouseMoved', b0.cx, b0.cy); await sleep(900);
  check('the update chip does not appear on hover while a task shows', await evalJS(`${q('#update-chip')}.hidden && ${q('#update-badge')}.hidden`));
  await clickCircle(); await waitFor(`!document.documentElement.dataset.collapse`, 3000);
  await sleep(200);
  check('update badge is restored after opening', await evalJS(`!${q('#update-badge')}.hidden`));

  // ---- light look
  await open1('/?mock=signedin', { look: 'paper' });
  await evalJS(`__mock.hold=true`);
  await said('light');
  await sleep(200);
  await foldNow();
  await shot('orb-working-light.png');
  await evalJS(`(()=>{const r=__mock.release;__mock.hold=false;r&&r()})()`);
  await waitFor(`document.documentElement.dataset.orbTask==='ready'`, 8000);
  const lightBadge = await evalJS(`({bg:getComputedStyle(${q('#orb-badge')}).backgroundColor,fg:getComputedStyle(${q('#orb-badge')}).color})`);
  check('badge contrast holds in a light look', ratio(lightBadge.fg, lightBadge.bg) >= 4.5, JSON.stringify(lightBadge));
  await sleep(300);
  await shot('orb-ready-light.png');
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
