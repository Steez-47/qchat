// Reply formatting: table alignment, task lists, keyboard keys, and no raw Markdown on any
// frame while a mixed reply streams in each stream style. Mock backend in an isolated,
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
  browserPage = await openPage('reply-format-ui', { problems });
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

  const REPLY = [
    'Intro with **bold**, *italic* and `code`. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.',
    '',
    '| Left | Center | Right |',
    '|:---|:---:|---:|',
    '| a | b | 1.00 |',
    '| longer cell | `x` | 1,234.56 |',
    '',
    '- [ ] Task not done',
    '- [x] Task done',
    '',
    '- plain bullet',
    '',
    'Loose:',
    '',
    '- [x] Loose task',
    '',
    '- [ ] Another loose task',
    '',
    'Tight:',
    '',
    '- [x] Tight one',
    '- [ ] Tight two',
    '',
    '$$',
    '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    '$$',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '> A quote with **bold**.',
    '',
    'The end.'
  ].join('\n');
  const reply = `document.querySelector('[data-role=assistant] .turn-content')`;
  const run = async (style) => {
    await open('/?mock=1', { settings: { animations: 'on', autoDismiss: 0, streamStyle: style, idleCollapse: 0 } });
    await evalJS(`__mock.reply=${JSON.stringify(REPLY)};__mock.interval=5`);
    await evalJS(`window.__frames=[];let seen=false;const tick=()=>{const row=document.querySelector('[data-role=assistant]');const c=row?.querySelector('.turn-content');if(row?.dataset.status==='streaming'){seen=true;__frames.push({t:c.textContent,h:row.querySelector('.bubble-response').getBoundingClientRect().height})}if(!seen||row?.dataset.status!=='done')requestAnimationFrame(tick)};requestAnimationFrame(tick)`);
    await type('format'); await key('Enter');
    await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 20000);
    const r = await evalJS(`(()=>{const f=__frames;const bad=f.filter(x=>/\\*\\*|\\$\\$|\\|\\s*:?-{3}|\\\\frac|<\\/?kbd>|^> /m.test(x.t.replace(/const answer = 42;/,''))).map(x=>x.t.slice(-60));let shrink=0,jump=0;for(let i=1;i<f.length;i++){if(f[i].t.length<f[i-1].t.length)shrink++;if(f[i].h<f[i-1].h-1)jump++}return {n:f.length,bad,shrink,jump}})()`);
    check(`${style}: frames were sampled while streaming`, r.n > 3, JSON.stringify(r));
    check(`${style}: no raw Markdown shows on any frame`, r.bad.length === 0, JSON.stringify(r.bad.slice(0, 3)));
    check(`${style}: shown text never shrinks`, r.shrink === 0);
    check(`${style}: the bubble never jumps smaller`, r.jump === 0);
  };
  for (const style of ['paragraph', 'word', 'type', 'fade']) await run(style);

  check('table columns keep their alignment', await evalJS(`(()=>{const cells=[...${reply}.querySelectorAll('tr:first-child > *, tbody tr:first-child > *')];const a=cells.map(c=>getComputedStyle(c).textAlign);return a.slice(0,3).join()==='left,center,right'&&a.slice(3,6).join()==='left,center,right'})()`));
  check('task items show a checkbox instead of a bullet', await evalJS(`(()=>{const items=[...${reply}.querySelectorAll('li')].filter(li=>li.querySelector(':scope > input[type=checkbox], :scope > p:first-child > input[type=checkbox]'));const plain=[...${reply}.querySelectorAll('li')].find(li=>li.textContent.includes('plain bullet'));return items.length===6&&items.some(li=>li.querySelector(':scope > input'))&&items.some(li=>li.querySelector(':scope > p > input'))&&items.every(li=>getComputedStyle(li).listStyleType==='none')&&items[1].querySelector('input').checked&&items.every(li=>li.querySelector('input').disabled)&&getComputedStyle(plain).listStyleType!=='none'})()`));
  check('keyboard keys render as keys', await evalJS(`(()=>{const k=[...${reply}.querySelectorAll('kbd')];return k.length===2&&k[0].textContent==='Ctrl'&&!k[0].attributes.length&&getComputedStyle(k[0]).display==='inline-block'})()`));
  check('kbd keeps no attributes from the reply', await evalJS(`(()=>{const t=document.createElement('template');t.innerHTML=QResponseTags.sanitizeHTML('<kbd onclick="x()">A</kbd><kbd>B</kbd>');return !t.content.querySelector('[onclick]')&&t.content.querySelectorAll('kbd').length===1})()`));

  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) {
  console.error(e); failed++;
} finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
