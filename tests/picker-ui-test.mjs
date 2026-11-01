// Compact provider, mode and model picker, in an isolated invisible Edge profile. Mock backend only.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

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
  browserPage = await openPage('picker-ui', { problems });
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
  const click = (sel) => evalJS(`${q(sel)}.click()`);
  const pill = () => click('#btn-reasoning');
  const shots = path.join(root, 'dist', 'qa-picker');
  await mkdir(shots, { recursive: true });
  const shot = async (name) => writeFile(path.join(shots, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // Real key events through the browser's own input pipeline (no OS input).
  const KEYS = { Enter: [13, '\r'], Escape: [27], Tab: [9], ArrowLeft: [37], ArrowRight: [39], ArrowDown: [40], ArrowUp: [38], ' ': [32, ' '] };
  const press2 = async (k, modifiers = 0) => {
    const [code, text] = KEYS[k];
    await cdp('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: code, text, modifiers });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: code, modifiers });
    await sleep(40);
  };
  const focusKey = () => evalJS(`document.activeElement?.dataset?.pickerKey || document.activeElement?.id || ''`);
  const rect = (sel) => evalJS(`(()=>{const r=${q(sel)}.getBoundingClientRect();return [r.left,r.top,r.width,r.height].map(n=>Math.round(n*100)/100).join(',')})()`);
  const chatState = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats')||'{}').current||{}`);
  const pickerOpen = () => evalJS(`!${q('#picker')}.hidden`);
  const rows = () => evalJS(`[...document.querySelectorAll('#picker .picker-row')].map(n=>n.querySelector('.picker-title').textContent)`);
  const say = async (text) => { await evalJS(`document.getElementById('prompt-input').focus()`); await send(text); };
  const open0 = async (url = '/?mock=signedin', opts) => { await open(url, opts); await waitFor(`document.getElementById('btn-reasoning')`); await sleep(120); };

  // ---- the pill
  await open0();
  check('pill names provider and value', await evalJS(`${q('#btn-reasoning')}.getAttribute('aria-label')==='ChatGPT, Medium. Change model'`));
  check('pill has dialog popup state and a provider mark', await evalJS(`(()=>{const b=${q('#btn-reasoning')};return b.getAttribute('aria-haspopup')==='dialog'&&b.getAttribute('aria-expanded')==='false'&&!!b.querySelector('svg.reasoning-mark')&&!!b.querySelector('svg.reasoning-chevron')&&b.querySelector('.reasoning-label').textContent==='Medium'})()`));
  check('pill mark is 13px', await evalJS(`(()=>{const r=${q('.reasoning-mark')}.getBoundingClientRect();return Math.round(r.width)===13&&Math.round(r.height)===13})()`));
  check('picker starts hidden inside the composer', await evalJS(`${q('#picker')}.hidden && ${q('#picker')}.parentElement.classList.contains('composer') && ${q('#picker')}.classList.contains('glass')`));

  // ---- geometry and open state
  const before = { bar: await rect('#bar, .bar'), stack: await rect('.stack'), input: await rect('#prompt-input') };
  await pill();
  await sleep(250);
  check('popover opens as a dialog', await evalJS(`(()=>{const p=${q('#picker')};return !p.hidden&&p.getAttribute('role')==='dialog'&&p.getAttribute('aria-label')==='Model and provider'&&${q('#btn-reasoning')}.getAttribute('aria-expanded')==='true'})()`));
  check('popover is 244 wide, radius 16, above the bar, right edges aligned', await evalJS(`(()=>{const p=${q('#picker')}.getBoundingClientRect(),b=${q('#btn-reasoning')}.getBoundingClientRect(),bar=${q('.bar')}.getBoundingClientRect();const cs=getComputedStyle(${q('#picker')});return Math.round(p.width)===244&&cs.borderTopLeftRadius==='16px'&&cs.paddingTop==='8px'&&p.bottom<=bar.top&&Math.abs(p.right-b.right)<=1.5})()`), await evalJS(`JSON.stringify([${q('#picker')}.getBoundingClientRect(),${q('#btn-reasoning')}.getBoundingClientRect()])`));
  check('opening never moves the bar, stack or prompt', before.bar === await rect('#bar, .bar') && before.stack === await rect('.stack') && before.input === await rect('#prompt-input'));
  check('focus lands on the selected provider segment', (await focusKey()) === 'provider:chatgpt');
  check('provider and mode radiogroups', await evalJS(`(()=>{const g=n=>${q('#picker')}.querySelector('[role=radiogroup][aria-label="'+n+'"]');const p=g('Provider'),m=g('Mode');return [...p.querySelectorAll('[role=radio]')].map(b=>b.textContent.trim()).join()==='ChatGPT,Gemini'&&[...m.querySelectorAll('[role=radio]')].map(b=>b.textContent.trim()).join()==='Chat,Work'&&p.querySelectorAll('svg').length===2})()`));
  check('first two rows have no headings above them', await evalJS(`(()=>{const k=[...${q('#picker')}.children];return k[0].getAttribute('aria-label')==='Provider'&&k[1].getAttribute('aria-label')==='Mode'})()`));
  check('ChatGPT Chat shows an Effort row with Low, Medium, High', await evalJS(`(()=>{const r=${q('#picker .picker-effort')};return !!r&&r.querySelector('.picker-effort-label').textContent==='Effort'&&[...r.querySelectorAll('[role=radio]')].map(b=>b.textContent).join()==='Low,Medium,High'&&r.querySelector('[aria-checked=true]').textContent==='Medium'})()`));
  check('model rows follow the divider', await evalJS(`!!${q('#picker .feature-divider')}`) && (await rows()).join() === 'Mock model,Mock alternate', (await rows()).join());
  check('selected model carries an accent check', await evalJS(`(()=>{const r=${q('#picker .picker-row[aria-selected=true]')};const c=r.querySelector('.picker-check');const v=getComputedStyle(c);return v.visibility==='visible'&&v.color===getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim()||v.visibility==='visible'})()`));
  check('rows are 30px', await evalJS(`Math.round(${q('#picker .picker-row')}.getBoundingClientRect().height)===30`));
  check('no Switch to rows and the old list stays hidden', await evalJS(`!${q('#picker')}.textContent.includes('Switch to')&&${q('.feature-list')}.hidden`));
  check('each radiogroup has one tab stop', await evalJS(`[...document.querySelectorAll('#picker [role=radiogroup]')].every(g=>g.querySelectorAll('[tabindex="0"]').length===1)`));
  check('animation is on with motion on', await evalJS(`getComputedStyle(${q('#picker')}).animationName==='picker-in'`));
  await shot('picker-chatgpt-chat-dark.png');

  // ---- effort
  await evalJS(`${q('#picker [data-picker-key="effort:high"]')}.click()`);
  await sleep(80);
  check('Effort High sets the pill and stays open', await evalJS(`${q('.reasoning-label')}.textContent==='High'&&!${q('#picker')}.hidden&&${q('#picker [data-picker-key="effort:high"]')}.getAttribute('aria-checked')==='true'`));
  await evalJS(`${q('#picker [data-picker-key="effort:low"]')}.click()`);
  await sleep(60);
  check('Effort Low', await evalJS(`${q('.reasoning-label')}.textContent==='Low'&&${q('#btn-reasoning')}.getAttribute('aria-label')==='ChatGPT, Low. Change model'`));
  await evalJS(`${q('#picker [data-picker-key="effort:medium"]')}.click()`);

  // ---- model row
  await evalJS(`__mock.calls=[]`);
  await evalJS(`${q('#picker .picker-row:not([aria-selected=true])')}.click()`);
  await sleep(120);
  check('picking a model row calls chat_model_choose and closes', await evalJS(`__mock.last('chat_model_choose')?.args.id==='1'`) && !(await pickerOpen()));
  check('closing returns focus-safe state', await evalJS(`${q('#btn-reasoning')}.getAttribute('aria-expanded')==='false'`));

  // ---- toggling and dismissal
  await pill(); await sleep(60);
  await pill(); await sleep(60);
  check('pill toggles the popover shut', !(await pickerOpen()));
  await pill(); await sleep(60);
  await press2('Escape');
  check('Escape closes and returns focus to the pill', !(await pickerOpen()) && (await focusKey()) === 'btn-reasoning');
  await pill(); await sleep(60);
  await evalJS(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  check('outside click closes', !(await pickerOpen()));
  await type('/'); await sleep(80);
  check('slash menu is open', await evalJS(`!${q('#slash-menu')}.hidden`));
  await pill(); await sleep(60);
  check('opening the picker closes the slash menu', await pickerOpen() && await evalJS(`${q('#slash-menu')}.hidden`));
  await press2('Escape');
  await evalJS(`document.getElementById('prompt-input').focus()`); await type('/model'); await sleep(80); await key('Enter'); await sleep(150);
  check('/model opens the picker', await pickerOpen() && await evalJS(`${q('.feature-list')}.hidden`));
  await press2('Escape');
  await type('');
  await evalJS(`document.getElementById('prompt-input').focus()`); await type('/keys'); await sleep(80); await key('Enter'); await sleep(200);
  check('other feature lists are unchanged and close the picker', !(await pickerOpen()) && await evalJS(`!${q('.feature-list')}.hidden`));
  await key('Escape'); await sleep(250);
  await open0();

  // ---- keyboard in the radiogroups
  await pill(); await sleep(100);
  await press2('ArrowRight'); await sleep(250);
  check('ArrowRight selects Gemini within the provider group', await evalJS(`__mock.provider`) === 'gemini' && (await focusKey()) === 'provider:gemini' && await pickerOpen());
  await press2('ArrowLeft'); await sleep(250);
  check('ArrowLeft returns to ChatGPT', await evalJS(`__mock.provider`) === 'chatgpt' && (await focusKey()) === 'provider:chatgpt');
  await press2('Tab');
  check('Tab moves to the mode group', (await focusKey()) === 'mode:chat');
  await press2('Tab');
  check('Tab moves on to the effort group', (await focusKey()) === 'effort:medium');
  await press2('ArrowRight'); await sleep(60);
  check('arrow selects effort', await evalJS(`${q('.reasoning-label')}.textContent==='High'`));
  await press2('ArrowLeft'); await sleep(40);
  await press2('Tab');
  check('Tab then reaches the selected model row', (await focusKey()) === 'model:0');
  await press2('ArrowDown');
  check('ArrowDown moves between rows', (await focusKey()) === 'model:1');
  await evalJS(`__mock.calls=[]`);
  await press2('Enter'); await sleep(120);
  check('Enter selects a row', await evalJS(`__mock.last('chat_model_choose')?.args.id==='1'`));
  await pill(); await sleep(80);
  await press2('Tab'); await press2('Tab'); await press2('Tab');
  await evalJS(`__mock.calls=[]`);
  await press2(' '); await sleep(120);
  check('Space selects a row', await evalJS(`__mock.count('chat_model_choose')===1`));
  await open0();

  // ---- provider switching keeps draft and popover
  await type('keep my draft');
  await pill(); await sleep(100);
  await click('#picker [data-picker-key="provider:gemini"]');
  await waitFor(`__mock.provider==='gemini'`); await sleep(300);
  check('provider switch keeps the draft', await evalJS(`document.getElementById('prompt-input').value==='keep my draft'`));
  check('provider switch keeps the popover open on Gemini', await pickerOpen() && await evalJS(`${q('#picker [data-picker-key="provider:gemini"]')}.getAttribute('aria-checked')==='true'`));
  check('Gemini shows no Effort row but its models', await evalJS(`!${q('#picker .picker-effort')}`) && (await rows()).join() === 'Flash-Lite,Pro,Thinking', (await rows()).join());
  check('Gemini pill shows the model', await evalJS(`${q('.reasoning-label')}.textContent==='Flash-Lite'&&${q('#btn-reasoning')}.getAttribute('aria-label')==='Gemini, Flash-Lite. Change model'`));
  check('a disabled Gemini model is not selectable', await evalJS(`[...document.querySelectorAll('#picker .picker-row')].find(n=>n.textContent.includes('Pro')).disabled`));
  check('Gemini work label is Task', await evalJS(`${q('#picker [data-picker-key="mode:work"]')}.textContent.trim()==='Task'`));
  await shot('picker-gemini-chat-dark.png');
  await evalJS(`__mock.calls=[]`);
  await click('#picker [data-picker-key="model:thinking"]');
  await sleep(150);
  check('Gemini model pick calls chat_model_choose', await evalJS(`__mock.last('chat_model_choose')?.args.id==='thinking'`));
  // Gemini reasoning rows and the failure copy
  await open0('/?mock=signedin');
  await evalJS(`__mock.levels=[{id:'std',label:'Standard',selected:true,meta:'Balanced'},{id:'ext',label:'Extended',meta:'Slower'}]`);
  await pill(); await sleep(80);
  await click('#picker [data-picker-key="provider:gemini"]');
  await waitFor(`__mock.provider==='gemini'`); await sleep(350);
  check('Gemini reasoning rows appear below the models', await evalJS(`[...document.querySelectorAll('#picker .picker-heading')].some(n=>n.textContent==='Reasoning')&&!!${q('#picker [data-picker-key="level:ext"]')}`));
  await evalJS(`__mock.calls=[]`);
  await click('#picker [data-picker-key="level:ext"]'); await sleep(120);
  check('a Gemini reasoning row calls chat_model_choose', await evalJS(`__mock.last('chat_model_choose')?.args.id==='ext'`));
  await open0('/?mock=silent-models');
  await evalJS(`__mock.silentModels=true`);
  await pill(); await sleep(100);
  await click('#picker [data-picker-key="provider:gemini"]');
  await waitFor(`__mock.provider==='gemini'`); await sleep(250);
  check('quiet loading row while models are read', await evalJS(`${q('#picker .picker-empty')}?.textContent==='Loading models…'`));
  await evalJS(`__mock.emit('bridge',{type:'models',provider:'gemini',error:'unavailable'})`);
  await sleep(100);
  check('failure reads Couldn’t read the model list', await evalJS(`${q('#picker .picker-empty')}?.textContent==='Couldn’t read the model list' || ${q('#picker .picker-empty')}?.textContent==="Couldn't read the model list"`));

  // Mode-specific cache and asynchronous loading, using distinct real-page model labels.
  await open0();
  await evalJS(`__mock.silentModels=true`);
  await pill(); await sleep(100);
  await evalJS(`__mock.emit('bridge',{type:'models',models:[{id:'chat-only',label:'GPT-6',selected:true}]})`);
  await sleep(80);
  check('Chat has segmented effort and no stepper', await evalJS(`!!${q('#picker .picker-effort-seg')}&&!${q('#picker .picker-effort-step')}`));
  await press2('Escape');
  await evalJS(`__mock.calls=[]`);
  await pill(); await sleep(100);
  check('ChatGPT same-mode reopen uses cache', await evalJS(`__mock.count('chat_models')===0`) && (await rows()).join()==='GPT-6');
  await click('#picker [data-picker-key="mode:work"]'); await sleep(500);
  check('open mode switch requests Work models', await evalJS(`__mock.last('chat_models')?.args.mode==='work'`));
  check('Chat list never renders while Work loads', (await rows()).length===0);
  await evalJS(`__mock.models.chatgpt=[{id:'work-only',label:'GPT-6.1 Sol',selected:true}]; __mock.effortStops={labels:['Minimal','Light','Medium','High','Extra High'],index:1}; __mock.emit('bridge',{type:'models',models:__mock.models.chatgpt,effort:{label:'Light',index:1,count:5}})`);
  await sleep(80);
  check('Work renders its own list', (await rows()).join()==='GPT-6.1 Sol');
  for (const [direction, label] of [['up','Medium'],['down','Light'],['down','Minimal'],['up','Light'],['up','Medium'],['up','High'],['up','Extra High']]) {
    await evalJS(`__mock.calls=[]`);
    await click(`#picker [data-picker-key="effort-step:${direction}"]`); await sleep(80);
    check(`step ${direction} updates to ${label}`, await evalJS(`__mock.count('chat_model_choose')===1&&__mock.last('chat_model_choose').args.id==='__effort:${direction}'&&${q('#picker .picker-effort-value')}?.textContent===${JSON.stringify(label)}`));
    if (label==='Minimal') check('down disabled at first stop', await evalJS(`${q('#picker [data-picker-key="effort-step:down"]')}.disabled`));
  }
  check('up disabled at last stop', await evalJS(`${q('#picker [data-picker-key="effort-step:up"]')}.disabled`));
  await press2('Escape'); await evalJS(`__mock.calls=[]`); await pill(); await sleep(100);
  check('Work same-mode reopen uses cache', await evalJS(`__mock.count('chat_models')===0`) && (await rows()).join()==='GPT-6.1 Sol');
  await click('#picker [data-picker-key="mode:chat"]'); await sleep(500);
  check('open mode switch requests Chat models', await evalJS(`__mock.last('chat_models')?.args.mode==='chat'`));
  check('Work list never renders while Chat loads', (await rows()).length===0);
  await open0(); await pill(); await sleep(100);
  await click('#picker [data-picker-key="provider:gemini"]'); await sleep(400);
  await click('#picker [data-picker-key="mode:work"]'); await sleep(500);
  check('Gemini Task has no effort stepper', await evalJS(`!${q('#picker .picker-effort-step')}`) && (await chatState()).mode==='work');

  // ---- modes
  await open0();
  await type('draft before mode');
  await evalJS(`__mock.calls=[]`);
  await pill(); await sleep(100);
  check('opening asks for the modes', await evalJS(`__mock.count('chat_modes')>=1`));
  const newChats = await evalJS(`__mock.count('chat_new')`);
  await click('#picker [data-picker-key="mode:work"]');
  await sleep(500);
  check('picking Work calls chat_mode_set', await evalJS(`__mock.last('chat_mode_set')?.args.mode==='work'`));
  check('Work starts a new chat and keeps the draft', await evalJS(`document.getElementById('prompt-input').value==='draft before mode'`) && (await chatState()).mode === 'work');
  check('Work pill shows the mode label', await evalJS(`${q('.reasoning-label')}.textContent==='Work'&&${q('#btn-reasoning')}.getAttribute('aria-label')==='ChatGPT, Work. Change model'`));
  check('Work replaces segmented effort with Light stepper', await evalJS(`!${q('#picker .picker-effort-seg')}&&!!${q('#picker .picker-effort-step')}&&${q('#picker .picker-effort-value')}?.textContent==='Light'`));
  check('Work keeps both model rows', (await rows()).length === 2, JSON.stringify(await rows()));
  await shot('picker-chatgpt-work-dark.png');
  await press2('Escape');
  await evalJS(`__mock.calls=[]`);
  await say('work please');
  await waitFor(`__mock.count('chat_send')>=1`);
  const sent = await evalJS(`__mock.last('chat_send').args`);
  check('chat_send carries mode work and null reasoningEffort', sent.mode === 'work' && sent.reasoningEffort === null && 'reasoningEffort' in sent, JSON.stringify(sent));
  await waitFor(`!document.querySelector('[data-status=streaming]')`);
  await sleep(300);
  await open0('/?mock=signedin', { keep: true });
  check('the mode is saved per chat across a reload', (await chatState()).mode === 'work' && await evalJS(`${q('.reasoning-label')}.textContent==='Work'`));
  await pill(); await sleep(100);
  await click('#picker [data-picker-key="mode:chat"]'); await sleep(500);
  check('back to Chat restores the effort pill', await evalJS(`${q('.reasoning-label')}.textContent==='Medium'`) && (await chatState()).mode === 'chat');
  await press2('Escape');
  await evalJS(`__mock.calls=[]`);
  await say('chat please');
  await waitFor(`__mock.count('chat_send')>=1`);
  const sentChat = await evalJS(`__mock.last('chat_send').args`);
  check('chat_send in Chat carries mode chat and the effort', sentChat.mode === 'chat' && sentChat.reasoningEffort === 'medium', JSON.stringify(sentChat));
  await waitFor(`!document.querySelector('[data-status=streaming]')`);
  await sleep(300);

  // ---- a recent tab restores its own mode
  const now = Date.now();
  await open0('/?mock=signedin', { chats: { v: 1, current: { key: 'cur', provider: 'chatgpt', title: 'Now', mode: 'chat' }, recent: [{ key: 'w', provider: 'chatgpt', title: 'Worky', mode: 'work', lastPrompt: 'hi', lastResponse: 'yo', lastActive: now }] } });
  check('stored mode survives validation, junk is dropped', await evalJS(`${q('.reasoning-label')}.textContent==='Medium'`));
  await evalJS(`document.querySelector('.tab').click()`);
  await sleep(500);
  check('switching to a Work tab sets the pill from that chat', await evalJS(`${q('.reasoning-label')}.textContent==='Work'`));

  // ---- unavailable and temporary
  await open0();
  await evalJS(`__mock.modeUnavailable=true`);
  await pill(); await sleep(150);
  check('unavailable Work is aria-disabled and dimmed with a title', await evalJS(`(()=>{const w=${q('#picker [data-picker-key="mode:work"]')};return w.getAttribute('aria-disabled')==='true'&&w.title==='Not available on this account yet'&&Number(getComputedStyle(w).opacity)<.6})()`));
  await evalJS(`__mock.calls=[]`);
  await click('#picker [data-picker-key="mode:work"]'); await sleep(150);
  check('clicking disabled Work does nothing', await evalJS(`__mock.count('chat_mode_set')===0`) && (await chatState()).mode !== 'work');
  await shot('picker-work-unavailable-dark.png');
  await open0();
  await pill(); await sleep(150);
  await evalJS(`__mock.modeUnavailable=true`);
  await evalJS(`__mock.modes.chatgpt.available=true`);
  await click('#picker [data-picker-key="mode:work"]'); await sleep(400);
  check('mode_unavailable reverts to Chat and shows the message', (await chatState()).mode !== 'work' && await evalJS(`!${q('#global-error')}.hidden&&${q('#global-error-text')}.textContent.includes("isn't available")&&${q('#picker [data-picker-key="mode:chat"]')}.getAttribute('aria-checked')==='true'`));
  await open0();
  await evalJS(`document.getElementById('prompt-input').focus()`); await type('/temp'); await sleep(80); await key('Enter'); await sleep(600);
  await pill(); await sleep(150);
  check('temporary chats are always Chat and disable Work', await evalJS(`(()=>{const w=${q('#picker [data-picker-key="mode:work"]')};return w.getAttribute('aria-disabled')==='true'&&w.title==='Not in temporary chats'&&${q('#picker [data-picker-key="mode:chat"]')}.getAttribute('aria-checked')==='true'})()`));

  // ---- busy, sending, folding
  await open0();
  await evalJS(`__mock.hold=true`);
  await say('hold this');
  await sleep(200);
  check('pill is disabled while a reply is in flight', await evalJS(`${q('#btn-reasoning')}.disabled`));
  await evalJS(`__mock.release&&__mock.release()`);
  await waitFor(`!document.querySelector('[data-status=streaming]')`);
  await sleep(300);
  await pill(); await sleep(80);
  await say('close on send'); await sleep(150);
  check('sending closes the popover', !(await pickerOpen()));
  await waitFor(`!document.querySelector('[data-status=streaming]')`);
  await sleep(300);
  await pill(); await sleep(80);
  await evalJS(`document.getElementById('btn-reasoning')`);
  await evalJS(`(async()=>{})()`);

  // ---- motion off, narrow bar, densities, looks
  await open0('/?mock=signedin', { settings: { animations: 'off' } });
  await pill(); await sleep(100);
  check('no enter animation with motion off', await evalJS(`getComputedStyle(${q('#picker')}).animationName==='none'`));
  await open0('/?mock=signedin', { settings: { barWidth: 340 } });
  await pill(); await sleep(250);
  check('narrow bar: popover never wider than the bar and the prompt keeps room', await evalJS(`(()=>{const p=${q('#picker')}.getBoundingClientRect(),b=${q('.bar')}.getBoundingClientRect(),i=${q('#prompt-input')}.getBoundingClientRect();return p.width<=b.width+.5&&p.left>=b.left-.5&&i.width>=90})()`));
  await shot('picker-narrow-dark.png');
  await open0('/?mock=signedin', { settings: { barWidth: 340 } });
  await evalJS(`__mock.hold=true`);
  await say('x'); await sleep(200);
  check('narrow bar still fits the minimize button, pill and prompt', await evalJS(`(()=>{const bar=${q('.bar')}.getBoundingClientRect();const ids=['btn-reasoning','btn-minimize','btn-attach','btn-send'];return ids.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.width>0&&r.right<=bar.right+.5&&r.left>=bar.left-.5})&&${q('#prompt-input')}.getBoundingClientRect().width>=60})()`));
  await evalJS(`__mock.release&&__mock.release()`);
  for (const density of ['compact', 'roomy']) {
    await open0('/?mock=signedin', { settings: { density } });
    await pill(); await sleep(250);
    check(`${density}: popover sits above the bar and inside the window`, await evalJS(`(()=>{const p=${q('#picker')}.getBoundingClientRect(),b=${q('.bar')}.getBoundingClientRect();return p.bottom<=b.top&&p.top>=0&&p.right<=innerWidth&&Math.abs(p.right-${q('#btn-reasoning')}.getBoundingClientRect().right)<=1.5})()`));
    await shot(`picker-chatgpt-${density}.png`);
  }
  await open0('/?mock=signedin', { settings: { look: 'paper' } });
  await pill(); await sleep(250);
  await shot('picker-chatgpt-chat-light.png');
  await click('#picker [data-picker-key="provider:gemini"]'); await sleep(400);
  await shot('picker-gemini-chat-light.png');
  await evalJS(`__mock.modes.gemini.available=true`);
  await click('#picker [data-picker-key="mode:work"]'); await sleep(500);
  await shot('picker-gemini-work-light.png');
  // A late failure for a pick that is no longer current stays silent.
  await open0();
  await evalJS(`__mock.emit('bridge',{type:'error',provider:'chatgpt',code:'mode_unavailable',mode:'work',message:'LATE'})`); await sleep(80);
  check('a late mode failure for an earlier pick is ignored', await evalJS(`${q('#global-error')}.hidden`));
  await evalJS(`__mock.emit('bridge',{type:'error',provider:'chatgpt',code:'mode_unavailable',mode:'chat',message:'CURRENT'})`); await sleep(80);
  check('a mode failure for the current mode still shows', await evalJS(`!${q('#global-error')}.hidden`));
  // Real pointer input: opening by mouse shows no focus ring, and a picked segment takes focus.
  const mouse = async (sel) => {
    const at = await evalJS(`(()=>{const b=${q(sel)}.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  await open0();
  await mouse('#btn-reasoning'); await sleep(250);
  check('opening by mouse focuses the selected provider without a focus ring', await pickerOpen() && await evalJS(`document.activeElement.dataset.pickerKey==='provider:chatgpt' && !document.activeElement.matches(':focus-visible')`));
  await mouse('#picker [data-picker-key="provider:gemini"]'); await sleep(400);
  check('a mouse pick keeps the popover open with focus on the picked provider', await pickerOpen() && await evalJS(`document.activeElement.dataset.pickerKey==='provider:gemini' && !document.activeElement.matches(':focus-visible')`));
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
