// Popover and chip motion: entrances, ghost exits that never hold up state, and
// motion off. Mock backend in an isolated, invisible Edge profile. No account,
// site access or OS-level input.
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
  browserPage = await openPage('popover-motion-ui', { problems });
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
  const open = async (url = '/', { settings } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await waitFor(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify(settings))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(120);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true })}));})()`);
  const ghosts = () => evalJS(`document.querySelectorAll('[data-ghost]').length`);
  const anim = (sel) => evalJS(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});return n?getComputedStyle(n).animationName:null})()`);
  const leaveMs = () => evalJS(`Math.round(QSettings.timings.t1*1.1)`);

  // --- Motion on ---------------------------------------------------------------
  await open('/?mock=1', { settings: { animations: 'on' } });
  check('motion is on', await evalJS(`document.documentElement.dataset.motion==='on'`));

  await evalJS(`document.getElementById('btn-reasoning').click()`);
  await waitFor(`!document.getElementById('picker').hidden`);
  check('picker rises in', await anim('#picker') === 'picker-in');
  check('picker is near-solid over the conversation', await evalJS(`(()=>{const m=getComputedStyle(document.getElementById('picker')).backgroundImage.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/);return !!m&&Number(m[1])>=0.94})()`));
  await key('Escape');
  check('closing hides the picker at once', await evalJS(`document.getElementById('picker').hidden && document.getElementById('btn-reasoning').getAttribute('aria-expanded')==='false'`));
  check('one ghost fades where the picker stood', await ghosts() === 1);
  check('the ghost is inert, unlabelled and click-through', await evalJS(`(()=>{const g=document.querySelector('[data-ghost]');return g.inert&&g.getAttribute('aria-hidden')==='true'&&!g.id&&!g.querySelector('[id]')&&!g.hasAttribute('role')&&getComputedStyle(g).pointerEvents==='none'&&g.classList.contains('picker')})()`));
  check('the ghost animates opacity down', await evalJS(`(()=>{const a=document.querySelector('[data-ghost]').getAnimations()[0];const k=a.effect.getKeyframes();return a.playState==='running'&&Number(k[0].opacity)===1&&Number(k.at(-1).opacity)===0})()`));
  check('no id is duplicated while the ghost fades', await evalJS(`(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.length===new Set(ids).size})()`));
  await sleep(await leaveMs() + 120);
  check('the ghost is removed once it has faded', await ghosts() === 0);

  await evalJS(`document.getElementById('btn-reasoning').click()`);
  await waitFor(`!document.getElementById('picker').hidden`);
  await key('Escape');
  check('second close leaves a ghost', await ghosts() === 1);
  await evalJS(`document.getElementById('btn-reasoning').click()`);
  check('reopening drops the fading ghost at once', await ghosts() === 0 && await evalJS(`!document.getElementById('picker').hidden`));
  await key('Escape');
  await sleep(await leaveMs() + 120);

  // Notices leave in place: the copy is pinned where the notice stood while layout settles.
  await evalJS(`document.getAnimations().forEach(a=>a.finish())`);
  const noticeBox = await evalJS(`(()=>{const r=document.getElementById('guest-notice').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()`);
  await evalJS(`document.getElementById('btn-guest-dismiss').click()`);
  check('dismissing the guest notice hides it at once', await evalJS(`document.getElementById('guest-notice').hidden`));
  check('its copy fades exactly where it stood', await evalJS(`(()=>{const g=document.querySelector('[data-ghost].notice');if(!g)return false;g.getAnimations().forEach(a=>{a.pause();a.currentTime=0});const r=g.getBoundingClientRect(),b=${JSON.stringify(noticeBox)};const ok=getComputedStyle(g).position==='absolute'&&Math.abs(r.left-b[0])<1&&Math.abs(r.top-b[1])<1&&Math.abs(r.width-b[2])<1&&Math.abs(r.height-b[3])<1;g.getAnimations().forEach(a=>a.play());return ok})()`));
  await sleep(await leaveMs() + 120);
  check('the notice copy is cleaned up', await ghosts() === 0);
  await evalJS(`__mock.emit('bridge',{type:'error',code:'network',message:'First problem'})`);
  if (await waitFor(`!document.getElementById('global-error').hidden`, 2000)) {
    await evalJS(`document.getElementById('btn-error-dismiss').click()`);
    check('a dismissed error leaves as a copy that keeps its text', await evalJS(`document.getElementById('global-error').hidden&&document.querySelector('[data-ghost].notice-error')?.textContent.includes('First problem')&&!document.getElementById('global-error-text').textContent`));
    await evalJS(`__mock.emit('bridge',{type:'error',code:'network',message:'Second problem'})`);
    await waitFor(`!document.getElementById('global-error').hidden`, 2000);
    check('an error shown again drops the fading copy at once', await evalJS(`!document.querySelector('[data-ghost].notice-error')`));
    await evalJS(`document.getElementById('btn-error-dismiss').click()`);
    await sleep(await leaveMs() + 120);
  }

  // A changed segment slides its fill across; the picker eases to a new height.
  await evalJS(`document.getElementById('btn-reasoning').click()`);
  await waitFor(`document.querySelector('[data-picker-key="effort:high"]')`);
  await sleep(300);
  await evalJS(`document.querySelector('[data-picker-key="effort:high"]').click()`);
  check('a changed effort is selected at once', await evalJS(`document.querySelector('[data-picker-key="effort:high"]').getAttribute('aria-checked')==='true'`));
  check('its fill slides across as one pill', await evalJS(`(()=>{const g=document.querySelector('.picker-effort-seg');const p=g.querySelectorAll('.picker-pill');return p.length===1&&g.hasAttribute('data-sliding')&&p[0].getAttribute('aria-hidden')==='true'&&getComputedStyle(g.querySelector('[aria-checked="true"]')).backgroundColor==='rgba(0, 0, 0, 0)'&&p[0].getAnimations()[0]?.playState==='running'})()`));
  check('the pill starts where the old choice was', await evalJS(`(()=>{const p=document.querySelector('.picker-pill');const k=p.getAnimations()[0].effect.getKeyframes();const g=p.parentElement.getBoundingClientRect();const med=document.querySelector('[data-picker-key="effort:medium"]').getBoundingClientRect();return Math.abs(parseFloat(k[0].left)-(med.left-g.left))<1.5})()`));
  await sleep(await evalJS(`QSettings.timings.t2`) + 150);
  check('the pill hands back to the chosen button', await evalJS(`!document.querySelector('.picker-pill')&&!document.querySelector('[data-sliding]')&&getComputedStyle(document.querySelector('[data-picker-key="effort:high"]')).backgroundColor!=='rgba(0, 0, 0, 0)'`));
  await evalJS(`document.querySelector('[data-picker-key="effort:high"]').click()`);
  check('picking the current choice again does not slide', await evalJS(`!document.querySelector('.picker-pill')`));
  const before = await evalJS(`document.getElementById('picker').getBoundingClientRect().height`);
  await evalJS(`__mock.emit('bridge',{type:'models',provider:'chatgpt',models:[{id:'0',label:'Mock model',selected:true},{id:'1',label:'Mock alternate'},{id:'2',label:'Mock third'},{id:'3',label:'Mock fourth'}]})`);
  check('a taller list eases the picker height', await evalJS(`(()=>{const a=document.getElementById('picker').getAnimations().find(a=>!a.animationName);if(!a)return false;const k=a.effect.getKeyframes();return Math.abs(parseFloat(k[0].height)-${before})<1.5&&parseFloat(k.at(-1).height)>${before}+20&&k[0].overflowY==='hidden'})()`));
  await sleep(await evalJS(`QSettings.timings.t2`) + 150);
  check('the eased height settles on the natural one', await evalJS(`!document.getElementById('picker').getAnimations().some(a=>a.playState==='running'||!a.animationName)&&document.getElementById('picker').querySelectorAll('.picker-row').length===4`));
  await key('Escape');
  await sleep(await leaveMs() + 120);

  await type('/');
  await waitFor(`!document.getElementById('slash-menu').hidden`);
  check('command menu rises in', await anim('#slash-menu') === 'menu-in');
  await type('');
  check('emptying the prompt closes the menu at once', await evalJS(`document.getElementById('slash-menu').hidden && document.getElementById('prompt-input').getAttribute('aria-expanded')==='false'`));
  check('the menu leaves as a ghost', await evalJS(`document.querySelectorAll('[data-ghost].slash-menu').length===1`));
  await sleep(await leaveMs() + 120);
  check('menu ghost cleaned up', await ghosts() === 0);

  await type('/model');
  await waitFor(`!document.getElementById('slash-menu').hidden`);
  await key('Enter');
  await waitFor(`!document.getElementById('picker').hidden`);
  check('a command that opens the picker keeps the menu fade going', await evalJS(`document.querySelectorAll('[data-ghost].slash-menu').length===1 && !document.getElementById('picker').hidden`));
  await key('Escape');
  await sleep(await leaveMs() + 120);

  await evalJS(`__mock.emit('qchat://settings-changed', QSettings.save({...QSettings.settings, animations:'on'}))`);
  await type('Show me a reply');
  await key('Enter');
  check('thinking chip settles in', await waitFor(`document.querySelector('.thinking') && getComputedStyle(document.querySelector('.thinking')).animationName==='thinking-in'`, 4000));
  await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 20000);
  await sleep(200);
  await evalJS(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.clipWrites=(window.clipWrites||[]).concat(t)}}})`);
  const copy = `document.querySelector('[data-role=assistant] .tool-btn[data-action="copy-turn"]')`;
  await evalJS(`(()=>{const b=${copy};b.click();})()`);
  check('a copy confirmation pops its glyph', await waitFor(`(()=>{const i=${copy}.querySelector('.icon');return window.clipWrites?.length===1&&i.getAnimations().length>0})()`, 2000));
  await sleep(1500);
  check('the glyph pops back once the confirmation ends', await evalJS(`${copy}.title!=='Copied'`));

  await evalJS(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))`);
  if (await waitFor(`document.querySelector('.find-bar:not([hidden])')`, 1500)) check('find bar rises in', await anim('.find-bar:not([hidden])') === 'chip-in');

  // A notice fading out as the bar folds is left to finish on its own.
  await open('/?mock=1', { settings: { animations: 'on' } });
  await waitFor(`!document.getElementById('guest-notice').hidden`, 3000);
  await evalJS(`document.getElementById('btn-guest-dismiss').click()`);
  const orb = await evalJS(`(()=>{const r=document.getElementById('orb').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: orb[0], y: orb[1], button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  if (await waitFor(`document.documentElement.dataset.collapse`, 1500)) {
    check('folding leaves a fading notice copy alone', await evalJS(`(()=>{const g=document.querySelector('[data-ghost].notice');return !g||g.getAnimations().length===1})()`));
    check('the bar still folds into its orb', await waitFor(`document.documentElement.dataset.collapse==='closed'`, 3000));
    check('no copy outlives the fold', await ghosts() === 0);
  } else check('orb click folds the bar', false);

  // --- Motion off --------------------------------------------------------------
  await open('/?mock=1', { settings: { animations: 'off' } });
  await evalJS(`document.getElementById('btn-reasoning').click()`);
  await waitFor(`!document.getElementById('picker').hidden`);
  await key('Escape');
  await evalJS(`document.getElementById('btn-reasoning').click()`);
  await waitFor(`document.querySelector('[data-picker-key="effort:high"]')`);
  await evalJS(`document.querySelector('[data-picker-key="effort:high"]').click()`);
  check('motion off: a changed choice does not slide', await evalJS(`!document.querySelector('.picker-pill')&&!document.getElementById('picker').getAnimations().some(a=>!a.animationName)`));
  await key('Escape');
  check('motion off: closing leaves no ghost', await evalJS(`document.getElementById('picker').hidden`) && await ghosts() === 0);
  await type('/');
  await waitFor(`!document.getElementById('slash-menu').hidden`);
  check('motion off: command menu has no entrance', await anim('#slash-menu') === 'none');
  await type('');
  check('motion off: command menu leaves no ghost', await ghosts() === 0);

  // --- Settings window ---------------------------------------------------------
  await open('/settings.html', { settings: { animations: 'on' } });
  await waitFor(`document.querySelectorAll('.section-link').length>3`);
  await evalJS(`document.querySelectorAll('.section-link')[3].click()`);
  check('a picked settings page settles in', await evalJS(`getComputedStyle(document.querySelector('.section:not([data-off-page])')).animationName==='page-in'`));
  await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='blur';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  check('search results appear without motion', await evalJS(`[...document.querySelectorAll('.section:not([hidden])')].every(n=>getComputedStyle(n).animationName==='none')`));
  await open('/settings.html', { settings: { animations: 'off' } });
  await waitFor(`document.querySelectorAll('.section-link').length>3`);
  await evalJS(`document.querySelectorAll('.section-link')[3].click()`);
  check('motion off: settings pages switch without motion', await evalJS(`getComputedStyle(document.querySelector('.section:not([data-off-page])')).animationName==='none'`));

  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
