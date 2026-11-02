// Edge cases for interactive reply controls that tests/interactive-ui-test.mjs doesn't reach:
// controls with no bound value, Copy and export, broken or oversized source, Stop, typing into
// a control, and moving between providers and chats. Mock backend only, in an invisible Edge
// profile: no account, no site access, no OS-level input.
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
  browserPage = await openPage('interactive-edge-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const waitFor = async (expr, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(`!!(${expr})`)) return true; } catch {}
      await sleep(10);
    }
    return false;
  };
  // Switching provider here starts a fresh chat: these checks are about each site's own state.
  const SETTINGS = { v: 4, animations: 'off', autoDismiss: 0, streamStyle: 'instant', contextSwitching: false };
  const open = async (url = '/?mock=signedin') => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await waitFor(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify(SETTINGS))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const content = "document.querySelector('[data-role=assistant] .turn-content')";
  const sends = () => evalJS(`__mock.count('chat_send')`);
  // Send a prompt and hold the reply, so the test decides what arrives and when.
  const ask = async (prompt = 'Interactive fixture') => {
    const before = await sends();
    await evalJS('window.__mock.hold=true');
    await type(prompt); await key('Enter');
    await waitFor(`__mock.count('chat_send')===${before + 1}`);
    return evalJS(`__mock.last('chat_send').args.id`);
  };
  const emit = (type, id, text) => evalJS(`__mock.emit('bridge',{type:${JSON.stringify(type)},id:${JSON.stringify(id)},text:${JSON.stringify(text)}})`);
  const reply = async (source, prompt) => {
    const id = await ask(prompt);
    await emit('delta', id, source);
    await emit('done', id, source);
    await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`);
    await sleep(40);
    return id;
  };
  const setValue = (selector, value, event) => evalJS(`(()=>{const n=${content}.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
  const read = (expr) => evalJS(`(()=>{const c=${content};return ${expr}})()`);
  const composerWorks = async () => {
    const before = await sends();
    await evalJS('window.__mock.hold=true');
    await type('still works'); await key('Enter');
    return waitFor(`__mock.count('chat_send')===${before + 1}`, 2000);
  };

  // --- Controls with no bound value keep what the user entered when state changes ---
  await open();
  await reply('{@body const [c,setC]=DIL.useState("")}<input aria-label="Free" onInput={setC}/><text>echo:{c}</text>');
  await waitFor(`${content}?.querySelector('input')`);
  await setValue('input', 'typed', 'input');
  check('unbound input echoes state', await read(`c.textContent.includes('echo:typed')`));
  check('unbound input keeps the typed text', (await read(`c.querySelector('input').value`)) === 'typed', await read(`JSON.stringify(c.querySelector('input').value)`));

  await open();
  await reply('{@body const [n,setN]=DIL.useState(1)}<slider aria-label="Free" min={0} max={10} onChange={setN}/><text>echo:{n}</text>');
  await waitFor(`${content}?.querySelector('input[type=range]')`);
  await setValue('input[type=range]', '8', 'input');
  check('unbound slider keeps its position', (await read(`c.querySelector('input').value`)) === '8', await read(`c.querySelector('input').value`));

  await open();
  await reply('{@body const [b,setB]=DIL.useState(false)}<checkbox aria-label="Free" onChange={setB}/><text>echo:{b}</text>');
  await waitFor(`${content}?.querySelector('input[type=checkbox]')`);
  await read(`c.querySelector('input').click()`);
  check('unbound checkbox echoes state', await read(`c.textContent.includes('echo:true')`));
  check('unbound checkbox stays ticked', await read(`c.querySelector('input').checked`));

  await open();
  await reply('{@body const [s,setS]=DIL.useState("")}<select aria-label="Free" onChange={setS}><option value="a">A</option><option value="b">B</option></select><text>echo:{s}</text>');
  await waitFor(`${content}?.querySelector('select')`);
  await setValue('select', 'b', 'change');
  check('unbound select keeps its choice', (await read(`c.querySelector('select').value`)) === 'b', await read(`c.querySelector('select').value`));

  // --- Sibling controls don't reset each other ---
  await open();
  await reply('{@body const [n,setN]=DIL.useState(0)}<input aria-label="Note"/><button onClick={()=>setN(n+1)}>Add</button><text>echo:{n}</text>');
  await waitFor(`${content}?.querySelector('input')`);
  await evalJS(`${content}.querySelector('input').value='keep me'`);
  await read(`c.querySelector('button').click()`);
  check('a button press leaves another control\'s text alone', (await read(`c.querySelector('input').value`)) === 'keep me', await read(`JSON.stringify(c.querySelector('input').value)`));

  // --- Real typing and keys stay inside the control ---
  await open();
  await reply('{@body const [c,setC]=DIL.useState("")}<input aria-label="Name" value={c} onInput={setC}/><text>echo:{c}</text>');
  await waitFor(`${content}?.querySelector('input')`);
  await read(`c.querySelector('input').focus()`);
  await cdp('Input.insertText', { text: 'hello' });
  await sleep(40);
  check('typed text reaches a bound control', (await read(`c.querySelector('input').value`)) === 'hello', await read(`c.querySelector('input').value`));
  check('typing keeps focus in the control', await read(`document.activeElement===c.querySelector('input')`));
  check('typing doesn\'t spill into the composer', (await evalJS(`document.getElementById('prompt-input').value`)) === '');
  const beforeEnter = await sends();
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(40);
  check('Enter in a control sends no prompt', (await sends()) === beforeEnter);
  await evalJS(`document.getElementById('prompt-input').value=''`);

  // --- Copy and export give readable text, not interpreter source ---
  const INTERNALS = /\{@body|DIL\.useState|onClick=|\{#each/;
  const source = '## Picks\n\n{@body const [n,setN]=DIL.useState(0)}\n{#each ["One","Two"] as g}<text>{g}</text>{/each}\n<button onClick={()=>setN(n+1)}>Add</button>\n<text>count:{n}</text>';
  await open();
  await reply(source);
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await evalJS(`(()=>{window.clipWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{clipWrites.push(t)}}});})()`);
  await type('/copy'); await key('Enter');
  await waitFor(`clipWrites.length>0`, 2000);
  const copied = String(await evalJS(`clipWrites[0]`));
  check('/copy hides interpreter source', !INTERNALS.test(copied), copied);
  check('/copy keeps the reply\'s text', copied.includes('Picks'), copied);
  await type('/export'); await key('Enter');
  if (await waitFor(`__mock.last('conversation_export')`, 1500)) {
    const saved = String(await evalJS(`__mock.last('conversation_export').args.markdown`));
    check('export hides interpreter source', !INTERNALS.test(saved), saved);
  } else console.log('NOTE /export did not reach the mock, so export was not exercised');
  await evalJS(`document.getElementById('prompt-input').value=''`);

  // --- Broken and oversized source never takes the rest of the reply with it ---
  await open();
  await reply('Intro stays.\n\n{@body const broken = [');
  check('unterminated declaration keeps the text before it', await read(`c.textContent.includes('Intro stays.')`), await read(`c.textContent`));
  check('unterminated declaration hides its source', await read(`!c.textContent.includes('@body')`), await read(`c.textContent`));
  check('composer works after broken source', await composerWorks());

  await open();
  await reply('Use {@body to declare state. This sentence comes after.');
  check('prose mention of {@body keeps the following text', await read(`c.textContent.includes('This sentence comes after.')`), await read(`c.textContent`));

  await open();
  await reply('Docs:\n\n```\n{@body const [a,b]=DIL.useState(0)}\n```\n\nand `<button onClick={f}>` inline.');
  check('source in code stays literal', await read(`c.querySelector('pre')?.textContent.includes('DIL.useState') && !c.querySelector('[data-qcontrol]')`), await read(`c.innerHTML.slice(0,400)`));

  await open();
  const huge = `[${Array.from({ length: 1500 }, (_, i) => i).join(',')}]`;
  await reply(`Intro stays.\n\n{@body const many=${huge}}\n{#each many as m}<text>{m}</text>{/each}\n\nOutro stays.`);
  check('over-budget loop keeps the surrounding text', await read(`c.textContent.includes('Intro stays.') && c.textContent.includes('Outro stays.')`), await read(`c.textContent.slice(0,200)`));
  check('composer works after an over-budget loop', await composerWorks());

  await open();
  const wide = `Intro stays.\n\n{@body const [s,setS]=DIL.useState("xxxxxxxxxxxxxxxx")}<button onClick={()=>setS(s+s)}>Double</button><text>len:{s.length}</text>`;
  await reply(wide);
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await read(`(()=>{for(let i=0;i<24;i++)c.querySelector('button.qinteractive-control')?.click()})()`);
  check('runaway state growth keeps the reply', await read(`c.textContent.includes('Intro stays.') && !!c.querySelector('button.qinteractive-control')`), await read(`c.textContent.slice(0,200)`));

  await open();
  await reply('{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>{let i=0;while(true){i=i+1}}}>Spin</button><text>n:{n}</text>');
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  const started = Date.now();
  await read(`c.querySelector('button.qinteractive-control').click()`);
  check('endless loop in a handler returns quickly', Date.now() - started < 2000, `${Date.now() - started}ms`);
  check('composer works after an endless handler', await composerWorks());

  await open();
  const spam = Array.from({ length: 400 }, (_, i) => `<button onClick={()=>setN(${i})}>B${i}</button>`).join('');
  await reply(`{@body const [n,setN]=DIL.useState(-1)}${spam}<text>picked:{n}</text>`);
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  const count = await read(`c.querySelectorAll('button.qinteractive-control').length`);
  check('control spam renders', count === 400, String(count));
  await read(`c.querySelectorAll('button.qinteractive-control')[399]?.click()`);
  check('the right control fires among hundreds', await read(`c.textContent.includes('picked:399')`));

  await open();
  await reply(`{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>setN(1)}>${'L'.repeat(5000)}</button>`);
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  check('very long label doesn\'t widen the page', await evalJS(`document.documentElement.scrollWidth<=innerWidth`), await evalJS(`document.documentElement.scrollWidth+'>'+innerWidth`));

  await open();
  await reply('{@body const [n,setN]=DIL.useState(5)}<input type="number" aria-label="N" value={n} onInput={setN}/><text>n:{n}</text>');
  await waitFor(`${content}?.querySelector('input')`);
  await setValue('input', '', 'input');
  check('clearing a number input survives', await read(`!!c.querySelector('input')`));
  await setValue('input', '1e999', 'input');
  check('an infinite number keeps the control', await read(`!!c.querySelector('input') && !c.textContent.includes('Infinity')`), await read(`c.textContent`));

  // --- Stop mid-widget ---
  await open();
  const stopId = await ask();
  await emit('delta', stopId, 'Intro stays.\n\n{@body const [n,setN]=DIL.useState(0)}\n\n<button onClick={()=>setN(n+1)}>Add</button>\n\n{@body const half=[');
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await evalJS(`document.getElementById('btn-send').click()`);
  await waitFor(`document.querySelector('[data-role=assistant]')?.dataset.status!=='streaming'`);
  await sleep(60);
  check('Stop keeps a working control', await read(`!!c.querySelector('button.qinteractive-control')`), await read(`c.textContent`));
  check('Stop hides unfinished source', await read(`!c.textContent.includes('@body')`), await read(`c.textContent`));
  check('composer works after Stop', await composerWorks());

  // --- Crosstalk inside one reply ---
  await open();
  await reply('{@body const [a,setA]=DIL.useState(0)}{@body const [b,setB]=DIL.useState(0)}<button onClick={()=>setA(a+1)}>A</button><button onClick={()=>setB(b+1)}>B</button><text>a:{a} b:{b}</text>');
  await waitFor(`${content}?.querySelectorAll('button.qinteractive-control').length===2`);
  await read(`c.querySelectorAll('button.qinteractive-control')[1].click()`);
  await read(`c.querySelectorAll('button.qinteractive-control')[1].click()`);
  await read(`c.querySelectorAll('button.qinteractive-control')[0].click()`);
  check('two controls keep separate state', await read(`c.textContent.includes('a:1 b:2')`), await read(`c.textContent`));

  // --- Across providers ---
  const pickProvider = async (name) => {
    await evalJS(`document.getElementById('btn-reasoning').click()`);
    await waitFor(`!document.getElementById('picker').hidden`);
    await evalJS(`[...document.querySelectorAll('#picker .picker-seg-btn')].find(n=>n.textContent.includes(${JSON.stringify(name)})).click()`);
    await waitFor(`__mock.provider===${JSON.stringify(name.toLowerCase())}`);
    await sleep(120);
    if (!(await evalJS(`document.getElementById('picker').hidden`))) await evalJS(`document.getElementById('btn-reasoning').click()`);
    await sleep(40);
  };
  const counter = (tag) => `## ${tag}\n\n{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>setN(n+1)}>Add</button><text>${tag}:{n}</text>`;
  await open();
  await reply(counter('chatgpt'), 'first');
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await read(`c.querySelector('button.qinteractive-control').click()`);
  check('ChatGPT reply counts', await read(`c.textContent.includes('chatgpt:1')`));
  await pickProvider('Gemini');
  check('moving to Gemini leaves no ChatGPT control behind', await evalJS(`!document.querySelector('[data-role=assistant] [data-qcontrol]')`));
  await reply(counter('gemini'), 'second');
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await read(`c.querySelector('button.qinteractive-control').click()`);
  check('a Gemini reply is interactive too', await read(`c.textContent.includes('gemini:1')`), await read(`c.textContent`));
  check('Gemini reply starts from its own state', await read(`!c.textContent.includes('chatgpt')`), await read(`c.textContent`));
  await pickProvider('ChatGPT');
  const waited = await waitFor(`[...document.querySelectorAll('#tabs .tab')].length>=1`);
  check('earlier chats are offered as tabs', waited);
  const tabInfo = await evalJS(`JSON.stringify([...document.querySelectorAll('#tabs .tab')].map(t=>t.getAttribute('aria-label')))`);
  await evalJS(`[...document.querySelectorAll('#tabs .tab')].find(t=>/first/i.test(t.getAttribute('aria-label')||t.textContent))?.click()`);
  const backOk = await waitFor(`${content}?.textContent.includes('chatgpt:')`, 2000);
  check('returning shows the ChatGPT reply', backOk, tabInfo);
  if (backOk) {
    await read(`c.querySelector('button.qinteractive-control')?.click()`);
    check('the returned reply still responds', await read(`/chatgpt:[1-9]/.test(c.textContent)`), await read(`c.textContent`));
    check('the returned reply shows nothing from Gemini', await read(`!c.textContent.includes('gemini')`));
  }

  // --- Find over a reply with controls ---
  await open();
  await reply(counter('findme'));
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await read(`c.querySelector('button.qinteractive-control').click()`);
  await type('/find'); await key('Enter');
  await waitFor(`!document.getElementById('find-bar').hidden`);
  // Find searches History, and each History row runs its own session from the reply's starting
  // state, so it sees findme:0 even after the bubble has moved on to findme:1.
  await evalJS(`(()=>{const i=document.getElementById('find-input');i.value='findme:0';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const found = await waitFor(`/^1\\/1$/.test(document.getElementById('find-count')?.textContent.replace(/\\s/g,''))`, 2000);
  check('Find reaches text rendered by the interpreter', found, await evalJS(`document.getElementById('find-count')?.textContent`));
  await evalJS(`(()=>{const i=document.getElementById('find-input');i.value='DIL.useState';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  check('Find doesn\'t match interpreter source', await waitFor(`!/^\\d+\\/[1-9]/.test(document.getElementById('find-count')?.textContent.trim())`, 2000), await evalJS(`document.getElementById('find-count')?.textContent`));

  // --- Copy reads as plain text, and streaming prose isn't mistaken for a declaration ---
  await open();
  await reply('{@body const [n,setN]=DIL.useState("R&D <x> *y*")}<button onClick={()=>setN("z")}>Add</button><text>{n}</text>');
  await waitFor(`${content}?.querySelector('button.qinteractive-control')`);
  await evalJS(`(()=>{window.clipWrites=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{clipWrites.push(t)}}});})()`);
  await type('/copy'); await key('Enter');
  await waitFor(`clipWrites.length>0`, 2000);
  const special = String(await evalJS(`clipWrites[0]`));
  check('copied state values have no HTML entities', special.includes('R&D') && !/&amp;|&lt;|&gt;/.test(special), special);
  check('copied text keeps the button label', special.includes('Add'), special);

  await open();
  const proseId = await ask();
  await emit('delta', proseId, 'A quick note:\n\nUse {@body to declare state.\n\nThis paragraph follows.\n\n');
  check('streaming prose after {@body isn\'t held back', await waitFor(`${content}?.textContent.includes('This paragraph follows.')`, 1500), await read(`c.textContent`));
  await emit('done', proseId, 'A quick note:\n\nUse {@body to declare state.\n\nThis paragraph follows.');
  await open();
  const realId = await ask();
  await emit('delta', realId, 'Intro.\n\n{@body const items = [\n\n"Pending');
  await sleep(50);
  check('a real declaration stays hidden while it streams', await read(`!c.textContent.includes('Pending') && !c.textContent.includes('@body')`), await read(`c.textContent`));

  check('no runtime or CSP errors', problems.length === 0, problems.join(' | '));
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
