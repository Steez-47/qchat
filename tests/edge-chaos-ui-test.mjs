// Tries to break the real UI: hostile replies, corrupted storage, bridge events that arrive late,
// twice or for the wrong chat, and rapid input. Mock backend in an isolated, invisible page.
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();
const problems = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};
const page = await openPage('edge-chaos-ui', { problems });
const { cdp, evalJS } = page;

const until = async (expr, what = expr, tries = 500) => {
  for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
  throw new Error(`Timed out waiting for: ${what}`);
};
const clean = () => { const seen = problems.splice(0); return seen; };
// Loads the app with exactly these storage values, with no animation to wait for.
const open = async (storage = {}, query = '') => {
  await cdp('Page.navigate', { url: `${base}/${query}` });
  await until(`document.readyState==='complete'`);
  await evalJS(`localStorage.clear();${Object.entries(storage).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`).join(';')}`);
  await cdp('Page.navigate', { url: `${base}/${query}` });
  await until(`document.readyState==='complete' && window.QSettings && document.getElementById('prompt-input')`);
  await evalJS(`__mock.interval=1`);
};
const SETTINGS = JSON.stringify({ v: 7, animations: 'off', streamStyle: 'instant', idleCollapse: 0, autoDismiss: 0, showPrompt: true });
const fast = { 'qchat.settings': SETTINGS };
const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const enter = () => evalJS(`document.getElementById('prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
const send = async (text) => { await type(text); await enter(); };
const replyCount = () => evalJS(`document.querySelectorAll('[data-role=assistant]').length`);
const replyDone = () => until(`[...document.querySelectorAll('[data-role=assistant]')].at(-1)?.dataset.status==='done'`, 'reply done');
const replyHTML = () => evalJS(`[...document.querySelectorAll('[data-role=assistant] .turn-content')].at(-1)?.innerHTML ?? ''`);
const replyText = () => evalJS(`[...document.querySelectorAll('[data-role=assistant] .turn-content')].at(-1)?.textContent ?? ''`);
// Anything in the replies that could run code or load a remote page.
const AUDIT = `(()=>{const found=[];
  for(const n of document.querySelectorAll('[data-role=assistant] .turn-content *')){
    const tag=n.tagName.toLowerCase();
    if(['script','iframe','object','embed','base','meta','link','form','style','frame','frameset'].includes(tag))found.push(tag);
    for(const a of n.attributes){
      if(/^on/i.test(a.name))found.push(tag+'['+a.name+']');
      if(['href','src','srcdoc','action','formaction','xlink:href'].includes(a.name.toLowerCase())&&/^\\s*(javascript|vbscript|data:text)/i.test(a.value))found.push(tag+'['+a.name+'='+a.value+']');
      if(a.name==='srcdoc')found.push(tag+'[srcdoc]');
    }
  }
  return found;})()`;

try {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  // --- Hostile replies ---------------------------------------------------------------------------
  const ATTACKS = [
    '<script>window.__pwned=1</script>', '<img src=x onerror="window.__pwned=2">', '<svg onload="window.__pwned=3"></svg>', '<iframe srcdoc="<script>parent.__pwned=4</script>"></iframe>',
    '<a href="javascript:window.__pwned=5">click</a>', '[md link](javascript:window.__pwned=6)', '[encoded](java&#115;cript:window.__pwned=7)', '![image](javascript:window.__pwned=8)',
    '<details open ontoggle="window.__pwned=9">x</details>', '<input autofocus onfocus="window.__pwned=10">', '<video src=x onerror="window.__pwned=11"></video>', '<style>@import "http://evil.example/x.css";</style>',
    '<meta http-equiv="refresh" content="0;url=http://evil.example">', '<base href="http://evil.example/">', '<form action="javascript:window.__pwned=12"><button>go</button></form>', '<object data="javascript:window.__pwned=13"></object>',
    '<Link href="javascript:window.__pwned=14">x</Link>', '<Entity value={window.__pwned=15}/>', '<Cite ref={constructor.constructor("window.__pwned=16")()}/>', '$\\href{javascript:window.__pwned=17}{x}$',
    '```html\n<script>window.__pwned=18</script>\n```', '| <img src=x onerror="window.__pwned=19"> |\n|---|\n| x |', '- <img src=x onerror="window.__pwned=20">', '> <img src=x onerror="window.__pwned=21">', '<div><div><div><img src=x onerror="window.__pwned=22"></div></div></div>'
  ];
  await open(fast);
  const badHTML = [];
  for (const attack of ATTACKS) {
    await evalJS(`__mock.reply=${JSON.stringify(`Before\n\n${attack}\n\nAfter`)}`);
    await send('attack');
    await until(`[...document.querySelectorAll('[data-role=assistant]')].at(-1)?.dataset.status==='done' && __mock.last('chat_send')`, attack);
    await sleep(5);
    const audit = await evalJS(AUDIT);
    if (audit.length) badHTML.push(`${attack} => ${audit.join(',')}`);
    await evalJS(`document.getElementById('btn-new')?.click()`);
    await sleep(5);
  }
  await sleep(120);
  check('hostile replies leave no live script, handler or remote page', badHTML.length === 0, badHTML.join(' | '));
  check('hostile replies never run any code', await evalJS(`window.__pwned`) === undefined, String(await evalJS(`window.__pwned`)));
  clean();

  // --- Awkward but valid replies -----------------------------------------------------------------
  const AWKWARD = {
    'an empty reply': '',
    'only spaces': '   \n\n   ',
    'only a fence opener': '```',
    'an unclosed fence': '```js\nconst a = 1;',
    'an unclosed table': '| a | b |\n|---|',
    'a table with no rows': '| a |\n|---|',
    'a very wide table': `| ${Array(60).fill('col').join(' | ')} |\n|${Array(60).fill('---').join('|')}|\n| ${Array(60).fill('x').join(' | ')} |`,
    'deep nesting': `${'> '.repeat(60)}quoted\n\n${Array.from({ length: 60 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n')}`,
    'one enormous word': 'x'.repeat(120000),
    'right to left text': 'مرحبا بالعالم\n\nשלום עולם',
    'emoji and joiners': '👩‍👩‍👧‍👦 🏳️‍🌈 é ​‍',
    'control characters': 'a\u0000b\u0007c\u001bd',
    'lone surrogates': 'a\ud83db\udc00c',
    'private use markers': ' 0  q0: text',
    'windows line ends': 'One\r\n\r\nTwo\r\n',
    'a bad formula': '$\\frac{$ and $$\\begin{matrix}$$',
    'a bare link': 'see https://example.com/?a=1&b=<2>',
    'a heading only': '#',
    'markdown in a code span': '`**not bold**`'
  };
  await open(fast);
  for (const [name, reply] of Object.entries(AWKWARD)) {
    clean();
    await evalJS(`__mock.reply=${JSON.stringify(reply)}`);
    await send(name);
    let finished = true;
    try { await until(`[...document.querySelectorAll('[data-role=assistant]')].at(-1)?.dataset.status!=='streaming' && !document.getElementById('btn-send').dataset.mode?.includes('stop')`, name, 800); } catch { finished = false; }
    const width = await evalJS(`document.getElementById('bar').getBoundingClientRect().width`);
    check(`${name} renders without an error and leaves the app usable`, finished && problems.length === 0 && width > 100, problems.join(' | ').slice(0, 300));
    await evalJS(`document.getElementById('btn-new')?.click()`);
    await sleep(5);
  }
  await evalJS(`__mock.reply=${JSON.stringify('Fine **again**')}`);
  await send('after');
  await until(`[...document.querySelectorAll('[data-role=assistant]')].at(-1)?.textContent.includes('Fine again')`, 'recovered');
  check('the app still answers after every awkward reply', (await replyHTML()).includes('<strong>again</strong>'));

  // --- Corrupted storage -------------------------------------------------------------------------
  const CHATS = {
    'broken JSON': '{',
    'the wrong type': '[]',
    null: 'null',
    'a number': '5',
    'a chat list of junk': JSON.stringify({ v: 1, current: null, recent: [null, 5, 'x', [], {}] }),
    'chats missing their fields': JSON.stringify({ v: 1, current: {}, recent: [{ key: 'a' }, { conversationId: 5 }, { key: 5, title: {}, lastActive: 'x' }] }),
    'hostile titles': JSON.stringify({ v: 1, current: { key: 'c', title: '<img src=x onerror="window.__pwned=30">', createdAt: 1, lastActive: 1 }, recent: [{ key: 'k', conversationId: 'c', title: '<script>window.__pwned=31</script>', lastPrompt: '<img src=x onerror="window.__pwned=32">', lastResponse: '<img src=x onerror="window.__pwned=33">', lastActive: 1, createdAt: 1 }] }),
    'impossible dates': JSON.stringify({ v: 1, current: { key: 'c', createdAt: 1e30, lastActive: -1e30 }, recent: [{ key: 'k', conversationId: 'c', title: 'x', lastActive: 'never', createdAt: NaN }] }),
    'a future version': JSON.stringify({ v: 999, current: { key: 'c' }, recent: [] }),
    'prototype keys': '{"__proto__":{"polluted":1},"v":1,"current":{"__proto__":{"polluted":2}},"recent":[]}'
  };
  for (const [name, chats] of Object.entries(CHATS)) {
    clean();
    await open({ ...fast, 'qchat.chats': chats });
    await evalJS(`__mock.reply='Still works'`);
    await send('hello');
    let works = true;
    try { await until(`document.querySelector('[data-role=assistant] .turn-content')?.textContent.includes('Still works')`, name, 400); } catch { works = false; }
    check(`stored chats with ${name} don't stop the app`, works && problems.length === 0 && await evalJS(`({}).polluted===undefined && window.__pwned===undefined`), problems.join(' | ').slice(0, 300));
  }

  for (const [name, settings] of Object.entries({ 'broken JSON': '{', null: 'null', 'an array': '[]', 'junk values': JSON.stringify({ v: 7, animations: 5, look: {}, barWidth: 'wide', textSize: null, replyWidth: -1, tabCount: 1e9, placeholderText: '<img src=x onerror="window.__pwned=40">', accentColor: 'url(javascript:x)', idleCollapse: 'soon' }) })) {
    clean();
    await open({ 'qchat.settings': settings });
    const usable = await evalJS(`document.getElementById('bar').getBoundingClientRect().width>100 && !document.querySelector('#prompt-input').disabled && window.__pwned===undefined`);
    check(`stored settings with ${name} still give a usable bar`, usable && problems.length === 0, problems.join(' | ').slice(0, 300));
  }

  // Storage that fails after loading, as on a full disk.
  clean();
  await open(fast);
  await evalJS(`__mock.reply='Quota reply';Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError')}`);
  await send('with full storage');
  await until(`[...document.querySelectorAll('[data-role=assistant]')].at(-1)?.textContent.includes('Quota reply')`, 'quota reply');
  await type('a draft on a full disk');
  await sleep(60);
  check('a full disk never breaks a chat', problems.filter((p) => !/quota/i.test(p)).length === 0, problems.join(' | ').slice(0, 300));
  check('a full disk keeps the draft on screen', await evalJS(`document.getElementById('prompt-input').value`) === 'a draft on a full disk');

  // --- Bridge events out of order ----------------------------------------------------------------
  clean();
  await open(fast);
  await evalJS(`__mock.hold=true;__mock.reply='Real reply'`);
  await send('events');
  await until(`__mock.last('chat_send')`, 'send');
  const turn = await evalJS(`__mock.last('chat_send').args.id`);
  const emit = (event) => evalJS(`__mock.emit('bridge',${JSON.stringify(event)})`);
  for (const junk of [
    { type: 'delta', id: 'someone-else', text: 'WRONG TURN' }, { type: 'done', id: 'someone-else', text: 'WRONG DONE' }, { type: 'error', id: 'someone-else', code: 'x', message: 'WRONG ERROR' }, { type: 'media', id: 'someone-else', items: [{ id: 'm', kind: 'image', name: 'x.png' }] },
    { type: 'nosuchtype', id: turn }, { type: 'nosuchtype' }, {}, { type: null }, { type: 5 }, { type: 'delta' }, { type: 'delta', id: turn }, { type: 'delta', id: turn, text: null }, { type: 'delta', id: turn, text: 5 }, { type: 'delta', id: turn, text: {} }, { type: 'media', id: turn }, { type: 'media', id: turn, items: 'x' }, { type: 'media', id: turn, items: [null, 5, {}] }, { type: 'status' }, { type: 'models' }, { type: 'models', models: 'x' }, { type: 'modes' }, { type: 'modes', modes: null }
  ]) await emit(junk);
  await sleep(40);
  check('junk and other chats\' events leave the turn alone', !(await replyText()).includes('WRONG') && problems.length === 0, `${await replyText()} ${problems.join(' | ').slice(0, 300)}`);
  check('an error naming a turn that has gone shows no banner', !/WRONG ERROR/.test(await evalJS(`document.body.textContent`)));
  await emit({ type: 'delta', id: turn, text: 'Longer text so far.\n\n' });
  await emit({ type: 'delta', id: turn, text: 'Short' });
  await sleep(30);
  await emit({ type: 'done', id: turn, text: 'Finished once', conversationId: 'conv-x' });
  await replyDone();
  await emit({ type: 'done', id: turn, text: 'FINISHED TWICE', conversationId: 'conv-y' });
  await emit({ type: 'delta', id: turn, text: 'LATE DELTA' });
  await emit({ type: 'error', id: turn, code: 'rate_limited', message: 'LATE ERROR' });
  await sleep(40);
  const settled = await replyText();
  check('a finished reply ignores anything that arrives afterwards', settled.includes('Finished once') && !/TWICE|LATE/.test(settled) && !/LATE ERROR/.test(await evalJS(`document.body.textContent`)), settled);
  check('out of order events raise no runtime errors', problems.length === 0, problems.join(' | ').slice(0, 300));
  // What is shown can hide a bad state; History's fresh render and the saved chat can't.
  await evalJS(`document.getElementById('btn-history').click()`);
  await sleep(120);
  const history = await evalJS(`document.getElementById('history-panel')?.textContent ?? ''`);
  check('late events never reach History', history.includes('Finished once') && !/TWICE|LATE/.test(history), history.slice(0, 300));
  await evalJS(`document.getElementById('btn-history').click()`);
  await sleep(120);
  await cdp('Page.navigate', { url: `${base}/` });
  await until(`document.readyState==='complete' && window.QSettings && document.querySelector('[data-role=assistant] .turn-content')`, 'restored reply');
  const restored = await replyText();
  check('late events never reach the saved chat', restored.includes('Finished once') && !/TWICE|LATE/.test(restored), restored);

  // --- Rapid input -------------------------------------------------------------------------------
  clean();
  await open(fast);
  await evalJS(`__mock.interval=5;__mock.reply='Rapid reply text'`);
  await evalJS(`(()=>{const i=document.getElementById('prompt-input');for(let n=0;n<8;n++){i.value='double '+n;i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));}})()`);
  await sleep(50);
  check('mashing Enter sends only one request', await evalJS(`__mock.count('chat_send')`) === 1, String(await evalJS(`__mock.count('chat_send')`)));
  await replyDone();

  clean();
  await open(fast);
  await send('   \n\t  ');
  await sleep(30);
  check('a blank prompt never sends', await evalJS(`__mock.count('chat_send')`) === 0);
  await send('​');
  await sleep(10);

  clean();
  await open(fast);
  await evalJS(`__mock.hold=true`);
  for (let n = 0; n < 5; n++) {
    await send(`stop ${n}`);
    await until(`document.getElementById('btn-send').dataset.mode==='stop'`, 'streaming');
    await evalJS(`document.getElementById('btn-send').click();document.getElementById('btn-send').click();document.getElementById('btn-send').click()`);
    await until(`document.getElementById('btn-send').dataset.mode!=='stop'`, 'stopped');
  }
  check('stop mashed during five replies leaves the composer ready', await evalJS(`document.getElementById('btn-send').dataset.mode!=='stop' && !document.getElementById('prompt-input').disabled`) && problems.length === 0, problems.join(' | ').slice(0, 300));

  clean();
  await open(fast);
  const huge = 'long prompt '.repeat(50000);
  await type(huge);
  await sleep(20);
  check('a huge pasted prompt stays intact in the composer', await evalJS(`document.getElementById('prompt-input').value.length`) === huge.length);
  await enter();
  await until(`__mock.last('chat_send')`, 'huge send');
  check('a huge prompt is sent whole', await evalJS(`__mock.last('chat_send').args.prompt.trim().length`) === huge.trim().length);
  await replyDone();
  check('huge prompts raise no runtime errors', problems.length === 0, problems.join(' | ').slice(0, 300));

  // --- Resize and environment ----------------------------------------------------------------------
  clean();
  await open(fast);
  for (const [width, height] of [[320, 200], [200, 100], [1, 1], [3840, 2160], [760, 800]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
    await sleep(10);
  }
  check('extreme window sizes raise no runtime errors', problems.length === 0, problems.join(' | ').slice(0, 300));
  for (const [event, payload] of [['qchat://hidden', null], ['qchat://shown', null], ['qchat://hidden', null], ['qchat://shown', null], ['qchat://settings-changed', { look: 'nosuch', textSize: 'x' }], ['qchat://settings-changed', null], ['qchat://nosuchevent', { a: 1 }]]) {
    await evalJS(`__mock.emit(${JSON.stringify(event)},${JSON.stringify(payload)})`).catch(() => {});
  }
  await sleep(20);
  check('repeated and junk window events raise no runtime errors', problems.length === 0, problems.join(' | ').slice(0, 300));
} catch (error) {
  console.error(error);
  if (problems.length) console.error('console:', problems.slice(0, 5).join(' | '));
  failed++;
} finally {
  await page.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
