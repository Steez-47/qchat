// Native blur reports during real browser animations; isolated headless mock backend.
import assert from 'node:assert/strict';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();
let page;
try {
  page = await openPage('surfaces-ui');
  const { cdp, evalJS } = page;
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: base });
  for (let i = 0; !await evalJS(`document.readyState==='complete' && !!window.QSurfaces && !!window.QSettings && __mock.count('show_main')>0`); i++) {
    assert(i < 400, 'UI loaded');
    await sleep(10);
  }
  await evalJS(`(() => {
    // The async startup theme apply also sets blur. Keep the fixture strengths in
    // settings so any later theme apply preserves them, too.
    QSettings.apply(document.documentElement, {...QSettings.settings,
      idleCollapse:0, nativeBlur:true, blur:32, replyNativeBlur:true, replyBlur:60});
    const parent = document.createElement('div');
    parent.id = 'surface-test';
    parent.style.cssText = 'position:fixed;left:40px;top:40px;opacity:.5';
    const button = document.createElement('button');
    button.className = 'glass';
    button.style.cssText = 'display:block;width:120px;height:40px;opacity:.4;animation:none;transition:none';
    parent.append(button); document.body.append(parent);
  })()`);
  const fixture = `__mock.last('surfaces_set')?.args.rects.find(r => r.y===40 && Math.abs(r.w-120)<.1)`;
  for (let i = 0; !await evalJS(`!!(${fixture})`); i++) {
    assert(i < 100, 'fixture reported');
    await sleep(10);
  }
  const initial = await evalJS(fixture);
  assert(Math.abs(initial.s - .16) < .001, 'blur multiplies control and ancestor opacity by configured strength');
  console.log('PASS blur follows control and ancestor opacity');

  const start = await evalJS(`(() => {
    const parent = document.getElementById('surface-test');
    window.__surfaceAnimation = parent.animate([
      {opacity:.5, transform:'translateX(0)'},
      {opacity:0, transform:'translateX(40px)'}
    ], {duration:500, fill:'forwards', easing:'linear'});
    parent.dataset.closing = ''; // Like collapse state, this wakes the surface sampler.
    return __mock.calls.length;
  })()`);
  await evalJS(`__surfaceAnimation.finished`);
  await sleep(60);
  const frames = await evalJS(`__mock.calls.slice(${start}).filter(c=>c.cmd==='surfaces_set').map(c=>c.args.rects.find(r=>r.y===40 && Math.abs(r.w-120)<.1)).filter(Boolean)`);
  assert(frames.some(r => r.s > .02 && r.s < .14 && r.x > 42 && r.x < 78), 'blur moves and fades during closing');
  assert(frames.length >= 3, 'animation sampled over multiple frames');
  assert(!await evalJS(`!!(${fixture})`), 'closed control leaves no blur surface');
  console.log('PASS closing blur moves, fades and disappears with the control');

  await evalJS(`__surfaceAnimation.reverse(); document.getElementById('surface-test').removeAttribute('data-closing')`);
  await evalJS(`__surfaceAnimation.finished`);
  await sleep(60);
  const reopened = await evalJS(fixture);
  assert(reopened && Math.abs(reopened.s - .16) < .001 && Math.abs(reopened.x - 40) < .1, 'reopening restores blur geometry and strength');
  console.log('PASS reopening restores blur');
} finally {
  await page?.close();
  closeServer();
}
