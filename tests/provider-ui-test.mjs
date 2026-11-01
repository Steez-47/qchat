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
  browserPage = await openPage('provider-ui', { problems });
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
  const press = (id) => evalJS(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));n.click();})()`);
  // The compact picker: providers and efforts are segments, models are rows. Picking a provider
  // leaves the popover open, so the helper closes it again the way the old list closed.
  const pick = (name) => evalJS(`(async()=>{const want=${JSON.stringify(name.replace(/^Switch to /, ''))};const nodes=[...document.querySelectorAll('#picker .picker-seg-btn, #picker .picker-effort-seg button, #picker .picker-row')];const text=n=>n.querySelector('.picker-title')?.textContent??n.textContent.trim();const n=nodes.find(x=>text(x)===want)||nodes.find(x=>text(x).includes(want));n.click();if(n.classList.contains('picker-seg-btn')&&/ChatGPT|Gemini/.test(want)){await new Promise(r=>setTimeout(r,120));if(!document.getElementById('picker').hidden)document.getElementById('btn-reasoning').click();}})()`);
  const pickerText = () => evalJS(`document.getElementById('picker').textContent`);
  const provider = () => evalJS(`__mock.provider`);
  await open('/?mock=signedin');
  await send('first on chatgpt');
  await waitFor(`!document.querySelector('[data-status=streaming]') && document.querySelector('[data-role=assistant]')`);
  await sleep(300);
  await press('btn-reasoning'); await sleep(60); await pick('Gemini'); await sleep(200);
  await press('btn-reasoning'); await sleep(60); await pick('ChatGPT'); await sleep(200);
  const newBefore = await evalJS(`__mock.count('chat_new')`);
  await send('second on chatgpt');
  await waitFor(`__mock.count('chat_new')>${newBefore}`, 2000);
  check('returning to a provider never sends into the chat its page still holds', await evalJS(`__mock.count('chat_new')>${newBefore}`));
  await sleep(400);
  await open('/?mock=signedin');
  await press('btn-reasoning');
  check('provider picker opens', await evalJS(`!document.getElementById('picker').hidden && document.querySelector('.feature-list').hidden`));
  const shots = path.join(root,'dist','qa-picker'); await mkdir(shots,{recursive:true});
  await writeFile(path.join(shots,'composer-picker.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await press('btn-reasoning');
  check('toggle closes without reopening', await evalJS(`document.getElementById('picker').hidden`));
  await sleep(350);
  check('close finishes', await evalJS(`document.getElementById('picker').hidden && document.querySelector('.feature-list').hidden`));
  await type('keep my draft'); await press('btn-reasoning'); await pick('Gemini');
  await waitFor(`__mock.provider==='gemini'`); await sleep(100);
  check('switch keeps draft', await evalJS(`document.getElementById('prompt-input').value==='keep my draft'`));
  check('Gemini model label', await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite' && document.getElementById('btn-reasoning').getAttribute('aria-label')==='Gemini, Flash-Lite. Change model'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:true})`);
  check('a status without a model keeps the known Gemini model', await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite'`));
  const orb = await evalJS(`document.getElementById('status-dot').dataset.state`);
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'chatgpt',ready:false,loggedIn:false})`);
  check('other provider status leaves orb alone', orb===await evalJS(`document.getElementById('status-dot').dataset.state`));
  await evalJS(`__mock.interval=1`); await send('hello Gemini');
  await waitFor(`__mock.count('chat_send')>0`); await sleep(500);
  check('Gemini send carries provider without reasoning', await evalJS(`__mock.last('chat_send').args.provider==='gemini' && !('reasoningEffort' in __mock.last('chat_send').args)`));
  await evalJS(`__mock.emit('bridge',{type:'error',provider:'gemini',code:'offline'})`);
  check('Gemini error copy uses its provider',await evalJS(`document.getElementById('global-error').textContent.includes('Gemini') && !document.getElementById('global-error').textContent.includes('ChatGPT')`));
  check('Gemini response region uses its provider',await evalJS(`document.getElementById('bubble-zone').getAttribute('aria-label')==='Gemini response'`));
  check('Gemini reply labels', await evalJS(`!!document.querySelector('[aria-label="Gemini replied"]') && !document.querySelector('[aria-label="ChatGPT replied"]')`));
  await press('btn-reasoning'); await pick('ChatGPT'); await sleep(100);
  check('ChatGPT restores reasoning', !(await evalJS(`document.getElementById('btn-reasoning').hidden`)));
  await evalJS(`document.querySelector('.tab').click()`); await sleep(150);
  check('tab reopen switches provider', await provider()==='gemini');
  await evalJS(`__mock.failProvider=true`); await press('btn-reasoning'); await pick('ChatGPT'); await sleep(100);
  check('failed switch rolls back', await provider()==='gemini' && await evalJS(`document.getElementById('btn-reasoning').getAttribute('aria-label')==='Gemini, Flash-Lite. Change model'`));
  // Relaunch on Gemini before its page has drawn the mode switcher.
  const geminiNow = {v:1,current:{key:'gnow',provider:'gemini',title:'Gemini now'},recent:[]};
  await open('/?mock=signedin&nomodel',{chats:geminiNow,keep:true});
  await waitFor(`__mock.provider==='gemini'`); await sleep(150);
  check('relaunch names the last Gemini model instead of "Model"', await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite'`), await evalJS(`document.querySelector('.reasoning-label').textContent`));
  await open('/?mock=signedin&nomodel',{chats:geminiNow});
  await waitFor(`__mock.provider==='gemini'`); await sleep(150);
  check('a first launch with no model yet still reads "Model"', await evalJS(`document.querySelector('.reasoning-label').textContent==='Model'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:true,model:'Thinking'})`); await sleep(30);
  check('the model shows as soon as the page reports it', await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking' && localStorage.getItem('qchat.geminiModel')==='Thinking'`));
  await open('/?mock=signedin',{chats:{v:1,current:{key:'g1',provider:'gemini',conversationId:'abcdef0123456789',title:'Old Gemini',messages:[{role:'user',text:'hi'}]},recent:[]}});
  await open('/?mock=signedin&failProvider',{keep:true});
  await sleep(250);
  check('failed startup switch follows native', await evalJS(`document.querySelector('#btn-reasoning span').textContent==='Medium'`) && await evalJS(`/Using ChatGPT/.test(document.getElementById('global-error-text').textContent)`));
  await open('/',{settings:{v:5,defaultReasoning:'high'}});
  check('v5 migrates forward with defaults', await evalJS(`QSettings.VERSION>=6 && QSettings.settings.defaultProvider==='chatgpt' && QSettings.settings.showBarAtStartup===false && QSettings.settings.defaultReasoning==='high'`));
  check('normal launch shows main', await evalJS(`__mock.count('show_main')===1`));
  await open('/?autostart'); check('autostart stays quiet',await evalJS(`__mock.count('show_main')===0`));
  await open('/?autostart',{settings:{v:6,showBarAtStartup:true}}); check('startup preference shows main',await evalJS(`__mock.count('show_main')===1`));
  for (const name of ['chatgpt','gemini']) {
    await open('/',{settings:{v:6,barWidth:340,defaultProvider:name}});
    check(name+' narrow prompt fit',await evalJS(`document.getElementById('prompt-input').getBoundingClientRect().width>=150`));
  }
  await open('/settings.html');
  check('settings provider and startup rows',await evalJS(`!!document.querySelector('[data-key="defaultProvider"]') && !!document.querySelector('[data-key="showBarAtStartup"]') && !!document.getElementById('btn-signin-gemini') && document.body.textContent.includes('Open at startup')`));
  await evalJS(`document.getElementById('btn-signin-gemini').click()`);
  check('Gemini account sign in passes provider',await evalJS(`__mock.last('show_signin').args.provider==='gemini'`));
  await open('/?mock=signedin');
  await key('k', {ctrlKey:true});
  check('commands include other provider and startup', await evalJS(`document.getElementById('slash-menu').textContent.includes('gemini') && document.getElementById('slash-menu').textContent.includes('startup') && ![...document.querySelectorAll('.slash-name')].some(n=>n.textContent==='chatgpt')`));
  await type('/gem');
  check('typing filters command menu', await evalJS(`document.querySelectorAll('#slash-menu [role=option]').length===1`));
  await key('Escape'); await send('/model'); await sleep(100);
  check('model list exposes selection', await evalJS(`!!document.querySelector('#picker [role=listbox] [role=option][aria-selected=true]')`));
  await pick('Mock alternate'); await sleep(100);
  check('model chip selected', await evalJS(`document.getElementById('model-chip').textContent==='Mock alternate'`));
  await send('/gemini'); await sleep(150);
  check('provider switch clears model chip', await evalJS(`document.getElementById('model-chip').hidden`));
  await send('/clear');
  await key('ArrowRight');
  check('clear arrow moves to keep', await evalJS(`document.activeElement===document.getElementById('btn-clear-no')`));
  await evalJS(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  check('outside pointer dismisses clear', await evalJS(`document.getElementById('clear-confirm').hidden`));
  await open('/settings.html?mock=signedin');
  await evalJS(`(()=>{const b=document.querySelector('[role=radio]'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));})()`);
  check('settings arrow applies radio', await evalJS(`document.activeElement.getAttribute('aria-checked')==='true'`));
  await evalJS(`__mock.emit('bridge',{provider:'gemini',type:'error',code:'auth'})`); await sleep(30);
  check('Gemini auth updates account', await evalJS(`document.getElementById('gemini-account-status').textContent==='Signed out'`));
  await open('/?mock=silent-models');
  await send('/model'); await sleep(6200);
  check('silent model request times out without error text on ChatGPT', await evalJS(`!document.getElementById('picker').hidden && !document.getElementById('picker').textContent.includes("Couldn't read") && !document.getElementById('picker').textContent.includes('Loading')`));
  await press('btn-reasoning'); await sleep(60);
  await evalJS(`__mock.emit('bridge',{type:'models',models:[{id:'late',label:'Late'}]})`); await sleep(60);
  check('late models cannot reopen a closed picker', await evalJS(`document.getElementById('picker').hidden && document.querySelector('.feature-list').hidden`));
  await press('btn-reasoning'); await press('btn-reasoning'); await press('btn-reasoning'); await sleep(6200);
  check('model timeout cannot replace a newer picker', await evalJS(`!document.getElementById('picker').hidden && !document.getElementById('picker').textContent.includes("Couldn't read")`));
  await open('/?mock=signedin');
  check('one composer picker only',await evalJS(`!document.getElementById('btn-provider') && document.querySelectorAll('.reasoning-btn').length===1`));
  await press('btn-reasoning');
  check('ChatGPT panel contract',await evalJS(`[...document.querySelectorAll('#picker button')].map(n=>n.querySelector('.picker-title')?.textContent??n.textContent.trim()).join('|')==='ChatGPT|Gemini|Chat|Work|Low|Medium|High|Mock model|Mock alternate' && !document.getElementById('picker').textContent.includes('Switch to')`));
  await writeFile(path.join(shots,'chatgpt-panel.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await pick('Switch to Gemini'); await sleep(100);
  await press('btn-reasoning'); await sleep(250);
  check('Gemini disabled row is inert',await evalJS(`(()=>{const b=[...document.querySelectorAll('#picker .picker-row')].find(n=>n.textContent.includes('Pro')); const count=__mock.count('chat_model_choose'); b.click(); return b.disabled && __mock.count('chat_model_choose')===count;})()`));
  await evalJS(`document.querySelector('#picker .picker-row[aria-selected=true]').focus()`);
  await key('ArrowDown');
  check('keyboard skips disabled model',await evalJS(`document.activeElement.querySelector('.picker-title').textContent==='Thinking'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:false,model:'Flash-Lite'})`);
  await press('btn-reasoning'); await sleep(300); await send('/model');
  check('signed-out gated row says Sign in and offers it',await evalJS(`(()=>{const n=[...document.querySelectorAll('#picker .picker-row')].find(n=>n.textContent.includes('Pro'));if(!n||n.disabled||!n.textContent.includes('Sign in'))return false;const c=__mock.count('show_signin');n.click();return __mock.count('show_signin')===c+1})()`));
  check('no invented reasoning group',await evalJS(`![...document.querySelectorAll('.picker-heading')].some(n=>n.textContent==='Reasoning')`));
  await press('btn-reasoning'); await sleep(250);
  await writeFile(path.join(shots,'gemini-panel.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await pick('Thinking'); await sleep(30);
  check('model chosen short updates composer',await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking'`));
  await press('btn-reasoning'); await evalJS(`__mock.failModel=true`); await pick('Flash-Lite'); await sleep(30);
  check('failed choice preserves label',await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking' && document.getElementById('global-error').textContent.includes("Couldn't change the model")`));
  await evalJS(`__mock.failModel=false`);
  await press('btn-reasoning'); await evalJS(`__mock.modelHold=true`); await pick('Flash-Lite');
  check('Gemini pick shows at once while its page is still switching',await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite'`));
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'gemini',ready:true,loggedIn:false,model:'Thinking'})`); await sleep(30);
  check('status from before the switch cannot undo a pending pick',await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite'`));
  const listCount=await evalJS(`__mock.count('chat_models')`);
  await sleep(320); await press('btn-reasoning'); await sleep(30);
  check('reopening during a pick shows it selected',await evalJS(`[...document.querySelectorAll('#picker .picker-row')].find(n=>n.textContent.includes('Flash-Lite'))?.getAttribute('aria-selected')==='true'`));
  check('reopening during a pick leaves the page menu alone',await evalJS(`__mock.count('chat_models')`)===listCount, listCount+' vs '+await evalJS(`__mock.count('chat_models')+' '+document.getElementById('picker').textContent`));
  await press('btn-reasoning'); await sleep(320);
  await evalJS(`__mock.releaseModel(); __mock.modelHold=false`); await sleep(30);
  check('confirmed pick keeps its label',await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite'`));
  await press('btn-reasoning'); await sleep(30); await evalJS(`__mock.modelHold=true`); await pick('Thinking'); await sleep(30);
  check('second pick shows at once',await evalJS(`document.querySelector('.reasoning-label').textContent==='Thinking'`));
  await evalJS(`__mock.emit('bridge',{type:'error',provider:'gemini',code:'model_unavailable',message:'Could not switch Gemini model.'})`); await sleep(30);
  check('bridge refusal returns the label to the real model',await evalJS(`document.querySelector('.reasoning-label').textContent==='Flash-Lite' && !document.getElementById('global-error').hidden`));
  await evalJS(`__mock.releaseModel(); __mock.modelHold=false`); await sleep(30);
  await sleep(320); await press('btn-reasoning'); await sleep(30);
  await evalJS(`__mock.emit('bridge',{type:'models',provider:'gemini',models:[],error:'unavailable'})`); await sleep(30);
  check('failed refresh keeps the usable model list',await evalJS(`[...document.querySelectorAll('#picker .picker-row')].some(n=>n.textContent.includes('Flash-Lite')) && !document.getElementById('picker').textContent.includes("Couldn't read")`));
  await press('btn-reasoning'); await sleep(320);
  await evalJS(`__mock.levels=[{id:'effort',label:'Medium',selected:true}]`);
  await press('btn-reasoning');
  await sleep(250);
  check('optional reasoning group appears',await evalJS(`[...document.querySelectorAll('#picker .picker-heading')].some(n=>n.textContent==='Reasoning')`));
  await press('btn-reasoning'); await sleep(300);
  await evalJS(`__mock.models.gemini=[{id:'long',label:'An exceptionally long model name for narrow composer checks',selected:true}]`);
  await press('btn-reasoning'); await pick('An exceptionally'); await sleep(30);
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,barWidth:340})`); await sleep(100);
  check('long Gemini label keeps narrow prompt usable',await evalJS(`document.getElementById('prompt-input').getBoundingClientRect().width>=150 && document.querySelector('.reasoning-label').getBoundingClientRect().width<=96`),await evalJS(`JSON.stringify({prompt:document.getElementById('prompt-input').getBoundingClientRect().width,label:document.querySelector('.reasoning-label').getBoundingClientRect().width,bar:document.getElementById('btn-reasoning').parentElement.getBoundingClientRect().width})`));
  await press('btn-reasoning'); await press('btn-reasoning'); await sleep(300);
  await evalJS(`__mock.silentModels=true`);
  // A silent backend proves the cached list paints synchronously on reopening.
  await evalJS(`__mock.calls=[]`);
  await press('btn-reasoning');
  check('cached list opens immediately',await evalJS(`document.getElementById('picker').textContent.includes('An exceptionally')`));
  await open('/?mock=signedin',{chats:{v:1,current:{key:'current',provider:'chatgpt',title:'Current'},recent:[{key:'g',provider:'gemini',title:'Gemini chat',lastActive:Date.now()},{key:'c',provider:'chatgpt',title:'GPT chat',lastActive:Date.now()}]}});
  check('recent tabs use provider SVGs and All chats retains clock',await evalJS(`document.querySelectorAll('.tab svg[data-provider]').length===2 && !!document.querySelector('.tab svg[data-provider="gemini"]') && document.querySelector('.tab-all .icon').tagName!=='svg'`));
  await sleep(350);
  await writeFile(path.join(shots,'provider-tabs.png'),Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,showTabClock:false})`); await sleep(50);
  check('stored clock preference hides logos',await evalJS(`[...document.querySelectorAll('.tab svg')].every(n=>getComputedStyle(n).display==='none')`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
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
