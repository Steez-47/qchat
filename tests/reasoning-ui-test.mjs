// Reasoning effort composer and settings checks in an isolated, invisible Edge
// profile. Mock backend only: no account, site access or OS-level input.
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
  browserPage = await openPage('reasoning-ui', { problems });
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
  const send = async (text) => { await evalJS(`document.getElementById('prompt-input').focus()`); await type(text); await key('Enter'); };
  const label = () => evalJS(`document.getElementById('btn-reasoning').querySelector('.reasoning-label').textContent`);
  const aria = () => evalJS(`document.getElementById('btn-reasoning').getAttribute('aria-label')`);
  const openPicker = () => evalJS(`document.getElementById('btn-reasoning').click()`);
  const press = (id) => evalJS(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));n.click();})()`);
  // The effort row of the compact picker. A pick leaves the popover open; the helper closes it so each step starts shut.
  const pick = (title) => evalJS(`(()=>{[...document.querySelectorAll('#picker .picker-effort-seg button')].find(n=>n.textContent===${JSON.stringify(title)}).click();if(!document.getElementById('picker').hidden)document.getElementById('btn-reasoning').click();})()`);
  const lastSend = (keyName) => evalJS(`__mock.last('chat_send')?.args?.${keyName}`) ;
  const waitDone = () => waitFor(`(()=>{const rows=[...document.querySelectorAll('.turn-row[data-role=assistant]')];return rows.length>0&&rows.at(-1).dataset.status==='done'&&document.getElementById('btn-send').dataset.mode==='send';})()`, 8000);
  const setSettings = (patch) => evalJS(`__mock.emit('qchat://settings-changed', {...QSettings.settings, ...${JSON.stringify(patch)}})`);
  const MIN = 60 * 1000;
  const chatSeed = (key, { conv = null, effort, prompt = `prompt ${key}`, reply = `reply ${key}`, ago = MIN } = {}) => ({
    key,
    conversationId: conv,
    title: key,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft: '',
    transcript: [
      { id: `${key}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${key}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago,
    ...(effort ? { reasoningEffort: effort } : {})
  });
  const baseSettings = { animations: 'off', autoDismiss: 0 };

  await open('/', { settings: baseSettings });
  check('a new chat starts at Medium in the compact composer picker',
    (await label()) === 'Medium' && (await aria()) === 'ChatGPT, Medium. Change model' &&
    (await evalJS(`document.getElementById('btn-reasoning').dataset.value`)) === 'medium' &&
    (await evalJS(`!document.getElementById('btn-reasoning').hidden`)),
    `${await label()} / ${await aria()}`);

  await openPicker();
  check('the picker lists Low, Medium and High with one selected check',
    await evalJS(`(()=>{const rows=[...document.querySelectorAll('#picker .picker-effort-seg button')];const checks=rows.filter(r=>r.getAttribute('aria-checked')==='true');return rows.map(r=>r.textContent).join(',')==='Low,Medium,High'&&checks.length===1&&checks[0].textContent==='Medium'&&document.querySelector('.feature-list').hidden;})()`));
  await pick('Low');
  check('picking Low stores an explicit per-chat override',
    (await label()) === 'Low' &&
    (await evalJS(`JSON.parse(localStorage.getItem('qchat.chats')).current.reasoningEffort`)) === 'low');
  await send('low effort');
  await waitFor(`__mock.count('chat_send')>0`);
  check('Low is snapshotted into chat_send', (await lastSend('reasoningEffort')) === 'low');
  await waitDone();

  await openPicker();
  check('the picker marks the chat override as selected', await evalJS(`(()=>{const on=[...document.querySelectorAll('#picker .picker-effort-seg button')].filter(r=>r.getAttribute('aria-checked')==='true');return on.length===1&&on[0].textContent==='Low';})()`));
  await pick('High');
  await send('high effort');
  await waitFor(`__mock.count('chat_send')>1`);
  check('High is snapshotted into chat_send', (await lastSend('reasoningEffort')) === 'high');
  await waitDone();

  // Saved default: the Settings row persists it, and the chat window applies it live.
  await open('/settings.html', { settings: baseSettings });
  check('Behaviour has a Default reasoning row',
    await evalJS(`(()=>{const row=document.querySelector('[data-key="defaultReasoning"]');return !!row&&row.closest('#section-general')!==null&&[...row.querySelectorAll('.segmented button')].map(b=>b.textContent).join(',')==='Low,Medium,High';})()`));
  await evalJS(`document.querySelector('[data-key="defaultReasoning"] button[data-value="low"]').click()`);
  check('the saved default persists as Low',
    (await evalJS(`JSON.parse(localStorage.getItem('qchat.settings')).defaultReasoning`)) === 'low' &&
    (await evalJS(`document.querySelector('[data-key="defaultReasoning"] button[data-value="low"]').getAttribute('aria-checked')`)) === 'true');
  await open('/', { keep: true });
  check('an unoverridden chat loads with the saved default', (await label()) === 'Low' && (await aria()) === 'ChatGPT, Low. Change model');
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('a live default change updates the unoverridden current chat', (await label()) === 'High' && (await aria()) === 'ChatGPT, High. Change model');

  await openPicker();
  await pick('Low');
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('an explicit override wins over a later default change', (await label()) === 'Low');
  await send('/new');
  await sleep(40);
  check('a new chat starts from the saved default again',
    (await label()) === 'High' &&
    (await evalJS(`!('reasoningEffort' in JSON.parse(localStorage.getItem('qchat.chats')).current)`)));

  // Stored overrides load, sanitize and travel with their chat.
  await open('/', {
    settings: { ...baseSettings, defaultReasoning: 'medium' },
    chats: { v: 1, current: chatSeed('cur', { effort: 'low' }), recent: [chatSeed('a', { conv: 'conv-a', effort: 'high' }), chatSeed('b')] }
  });
  check('a stored override loads with its chat', (await label()) === 'Low');
  await evalJS(`document.querySelector('#tabs .tab[data-key="a"]').click()`);
  await sleep(40);
  check('switching chats shows that chat\'s override', (await label()) === 'High');
  await evalJS(`document.querySelector('#tabs .tab[data-key="b"]').click()`);
  await sleep(40);
  check('a chat without an override follows the saved default', (await label()) === 'Medium');

  await open('/', {
    settings: { ...baseSettings, defaultReasoning: 'medium' },
    chats: { v: 1, current: chatSeed('cur', { effort: 'ultra' }), recent: [] }
  });
  check('an old or invalid override is sanitized away',
    (await label()) === 'Medium' &&
    (await evalJS(`!('reasoningEffort' in JSON.parse(localStorage.getItem('qchat.chats')).current)`)));

  // Busy guard: picker disabled, display frozen and the send keeps its snapshot.
  await open('/', { settings: { ...baseSettings, defaultReasoning: 'medium' } });
  await evalJS(`__mock.hold=true; __mock.interval=5; true`);
  await send('hold this send');
  await waitFor(`__mock.count('chat_send')>0 && !!__mock.release`);
  check('the picker is disabled while a send is active',
    await evalJS(`document.getElementById('btn-reasoning').disabled`));
  await openPicker();
  check('a disabled picker cannot open while sending',
    await evalJS(`document.getElementById('picker').hidden`));
  await setSettings({ defaultReasoning: 'high' });
  await sleep(40);
  check('the composer keeps the effort that was sent, not a midstream default',
    (await label()) === 'Medium' && (await lastSend('reasoningEffort')) === 'medium');
  await evalJS(`__mock.release()`);
  await waitDone();
  check('after the reply the picker returns to the saved default',
    !(await evalJS(`document.getElementById('btn-reasoning').disabled`)) && (await label()) === 'High');

  // Keyboard path through the same popup: arrows, Enter and Escape.
  await openPicker();
  check('opening the picker focuses the selected provider segment', await evalJS(`document.activeElement.dataset.pickerKey==='provider:chatgpt'`));
  await evalJS(`document.querySelector('#picker .picker-effort-seg [aria-checked=true]').focus()`);
  await key('ArrowLeft');
  await sleep(30);
  check('arrow keys choose an effort without a pointer', (await label()) === 'Medium' && await evalJS(`!document.getElementById('picker').hidden`));
  await key('Escape');
  await sleep(30);
  check('Escape closes the picker, keeps the value and returns focus to the pill',
    await evalJS(`document.getElementById('picker').hidden && document.activeElement===document.getElementById('btn-reasoning')`) && (await label()) === 'Medium');

  // Toggle and close animation: a second press on the reasoning button closes
  // the open picker, and a pointer away fades it out instead of hiding it.
  await open('/', { settings: { ...baseSettings, animations: 'on' } });
  await press('btn-reasoning');
  check('the reasoning button opens the picker', await evalJS(`!document.getElementById('picker').hidden`));
  await press('btn-reasoning');
  check('a pointer press on the open reasoning button closes the picker instead of reopening it',
    await waitFor(`document.getElementById('picker').hidden`, 1500));

  await openPicker();
  await evalJS(`document.getElementById('prompt-input').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  check('a pointer away closes the picker', await waitFor(`document.getElementById('picker').hidden`, 1500));

  check('appearance presets exclude and preserve the behavioural default', await evalJS(`(()=>{
    const before={...QSettings.DEFAULTS,defaultReasoning:'high'};
    const applied=QSettings.applyPreset(before,'reader');
    const saved=QSettings.savePreset('reasoning-check',{...QSettings.DEFAULTS,defaultReasoning:'low'});
    const exported=JSON.parse(QSettings.exportPreset(saved.id));
    const ok=!QSettings.APPEARANCE_KEYS.includes('defaultReasoning')&&applied.defaultReasoning==='high'&&applied.textSize===18&&!('defaultReasoning' in exported.values)&&!('defaultReasoning' in saved.values);
    QSettings.deletePreset(saved.id);
    return ok;
  })()`));

  await open('/', { settings: { ...baseSettings, barWidth: 340, defaultReasoning: 'medium' } });
  await sleep(80);
  const fit = await evalJS(`(()=>{
    const bar=document.getElementById('bar'), input=document.getElementById('prompt-input'), button=document.getElementById('btn-reasoning');
    const br=bar.getBoundingClientRect(), ir=input.getBoundingClientRect(), rr=button.getBoundingClientRect();
    const controls=['orb','prompt-input','btn-reasoning','btn-attach','btn-send'].map(id=>document.getElementById(id));
    return {
      barWidth: br.width,
      scrollWidth: bar.scrollWidth,
      clientWidth: bar.clientWidth,
      promptWidth: ir.width,
      buttonWidth: rr.width,
      inputRight: ir.right,
      buttonLeft: rr.left,
      buttonRight: rr.right,
      barRight: br.right,
      sameRow: controls.every(n=>{const r=n.getBoundingClientRect();return r.top>=br.top-1&&r.bottom<=br.bottom+1;}),
      label: button.querySelector('.reasoning-label').textContent
    };
  })()`);
  check('at 340px the picker stays compact and the prompt keeps real room',
    Math.abs(fit.barWidth - 340) <= 1 && fit.scrollWidth <= fit.clientWidth + 1 &&
    fit.promptWidth >= 150 && fit.buttonWidth >= 24 && fit.buttonWidth <= 64 &&
    fit.inputRight <= fit.buttonLeft + 0.5 && fit.buttonRight <= fit.barRight + 0.5 &&
    fit.sameRow && fit.label === 'Medium',
    JSON.stringify(fit));

  check('no runtime errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  const shots = path.join(root, '.tmp', 'reasoning');
  await mkdir(shots, { recursive: true });
  await writeFile(path.join(shots, 'composer-narrow.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await openPicker();
  await sleep(100);
  await writeFile(path.join(shots, 'picker-narrow.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
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
