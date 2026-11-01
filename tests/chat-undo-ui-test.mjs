// Chat-window UX regressions driven through the mock backend in an isolated,
// invisible Edge profile. No account, site access or OS-level input.
import { writeFile } from 'node:fs/promises';
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
  browserPage = await openPage('chat-undo', { problems });
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
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const inputValue = () => evalJS(`document.getElementById('prompt-input').value`);
  const MIN = 60 * 1000;
  const chatSeed = (key, { conv = null, prompt = `prompt ${key}`, reply = `reply ${key}`, ago = MIN, draft = "", transcript } = {}) => ({
    key,
    conversationId: conv,
    title: key,
    lastActive: Date.now() - ago,
    lastPrompt: prompt,
    lastResponse: reply,
    lastHasMedia: false,
    lastSources: [],
    draft,
    transcript: transcript || [
      { id: `${key}-u`, role: 'user', text: prompt, hasMedia: false, sources: [] },
      { id: `${key}-a`, role: 'assistant', text: reply, hasMedia: false, stopped: false, sources: [] }
    ],
    createdAt: Date.now() - ago
  });


  const settings = { animations: 'off', autoDismiss: 0, keepHistory: true, showTabs: true };
  const seed = () => ({v:1, current:chatSeed('current',{draft:'current draft'}), recent:[chatSeed('a',{draft:'draft a',ago:MIN}),chatSeed('b',{draft:'draft b',ago:2*MIN}),chatSeed('c',{ago:3*MIN})]});
  const state = () => evalJS(`JSON.parse(localStorage.getItem('qchat.chats'))`);
  const setup = async (data=seed(), opts=settings) => { await open('/?mock=signedin', {chats:data,settings:opts}); await sleep(150); };
  const list = async () => { await key('p',{ctrlKey:true}); await waitFor(`!document.querySelector('.feature-list').hidden`); };
  const remove = async (title) => { await evalJS(`(()=>{const row=[...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent===${JSON.stringify(title)}); if(!row)throw Error('missing row');row.querySelector('[aria-label="Remove chat"]').click()})()`); await sleep(50); };
  const undo = async () => { await evalJS(`document.querySelector('#command-feedback button').click()`); await sleep(100); };
  const clear = async () => { await key('k',{ctrlKey:true}); await evalJS(`document.querySelector('#slash-clear').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`); await waitFor(`!document.getElementById('clear-confirm').hidden`); await evalJS(`document.getElementById('btn-clear-yes').click()`); await sleep(80); };
  const visible = () => evalJS(`!document.getElementById('command-feedback').hidden`);
  const providerSeed=seed(); providerSeed.recent[1].provider='gemini'; await setup(providerSeed); await list(); await remove('b');
  check('remove offers accessible undo',await evalJS(`(()=>{const n=document.querySelector('#command-feedback'),b=n.querySelector('button');b.focus();return n.getAttribute('role')==='status'&&b.type==='button'&&document.activeElement===b&&n.textContent.includes('Chat removed')})()`));
  check('snapshot is not persisted',await evalJS(`!localStorage.getItem('qchat.chats').includes('draft b') && !Object.keys(localStorage).some(k=>/undo/i.test(k))`));
  await sleep(100);
  check('pill participates in fit and surfaces',await evalJS(`(()=>{const n=document.querySelector('#command-feedback'),r=n.getBoundingClientRect(),fit=__mock.fit, surfaces=__mock.last('surfaces_set')?.args?.rects||[];return !!fit&&fit.content>=document.querySelector('#stack').offsetHeight&&surfaces.some(s=>s.x<=r.left+1&&s.y<=r.top+1&&s.x+s.w>=r.right-1&&s.y+s.h>=r.bottom-1)})()`));
  await undo(); let s=await state();
  check('undo restores exact position and chat data',s.recent.map(x=>x.key).join(',')==='a,b,c' && s.recent[1].draft==='draft b' && s.recent[1].provider==='gemini' && s.recent[1].transcript[1].text==='reply b');
  check('tab reappears',await evalJS(`!!document.querySelector('#tabs [data-key="b"]')`));
  await remove('a'); await remove('c'); await undo(); s=await state();
  check('stack undo restores latest only',s.recent.map(x=>x.key).join(',')==='b,c' && await visible());
  await undo(); s=await state(); check('stack undo restores older position',s.recent.map(x=>x.key).join(',')==='a,b,c' && !await visible());
  await remove('b'); await sleep(6200); await evalJS(`document.querySelector('#prompt-input').focus()`); const expiredPrevented=await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});document.activeElement.dispatchEvent(e);return e.defaultPrevented})()`); check('expiry removes undo offer and shortcut',!await visible() && !expiredPrevented);
  await setup(); await clear(); await undo(); s=await state();
  check('clear undo restores current and recent',s.current.key==='current' && s.current.draft==='current draft' && s.recent.map(x=>x.key).join(',')==='a,b,c',JSON.stringify(s));
  check('clear undo restores bubble and composer',await evalJS(`document.getElementById('prompt-input').value==='current draft' && document.querySelector('#bubble-zone').textContent.includes('reply current')`));
  await setup(); await clear(); await evalJS(`__mock.reply='ok'`); await send('new message'); await waitFor(`document.querySelector('#btn-send').dataset.mode==='send'`); await undo(); s=await state();
  check('clear undo preserves new message',s.current.key!=='current' && s.current.lastPrompt==='new message' && s.recent.some(x=>x.key==='current'),JSON.stringify(s));
  await setup(); await clear(); await evalJS(`__mock.hold=true`); await send('streaming'); await sleep(150); await undo(); s=await state();
  check('busy clear undo leaves active chat',s.current.key!=='current' && s.current.lastPrompt==='streaming' && s.recent.map(x=>x.key).join(',')==='a,b,c');
  const dupe = seed(); dupe.recent[1].conversationId = 'conv-b'; await setup(dupe); await list(); await remove('b');
  await evalJS(`__mock.emit('bridge',{type:'conversations',items:[{id:'conv-b',title:'account b',updated:Date.now()}],total:1})`);
  await evalJS(`([...document.querySelectorAll('.feature-row')].find(r=>r.querySelector('.feature-title')?.textContent==='account b')).querySelector('.feature-choice').click()`); await sleep(150);
  await key('n',{ctrlKey:true}); await sleep(150); await undo(); s=await state();
  check('reopened account chat wins over snapshot',s.recent.filter(x=>x.conversationId==='conv-b').length===1 && s.recent.find(x=>x.conversationId==='conv-b').title==='account b');
  await setup(); await list(); await remove('b'); await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,keepHistory:false})`); await sleep(80); await undo();
  check('history off skips restore and explains',await evalJS(`document.querySelector('#command-feedback').textContent.includes('could not be restored') && !localStorage.getItem('qchat.chats')`));
  await setup(); await type('/temp'); await key('Enter'); await sleep(100); await clear(); await undo(); s=await state();
  check('temporary current is restored but not persisted',s.current.key!=='current' && await evalJS(`document.querySelector('#mode-chip').textContent==='Temporary'`));
  await setup(); await list(); await remove('b'); await evalJS(`document.querySelector('.feature-search').blur();document.querySelector('#prompt-input').focus()`); await type('draft');
  const prevented = await evalJS(`(()=>{const e=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});document.querySelector('#prompt-input').dispatchEvent(e);return e.defaultPrevented})()`);
  check('composer text keeps native undo',!prevented && await visible()); await type(''); await key('z',{ctrlKey:true}); await sleep(80); s=await state(); check('Ctrl+Z with empty composer undoes',s.recent.some(x=>x.key==='b'));
  await remove('b'); const hides=await count('hide_main'); await key('Escape'); check('Escape dismisses undo before window',!await visible() && await count('hide_main')===hides);
  await setup(); await list(); await remove('b'); await evalJS(`document.querySelector('.feature-search').blur();document.querySelector('#prompt-input').focus()`); await type('/copy'); await key('Enter'); await sleep(100); check('plain feedback preserves undo button',await evalJS(`!!document.querySelector('#command-feedback button')`)); await sleep(2300); check('undo returns after plain feedback',await evalJS(`document.querySelector('#command-feedback').textContent.includes('Chat removed') && !!document.querySelector('#command-feedback button')`));
  await setup(); await list(); await remove('b');
  if (process.env.QCHAT_SHOT) await writeFile(process.env.QCHAT_SHOT, Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const searchPrevented = await evalJS(`(()=>{const f=document.querySelector('.feature-search');f.focus();f.value='abc';const e=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});f.dispatchEvent(e);return e.defaultPrevented})()`);
  check('list search text keeps native undo',!searchPrevented && await visible());
  await setup(); await list(); await remove('b'); await evalJS(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('#prompt-input').focus()`); await waitFor(`document.querySelector('.feature-list').hidden`); await type('/');
  await waitFor(`!document.getElementById('slash-menu').hidden`); await key('Escape'); await sleep(40);
  { const g=await evalJS(`({slash:document.getElementById('slash-menu').hidden,list:document.querySelector('.feature-list').hidden,undo:!document.getElementById('command-feedback').hidden,value:document.getElementById('prompt-input').value})`); check('Escape closes the slash menu before the undo offer', g.slash && g.undo, JSON.stringify(g)); }
  await setup(); await evalJS(`window.realInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'staged'}):c==='attachment_chunk'||c==='attachment_finish'?Promise.resolve({}):realInvoke(c,a);const d=new DataTransfer();d.items.add(new File(['x'],'x.txt'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))`);
  await waitFor(`document.querySelector('#attachments [data-state=ready]')`); await clear(); await undo(); s=await state();
  check('clear undo restores current with a file staged', s.current.key==='current' && await evalJS(`document.getElementById('attachments').textContent.includes('x.txt')`), JSON.stringify(s.current?.key));
  const stage = (name) => evalJS(`(()=>{const d=new DataTransfer();d.items.add(new File(['x'],'${name}'));const i=document.getElementById('attachment-input');i.files=d.files;i.dispatchEvent(new Event('change'))})()`);
  await setup(); await evalJS(`window.realInvoke=__TAURI__.core.invoke;window.nextFile=0;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'staged-'+(++nextFile)}):c==='attachment_chunk'||c==='attachment_finish'||c==='attachment_remove'?Promise.resolve({}):realInvoke(c,a)`);
  await stage('first.txt'); await waitFor(`document.querySelector('#attachments [data-state=ready]')`); await clear();
  const chipRemove = `document.querySelector('#attachments .attachment-chip:not(.selection-chip) button')`;
  await evalJS(`${chipRemove}.click()`); await waitFor(`!document.getElementById('attachments').textContent.includes('first.txt')`);
  await stage('second.txt'); await waitFor(`document.getElementById('attachments').textContent.includes('second.txt')&&document.querySelector('#attachments [data-state=ready]')`);
  await undo(); s=await state();
  check('same-count replaced file keeps the new draft', s.current.key!=='current' && s.recent.some(x=>x.key==='current') && await evalJS(`document.getElementById('attachments').textContent.includes('second.txt')`), JSON.stringify(s.current?.key));
  await setup(); await evalJS(`window.realInvoke=__TAURI__.core.invoke;window.nextFile=0;__TAURI__.core.invoke=(c,a)=>c==='attachment_begin'?Promise.resolve({...a,id:'staged-'+(++nextFile)}):c==='attachment_chunk'||c==='attachment_finish'||c==='attachment_remove'?Promise.resolve({}):realInvoke(c,a)`);
  await stage('gone.txt'); await waitFor(`document.querySelector('#attachments [data-state=ready]')`); await clear();
  await evalJS(`${chipRemove}.click()`); await waitFor(`!document.getElementById('attachments').textContent.includes('gone.txt')`);
  await undo(); s=await state();
  check('removing the original staged file still allows restore', s.current.key==='current', JSON.stringify(s.current?.key));
  check('no runtime errors',problems.length===0,problems.slice(0,4).join(' | '));
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



