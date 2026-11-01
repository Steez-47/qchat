// Idle-collapse checks in an isolated, invisible Edge profile. Mock backend only: no account,
// no site access, no OS-level input. Window focus is simulated by stubbing document.hasFocus and
// dispatching blur/focus. `--shots <dir>` also captures review PNGs of each stage.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('collapse-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  // How long the window waits before folding, shortened from the one second a person can choose.
  // Saving settings rounds it to whole seconds, so it is set again after anything that saves.
  const IDLE = 300;
  const shortIdle = () => evalJS(`QSettings.settings.idleCollapse=${IDLE / 1000}`);
  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({collapse:document.documentElement.dataset.collapse,focused:window.__focused,bar:document.getElementById('bar').getBoundingClientRect().width,status:document.querySelector('[data-role=assistant]')?.dataset.status})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const QCHAT_SETTINGS_V = 4;
  const MIN = 60 * 1000;
  const chat = (key, conv, ago) => ({ key, conversationId: conv, title: key, lastActive: Date.now() - ago, lastPrompt: `prompt ${key}`, lastResponse: `Cached **reply** for ${key}`, createdAt: Date.now() - ago });
  const recent = { v: 1, current: { key: 'now', conversationId: null, title: '', lastActive: Date.now(), createdAt: Date.now() }, recent: [chat('Trip ideas', 'c-1', 5 * MIN), chat('Regex help', 'c-2', 30 * MIN)] };
  const open = async (settings = {}, { chats = recent } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await until(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify({ v: QCHAT_SETTINGS_V, animations: 'on', autoDismiss: 0, speed: 2, idleCollapse: 1, ...settings }))})`);
    if (chats) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}/` });
    await until(`document.readyState==='complete' && window.QSettings && window.QCollapse`);
    await cdp('Page.bringToFront');
    // The page cannot lose real OS focus here, so focus is a flag the test flips.
    await evalJS(`window.__focused=true;document.hasFocus=()=>window.__focused;window.__drags=0;window.__TAURI__.window={getCurrentWindow:()=>({startDragging:async()=>{window.__drags++;}})}`);
    await screenPosition(0);
    await mouse('mouseMoved', 4, 4);
    await sleep(60);
    if (settings.idleCollapse === undefined) await shortIdle();
  };
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
  const blur = () => evalJS(`window.__focused=false;window.dispatchEvent(new Event('blur'))`);
  const focus = () => evalJS(`window.__focused=true;window.dispatchEvent(new Event('focus'))`);
  const state = () => evalJS(`document.documentElement.dataset.collapse||'open'`);
  // CSS-pixel geometry, including monitors to the left of the primary screen.
  const screenPosition = (x, left = 0, width = 1920) => evalJS(`Object.defineProperty(window,'screenX',{configurable:true,value:${x}});Object.defineProperty(screen,'availLeft',{configurable:true,value:${left}});Object.defineProperty(screen,'availWidth',{configurable:true,value:${width}})`);
  const rect = (sel) => evalJS(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2,right:r.right,bottom:r.bottom}})()`);
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settings = (patch) => evalJS(`__mock.emit('qchat://settings-changed',QSettings.save({...QSettings.settings,...${JSON.stringify(patch)}}))`);
  const folded = () => until(`document.documentElement.dataset.collapse==='closed'`, 'folded', 500);
  const opened = () => until(`!document.documentElement.dataset.collapse`, 'opened', 300);
  // Visible on screen, counting visibility and opacity, as the hit-test pass does.
  const shown = (sel) => evalJS(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return !!n&&n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})})()`);
  const frames = (ms) => evalJS(`new Promise(resolve=>{const out=[];const start=performance.now();
    function sample(now){const b=document.getElementById('bar').getBoundingClientRect();out.push({t:now-start,x:b.x,right:b.right,w:b.width,h:b.height,s:document.documentElement.dataset.collapse||'open',z:+getComputedStyle(document.getElementById('bubble-zone')).opacity});
      if(now-start<${ms})requestAnimationFrame(sample);else resolve(out);}
    requestAnimationFrame(sample);})`);
  const shot = async (name) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // --- Defaults ------------------------------------------------------------------------------
  await cdp('Page.navigate', { url: `${base}/` });
  await until(`document.readyState==='complete' && window.QSettings`);
  await evalJS(`localStorage.clear()`);
  check('idle collapse defaults to five seconds', await evalJS(`QSettings.DEFAULTS.idleCollapse===5 && QSettings.sanitize({}).idleCollapse===5`));
  check('idle collapse is a behaviour setting that presets keep', await evalJS(`!QSettings.APPEARANCE_KEYS.includes('idleCollapse') && QSettings.applyPreset({...QSettings.DEFAULTS,idleCollapse:12},'compact').idleCollapse===12`));

  // --- A draft keeps the composer visible ----------------------------------------------------
  await open();
  await send('Collapse fixture');
  await finishReply();
  const draft = 'A draft that stays visible\nwhile unfocused';
  await type(draft);
  await evalJS(`document.getElementById('prompt-input').setSelectionRange(2,12,'backward')`);
  await blur();
  await sleep(IDLE * 1.5);
  check('draft text prevents idle collapse after losing focus', await state() === 'open' && await shown('#prompt-input'));
  check('unfocused draft and selection stay intact', await evalJS(`(()=>{const i=document.getElementById('prompt-input');return i.value===${JSON.stringify(draft)} && i.selectionStart===2 && i.selectionEnd===12 && i.selectionDirection==='backward'})()`));
  await type('');
  const cleared = Date.now();
  await sleep(IDLE / 2);
  check('clearing a draft starts a fresh idle delay', await state() === 'open');
  await folded();
  check('empty composer folds after the fresh delay', Date.now() - cleared >= IDLE);
  await focus();
  await opened();

  // --- Fold after the delay ------------------------------------------------------------------
  await sleep(250);
  const before = { reply: await rect('.bubble-response'), bar: await rect('#bar'), orb: await rect('#orb'), input: await rect('#prompt-input'), fits: await evalJS(`__mock.fits.length`), lastFit: await evalJS(`JSON.stringify(__mock.fit)`) };
  check('tabs and reply are on screen before folding', await shown('.tab') && await shown('.bubble-response'));
  await shot('1-open');
  const t0 = Date.now();
  await blur();
  await sleep(IDLE * 0.7);
  check('stays open inside the idle delay', await state() === 'open');
  const foldFrames = await frames(IDLE * 0.3 + 600);
  await folded();
  const elapsed = Date.now() - t0;
  check('folds after the idle delay', elapsed >= IDLE && elapsed < IDLE + 1200, `${elapsed}ms`);
  const closingWidths = foldFrames.filter((f) => f.s === 'closing').map((f) => f.w);
  check('fold animates the bar through intermediate widths', closingWidths.some((w) => w > 60 && w < before.bar.w - 40), JSON.stringify(closingWidths.map(Math.round)));
  check('bar only narrows while folding', closingWidths.every((w, i) => i === 0 || w <= closingWidths[i - 1] + 0.5), JSON.stringify(closingWidths.map(Math.round)));
  check('left-side fold keeps the left edge fixed throughout', foldFrames.filter(f => f.s === 'closing').every(f => Math.abs(f.x - before.bar.x) < 0.6));
  const shut = { bar: await rect('#bar'), orb: await rect('#orb') };
  check('folded bar is a circle the height of the bar', Math.abs(shut.bar.w - 44) < 0.5 && Math.abs(shut.bar.h - 44) < 0.5 && await evalJS(`getComputedStyle(document.getElementById('bar')).borderTopLeftRadius==='50%'`), JSON.stringify(shut.bar));
  check('orb sits centred in the circle', Math.abs(shut.orb.cx - shut.bar.cx) < 0.6 && Math.abs(shut.orb.cy - shut.bar.cy) < 0.6, `${JSON.stringify(shut.orb)} ${JSON.stringify(shut.bar)}`);
  check('orb stays where it was; the bar folds into it', Math.abs(shut.orb.cx - before.orb.cx) < 0.6 && Math.abs(shut.orb.cy - before.orb.cy) < 0.6);
  check('folded bar keeps its bottom edge', Math.abs(shut.bar.bottom - before.bar.bottom) < 0.6);
  check('reply, tabs and composer controls are hidden', !await shown('.bubble-response') && !await shown('.tab') && !await shown('#prompt-input') && !await shown('#btn-attach') && await shown('#orb'));
  check('window is not resized by folding', await evalJS(`JSON.stringify(__mock.fit)`) === before.lastFit);
  await sleep(120);
  const hit = await evalJS(`__mock.last('surfaces_set')?.args.rects`);
  check('only the folded circle hit-tests and blurs', hit?.length === 1 && Math.abs(hit[0].w - 44) < 0.6 && Math.abs(hit[0].r - 22) < 0.6 && hit[0].b === true, JSON.stringify(hit));
  check('reply is kept while folded', await evalJS(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.length>40`));
  check('reply keeps its height behind the fold', Math.abs((await rect('.bubble-response')).h - before.reply.h) < 0.5);
  await shot('3-folded');

  // --- Click opens it ------------------------------------------------------------------------
  await mouse('mouseMoved', shut.bar.cx, shut.bar.cy);
  await focus(); // clicking an inactive window activates it before the press arrives
  await sleep(60);
  check('a focus that comes with a press on the orb waits for the click', await state() === 'closed');
  await mouse('mousePressed', shut.bar.cx, shut.bar.cy);
  await mouse('mouseReleased', shut.bar.cx, shut.bar.cy);
  const openFrames = await frames(700);
  await opened();
  const openingWidths = openFrames.filter((f) => f.s === 'opening').map((f) => f.w);
  check('click on the folded orb opens it with an animation', openingWidths.some((w) => w > 60 && w < before.bar.w - 40), JSON.stringify(openingWidths.map(Math.round)));
  check('reply fades back in while opening', openFrames.some((f) => f.s === 'opening' && f.z > 0.05 && f.z < 0.95));
  const reopened = { bar: await rect('#bar'), input: await rect('#prompt-input') };
  check('bar returns to its full size', Math.abs(reopened.bar.w - before.bar.w) < 0.5 && Math.abs(reopened.bar.h - before.bar.h) < 0.5, `${JSON.stringify(reopened.bar)} vs ${JSON.stringify(before.bar)}`);
  check('empty composer is focused after reopening', await evalJS(`document.activeElement===document.getElementById('prompt-input') && document.getElementById('prompt-input').value===''`));
  check('composer keeps its height', Math.abs(reopened.input.h - before.input.h) < 0.5, `${reopened.input.h} vs ${before.input.h}`);
  check('reply and tabs are back', await shown('.bubble-response') && await shown('.tab') && await shown('#btn-attach'));
  check('reply opens at the height it had', Math.abs((await rect('.bubble-response')).h - before.reply.h) < 0.5);
  check('no animations are left behind', await evalJS(`document.getAnimations().filter(a=>a.playState!=='finished'&&a.effect?.getTiming().iterations!==Infinity).length===0 && !document.getElementById('bar').getAnimations().length`));

  // --- Drag moves it folded ------------------------------------------------------------------
  await mouse('mouseMoved', 4, 4);
  await blur();
  await folded();
  await mouse('mouseMoved', shut.bar.cx, shut.bar.cy);
  await focus();
  await mouse('mousePressed', shut.bar.cx, shut.bar.cy);
  await mouse('mouseMoved', shut.bar.cx + 20, shut.bar.cy - 12, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', shut.bar.cx + 20, shut.bar.cy - 12);
  await sleep(500);
  check('dragging the folded orb moves the window and leaves it folded', await evalJS(`window.__drags`) === 1 && await state() === 'closed');

  // --- Other ways back -----------------------------------------------------------------------
  await mouse('mouseMoved', 4, 4);
  await key('a');
  await opened();
  check('a key press on the folded window opens it', await evalJS(`document.activeElement===document.getElementById('prompt-input')`));
  await blur();
  await folded();
  await focus();
  await sleep(30);
  check('focus from the shortcut or tray opens it at once', await state() === 'opening' || await state() === 'open');
  await opened();

  // --- Screen-side anchoring, including a monitor at negative coordinates ---------------------
  for (const [side, x, left] of [['right', 1100, 0], ['left', -1900, -1920], ['right', -800, -1920]]) {
    await screenPosition(x, left);
    const full = await rect('#bar');
    const edge = side === 'right' ? 'right' : 'x';
    await blur();
    const closing = await frames(IDLE + 550);
    await folded();
    const circle = await rect('#bar');
    check(`${side} fold holds the screen-facing edge (monitor ${left})`, Math.abs(circle[edge] - full[edge]) < 0.6 && closing.some(f => f.s === 'closing' && f.w > 60 && f.w < full.w - 40) && closing.filter(f => f.s === 'closing').every(f => Math.abs(f[edge] - full[edge]) < 0.6), JSON.stringify({ full, circle }));
    const orb = await rect('#orb');
    check(`${side} folded orb is centred (monitor ${left})`, Math.abs(orb.cx - circle.cx) < 0.6 && Math.abs(orb.cy - circle.cy) < 0.6);
    await sleep(100);
    const surfaces = await evalJS(`__mock.last('surfaces_set')?.args.rects`);
    check(`${side} hit-test and blur follow the folded orb (monitor ${left})`, surfaces?.length === 1 && Math.abs(surfaces[0].x - circle.x) < 0.6 && Math.abs(surfaces[0].w - circle.w) < 0.6, JSON.stringify(surfaces));
    await shot(`${side}-folded-monitor-${left}`);
    await focus();
    const opening = await frames(700);
    await opened();
    const restored = await rect('#bar');
    check(`${side} expansion keeps its edge and restores position (monitor ${left})`, opening.some(f => f.s === 'opening') && opening.filter(f => f.s === 'opening').every(f => Math.abs(f[edge] - full[edge]) < 0.6) && Math.abs(restored.x - full.x) < 0.6 && Math.abs(restored.w - full.w) < 0.6, JSON.stringify({ full, restored }));
  }

  // --- Dragging the folded orb across its screen ------------------------------------------------
  // The stub moves the window like the native one: screenX follows setPosition. `fail` makes the
  // move reject, as it would without the window permission.
  const windowMoves = (fail = false) => evalJS(`(()=>{window.__moves=[];const api=window.__TAURI__.window;
    api.PhysicalPosition=class{constructor(x,y){this.type='Physical';this.x=x;this.y=y;}};
    api.getCurrentWindow=()=>({startDragging:async()=>{window.__drags++;},
      outerPosition:async()=>({x:Math.round(window.screenX*devicePixelRatio),y:0}),
      setPosition:async(p)=>{if(${fail})throw new Error('denied');window.__moves.push(p.x);Object.defineProperty(window,'screenX',{configurable:true,value:p.x/devicePixelRatio});}});})()`);
  const orbOnScreen = async () => (await evalJS('window.screenX')) + (await rect('#bar')).x;
  await windowMoves();
  await screenPosition(1100);
  const wide = await rect('#bar');
  await blur();
  await folded();
  check('folded on the right half anchors right', await evalJS(`document.documentElement.dataset.collapseAnchor`) === 'right');
  // Dragged so the orb now sits in the left half of the screen.
  await screenPosition(-300);
  const dropped = await orbOnScreen();
  await focus();
  const flip = await frames(700);
  await opened();
  const moves = await evalJS('window.__moves');
  check('opening after a drag to the left half moves the window once', moves.length === 1 && moves[0] > -300, JSON.stringify(moves));
  const opening = flip.filter(f => f.s === 'opening');
  check('it then opens rightward from where the orb was left', opening.length > 0 && opening.every(f => Math.abs(f.x - opening[0].x) < 0.6) && Math.abs((await evalJS('window.screenX')) + opening[0].x - dropped) < 0.6, JSON.stringify({ dropped, first: opening[0], screenX: await evalJS('window.screenX') }));
  check('and ends at full size with no leftover offset', Math.abs((await rect('#bar')).w - wide.w) < 0.5 && await evalJS(`document.getElementById('bar').style.translate===''`));
  // Back the other way: folded on the left, dragged into the right half, opens leftward.
  await screenPosition(-200);
  await blur();
  await folded();
  check('folded on the left half anchors left', await evalJS(`document.documentElement.dataset.collapseAnchor`) === 'left');
  await screenPosition(1500);
  const droppedRight = (await orbOnScreen()) + (await rect('#bar')).w;
  await evalJS('window.__moves=[]');
  await focus();
  const flipBack = await frames(700);
  await opened();
  const backMoves = await evalJS('window.__moves');
  const openingBack = flipBack.filter(f => f.s === 'opening');
  check('dragged to the right half it opens leftward from the orb', backMoves.length === 1 && backMoves[0] < 1500 && openingBack.length > 0 && openingBack.every(f => Math.abs(f.right - openingBack[0].right) < 0.6) && Math.abs((await evalJS('window.screenX')) + openingBack[0].right - droppedRight) < 0.6, JSON.stringify({ backMoves, droppedRight, first: openingBack[0] }));
  // A drag that stays on the same half keeps the edge and leaves the window alone.
  await screenPosition(1100);
  await blur();
  await folded();
  await screenPosition(1300);
  await evalJS('window.__moves=[]');
  await focus();
  await opened();
  check('a drag within the same half does not move the window', (await evalJS('window.__moves')).length === 0);
  // Without a window move, the orb keeps its old edge rather than jumping across the window.
  await windowMoves(true);
  await screenPosition(1100);
  await blur();
  await folded();
  await screenPosition(-300);
  const stuck = await rect('#bar');
  await focus();
  const held = await frames(700);
  await opened();
  check('a refused window move falls back to the original edge', held.filter(f => f.s === 'opening').every(f => Math.abs(f.right - stuck.right) < 0.6) && await evalJS(`document.getElementById('bar').style.translate===''`), JSON.stringify({ stuck, first: held.find(f => f.s === 'opening') }));
  await screenPosition(1100);

  // --- Reverse mid-fold ----------------------------------------------------------------------
  await blur();
  // Sample and focus in the same frame; screenshot encoding must not let the fold finish first.
  const reversal = await evalJS(`new Promise((resolve,reject)=>{const start=performance.now();function sample(){const bar=document.getElementById('bar');const from=bar.getBoundingClientRect();if(document.documentElement.dataset.collapse==='closing' && from.width>60 && from.width<300){window.__focused=true;window.dispatchEvent(new Event('focus'));const to=bar.getBoundingClientRect();resolve({from:from.width,to:to.width,right:from.right,toRight:to.right,state:document.documentElement.dataset.collapse});return;}if(performance.now()-start>3500){reject(new Error('No intermediate closing frame'));return;}requestAnimationFrame(sample);}requestAnimationFrame(sample);})`);
  const reverse = await frames(120);
  check('coming back mid-fold reverses from where it is', reversal.state === 'opening' && Math.abs(reversal.to - reversal.from) < 0.6 && reverse.some(f => f.s === 'opening' && f.w > reversal.from && f.w < before.bar.w), JSON.stringify(reversal));
  check('right-side reversal keeps the right edge fixed', Math.abs(reversal.toRight - reversal.right) < 0.6 && reverse.every(f => Math.abs(f.right - reversal.right) < 0.6));
  await opened();
  check('reversal ends at full size', Math.abs((await rect('#bar')).w - before.bar.w) < 0.5);

  // --- Opening animation screenshot ----------------------------------------------------------
  await blur();
  await folded();
  await focus();
  await sleep(110);
  await shot('4-opening');
  await opened();

  // --- Things that keep it open --------------------------------------------------------------
  await blur();
  await sleep(IDLE * 0.6);
  await type('A draft entered after the idle timer started');
  await sleep(IDLE * 1.2);
  check('draft added during the idle delay prevents collapse', await state() === 'open' && await shown('#prompt-input'));
  await type('   \n');
  await sleep(IDLE * 1.3);
  check('whitespace in the text box also keeps it open', await state() === 'open');
  await focus();
  await type('');
  await evalJS(`__mock.hold=true`);
  await send('Streaming fixture');
  await until(`__mock.last('chat_send') && document.getElementById('btn-send').dataset.mode==='stop'`, 'streaming');
  await blur();
  await sleep(IDLE * 1.5);
  check('never folds while a reply is streaming', await state() === 'open');
  await evalJS(`__mock.release?.()`);
  await finishReply();
  const done = Date.now();
  await sleep(IDLE / 2);
  check('a finished reply gets the full delay before folding', await state() === 'open');
  await folded();
  check('folds once the reply has been idle for the delay', Date.now() - done >= IDLE);
  await focus();
  await opened();

  const bubble = await rect('.bubble-response');
  await blur();
  for (let i = 0; i < 6; i++) { await mouse('mouseMoved', bubble.cx + (i % 2) * 8, bubble.cy); await sleep(IDLE / 4); }
  check('stays open while the pointer is over it', await state() === 'open');
  await mouse('mouseMoved', 4, 4);
  await folded();
  check('folds after the pointer leaves', true);
  await focus();
  await opened();

  await evalJS(`__mock.emit('qchat://settings-focus',null)`);
  await blur();
  await sleep(IDLE * 1.5);
  check('never folds while the settings window is open', await state() === 'open');
  await evalJS(`__mock.emit('qchat://settings-closed',null)`);
  await folded();
  check('folds after the settings window closes', true);
  await focus();
  await opened();

  await blur();
  await evalJS(`__mock.emit('qchat://hidden',null)`);
  await sleep(IDLE * 1.5);
  check('a hidden window never folds', await state() === 'open');
  await evalJS(`__mock.emit('qchat://shown',null)`);
  await shortIdle();
  await focus();
  await blur();
  await folded();
  await evalJS(`__mock.emit('qchat://hidden',null)`);
  check('hiding a folded window resets it at once', await state() === 'open' && Math.abs((await rect('#bar')).w - before.bar.w) < 0.5 && await evalJS(`!document.documentElement.dataset.collapseAnchor`));
  await evalJS(`__mock.emit('qchat://shown',null)`);
  await shortIdle();
  await focus();

  await settings({ idleCollapse: 0 });
  await blur();
  await sleep(IDLE * 1.5);
  check('zero seconds turns folding off', await state() === 'open');
  await settings({ idleCollapse: 1 });
  await folded();
  check('turning it back on while unfocused starts the count', true);
  await focus();
  await opened();

  await settings({ hideOnBlur: true });
  await shortIdle();
  await blur();
  await sleep(IDLE * 1.5);
  check('hide-on-blur takes over from folding', await state() === 'open');
  await focus();
  await settings({ hideOnBlur: false });

  // --- Reduced motion and the hidden orb style -----------------------------------------------
  await open({ animations: 'off', orbStyle: 'hidden' }, { chats: null });
  await screenPosition(-800, -1920);
  const quietFull = await rect('#bar');
  await blur();
  await until(`document.documentElement.dataset.collapse`, 'any collapse state', 300);
  check('motion off folds without an animation', await state() === 'closed' && !await evalJS(`document.getElementById('bar').getAnimations().length`));
  const quiet = { bar: await rect('#bar'), orb: await rect('#orb') };
  check('motion off also folds toward the screen-facing edge', Math.abs(quiet.bar.right - quietFull.right) < 0.6);
  check('hidden orb style still shows the orb when folded', Math.abs(quiet.orb.w - 18) < 0.5 && Math.abs(quiet.orb.cx - quiet.bar.cx) < 0.6 && await evalJS(`getComputedStyle(document.getElementById('orb')).backgroundImage!=='none'`));
  await focus();
  check('motion off opens without an animation', await state() === 'open');

  check('no runtime errors', problems.length === 0, problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error('console:', problems.slice(0, 5).join(' | ')); failed++; }
finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
