// Streaming feedback, paint-only word entrances, block reuse and reader-owned scrolling.
// Isolated headless mock UI; never accesses a provider or the running app's profile.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const shotsAt = process.argv.indexOf('--screenshots');
const shots = shotsAt < 0 ? null : process.argv[shotsAt + 1];
const { base, close: closeServer } = await serveUI();
let page, failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};
try {
  page = await openPage('stream-reading-ui', { problems });
  const { cdp, evalJS } = page;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  const wait = async expression => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) { if (await evalJS(`!!(${expression})`)) return; await sleep(10); }
    throw new Error(`Timed out: ${expression}`);
  };
  const reply = `document.querySelector('[data-role=assistant] .turn-content')`;
  const live = `document.querySelector('[data-role=assistant] .live-status')`;
  const writing = `(!${live}.hidden && ${live}.dataset.kind==='writing')`;
  const begin = async (animations = 'on') => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await wait(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear();localStorage.setItem('qchat.settings',JSON.stringify({animations:${JSON.stringify(animations)},autoDismiss:0,idleCollapse:0,streamStyle:'paragraph'}))`);
    await cdp('Page.navigate', { url: base });
    await wait(`window.__mock && window.QSettings && document.readyState==='complete'`);
    await evalJS(`__mock.hold=true;const input=document.getElementById('prompt-input');input.value='Streaming reading fixture';input.dispatchEvent(new Event('input'));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await wait(`__mock.last('chat_send')`);
  };
  const emit = (type, text, extra = {}) => evalJS(`__mock.emit('bridge',{...${JSON.stringify({ type, text, ...extra })},id:__mock.last('chat_send').args.id})`);
  const shot = async name => {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    const result = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shots, `${name}.png`), Buffer.from(result.data, 'base64'));
  };

  await begin();
  await emit('delta', 'Still composing the first paragraph');
  await wait(`!${live}.hidden`);
  check('unfinished first text stays buffered with the initial thinking state', await evalJS(`${reply}.textContent==='' && ${live}.dataset.kind==='thinking' && ${live}.textContent.includes('Thinking')`));
  const first = 'One **finished** paragraph with words that arrive calmly.\n\n';
  await emit('delta', first + 'The next paragraph is still being composed');
  await wait(`${reply}.querySelector('strong')`);
  check('Writing is visible while the next block is buffered', await evalJS(`${writing} && ${live}.querySelector('.live-status-label').dataset.text==='Writing' && !${reply}.textContent.includes('being composed')`));
  check('Writing stays outside the reply text and has a status role', await evalJS(`!${reply}.contains(${live}) && !${live}.closest('.bubble-response') && ${live}.getAttribute('role')==='status'`));
  const fading = await evalJS(`new Promise(resolve=>{const samples=[];const start=performance.now();const tick=()=>{samples.push([0,1,2].map(i=>[...CSS.highlights.get('qchat-fade-'+i)||[]].map(r=>r.toString())));if(performance.now()-start<400)requestAnimationFrame(tick);else resolve(samples)};tick()})`);
  check('word groups progress through different fade stages', fading.some(sets => sets.filter(set => set.length).length > 1), JSON.stringify(fading.slice(0, 3)));
  check('the word entrance settles within its short time budget', await evalJS(`[0,1,2].every(i=>!CSS.highlights.get('qchat-fade-'+i)?.size)`));
  await shot('writing');
  await evalJS(`window.__paragraph=${reply}.querySelector('p');window.__text=__paragraph.firstChild;const range=document.createRange();range.selectNodeContents(__paragraph);getSelection().removeAllRanges();getSelection().addRange(range);window.__selected=getSelection().toString();window.__parsed=[];const parse=marked.parser;marked.parser=function(tokens,...rest){__parsed.push(tokens.map(t=>t.raw).join(''));return parse.call(this,tokens,...rest)}`);
  const second = first + 'Another finished paragraph.\n\n';
  await emit('delta', second + 'Pending');
  await wait(`${reply}.textContent.includes('Another finished')`);
  check('later blocks do not parse completed prose again', await evalJS(`__parsed.length>0 && __parsed.every(raw=>!raw.includes('One **finished**'))`));
  check('later blocks preserve the selected paragraph and text node', await evalJS(`__paragraph===${reply}.querySelector('p') && __text===__paragraph.firstChild && getSelection().toString()===__selected`));
  await emit('activity', undefined, { kind: 'search', state: 'running' });
  await wait(`${live}.dataset.kind==='search'`);
  check('tool activity takes over from Writing in the same capsule', await evalJS(`!${writing} && !${live}.hidden && ${live}.textContent.includes('Searching the web')`));
  await emit('activity', undefined, { kind: 'search', state: 'complete' });
  await wait(`${live}.hasAttribute('data-done')`);
  check('the finished search is held briefly before Writing returns', await evalJS(`${live}.textContent.includes('Searched the web') && !${writing}`));
  await wait(writing);
  check('Writing returns after the tool finishes, with the search in its trail', await evalJS(`${writing} && ${live}.querySelectorAll('.live-step[data-kind=search]').length===1`));
  await emit('image_progress', undefined, { state: 'generating' });
  await wait(`!document.querySelector('.image-generation').hidden`);
  check('image progress replaces Writing', await evalJS(`${live}.hidden && !document.querySelector('.image-generation').hidden`));
  await emit('image_progress', undefined, { state: 'complete' });
  await wait(writing);
  check('Writing returns after image generation', await evalJS(`${writing}`));
  await emit('done', second + 'Final tail.');
  await wait(`document.querySelector('[data-role=assistant]').dataset.status==='done'`);
  check('completion flushes the tail, Writing and every fade immediately', await evalJS(`${live}.hidden && ${reply}.textContent.trimEnd().endsWith('Final tail.') && [0,1,2].every(i=>!CSS.highlights.has('qchat-fade-'+i))`));

  await begin('off');
  await emit('delta', '- First **finished** item\n  - Nested item\n- Second pending');
  await wait(`${reply}.querySelector('li strong')`);
  check('a completed list item appears with its nested content', await evalJS(`${reply}.querySelector('li strong').textContent==='finished' && ${reply}.textContent.includes('Nested item') && !${reply}.textContent.includes('Second')`));
  await evalJS(`window.__item=${reply}.querySelector('li');window.__strong=__item.querySelector('strong')`);
  await emit('delta', '- First **finished** item\n  - Nested item\n- Second finished\n- Third pending');
  await wait(`${reply}.textContent.includes('Second finished')`);
  check('the next sibling appears without replacing the earlier item', await evalJS(`__item===${reply}.querySelector('li') && __strong===__item.querySelector('strong') && !${reply}.textContent.includes('Third')`));
  check('motion off keeps all fade highlights absent', await evalJS(`[0,1,2].every(i=>!CSS.highlights.has('qchat-fade-'+i))`));
  await evalJS(`document.getElementById('btn-send').click()`);
  await wait(`document.querySelector('[data-role=assistant]').dataset.status==='done'`);
  check('Stop flushes the pending item and hides Writing', await evalJS(`${reply}.textContent.includes('Third pending') && !${writing}`));

  await begin();
  const reference = 'A [reference][docs].\n\n';
  await emit('delta', reference + 'Pending');
  await wait(`${reply}.textContent.includes('reference')`);
  await emit('done', reference + '[docs]: https://example.com/docs\n');
  await wait(`${reply}.querySelector('a')`);
  check('late reference definitions update already-rendered text', await evalJS(`${reply}.querySelector('a').href==='https://example.com/docs'`));

  await begin();
  await emit('delta', 'Value $$x^2$$.\n\nPending');
  await wait(`${reply}.querySelector('[data-qmath]')`);
  await emit('delta', 'Value $$y^2$$.\n\nPending');
  await wait(`${reply}.querySelector('[data-qmath]').getAttribute('aria-label').includes('y')`);
  check('a formula correction invalidates cached markup even with identical token offsets', await evalJS(`!${reply}.querySelector('[data-qmath]').getAttribute('aria-label').includes('x')`));
  await emit('error', undefined, { code: 'stream_failed' });
  check('an interruption preserves received text and clears Writing and fade', await evalJS(`!${writing} && ${reply}.textContent.includes('Pending') && [0,1,2].every(i=>!CSS.highlights.has('qchat-fade-'+i))`));

  await begin('off');
  const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: a steady reply with enough words to scroll and read.`).join('\n\n') + '\n\n';
  await emit('delta', long + 'Pending');
  await wait(`document.querySelector('[data-role=assistant]').hasAttribute('data-capped')`);
  await wait(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<=2})()`);
  await evalJS(`(()=>{const scroller=document.querySelector('.bubble-scroll');scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));scroller.scrollTop-=100})()`);
  await sleep(170);
  await evalJS(`(()=>{const scroller=document.querySelector('.bubble-scroll');scroller.scrollTop=scroller.scrollHeight-scroller.clientHeight-24;window.__heldTop=scroller.scrollTop})()`);
  await wait(`!document.querySelector('.jump-chip').hidden`);
  await sleep(180);
  check('scrolling down near the bottom leaves the reader in control', await evalJS(`Math.abs(document.querySelector('.bubble-scroll').scrollTop-__heldTop)<2 && !document.querySelector('.jump-chip').hidden`));
  await emit('delta', long + 'A newly completed paragraph.\n\nPending');
  await wait(`${reply}.textContent.includes('newly completed')`);
  check('new blocks preserve the paused reading position', await evalJS(`Math.abs(document.querySelector('.bubble-scroll').scrollTop-__heldTop)<2`));
  await shot('reading-paused');
  await evalJS(`document.querySelector('.jump-chip').click()`);
  await wait(`document.querySelector('.jump-chip').hidden`);
  check('Latest resumes following at the real bottom', await evalJS(`(()=>{const s=document.querySelector('.bubble-scroll');return s.scrollHeight-s.scrollTop-s.clientHeight<=2})()`));
  await emit('done', long + 'Final.');
  check('no runtime errors', problems.length === 0, problems.join(' | '));
} catch (error) {
  console.error(error); failed++;
} finally {
  await page?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
