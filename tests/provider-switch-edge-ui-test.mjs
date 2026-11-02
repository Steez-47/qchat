// Adversarial provider lifecycle checks. Only a private headless mock page is used.
// Hooks wrap IPC in this page; no product files, accounts or native profiles are touched.
import { openPage, serveUI, sleep, timerMs } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();
let browserPage, passed = 0, failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  ok ? passed++ : failed++;
};
try {
  browserPage = await openPage('provider-switch-edge', { problems });
  const { cdp, evalJS: js } = browserPage;
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false });
  // Fail closed against accidental provider/network access, including future mock changes.
  await cdp('Network.enable');
  await cdp('Network.setBlockedURLs', { urls: ['*://chatgpt.com/*', '*://*.chatgpt.com/*', '*://gemini.google.com/*'] });
  const until = async (expr, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(`!!(${expr})`).catch(() => false)) return true;
      await sleep(20);
    }
    return false;
  };
  const wait = async expr => { if (!await until(expr)) throw Error(`timeout: ${expr}`); };
  const S = `JSON.parse(localStorage.getItem('qchat.chats'))`;
  const I = `document.getElementById('prompt-input')`;
  const P = `document.getElementById('picker')`;
  const type = text => js(`${I}.value=${JSON.stringify(text)};${I}.dispatchEvent(new Event('input',{bubbles:true}))`);
  const key = (key, extra = {}) => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({key,bubbles:true,cancelable:true,...extra})}))`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const command = async name => {
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await js(`${I}.focus()`); await key('k', {ctrlKey:true});
    await wait(`document.getElementById('slash-${name}')`);
    await js(`document.getElementById('slash-${name}').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`);
  };
  const seedChat = (key, provider, extra = {}) => ({key,provider,title:key,lastActive:Date.now(),draft:'',selectionTexts:[],transcript:[],...extra});
  const open = async ({chats, settings = {}, keep = false, query = '?mock=signedin'} = {}) => {
    await cdp('Page.navigate', {url:base+'/__blank'});
    await wait(`location.pathname==='/__blank' && document.readyState==='complete'`);
    if (!keep) await js('localStorage.clear()');
    if (!keep) await js(`localStorage.setItem('qchat.settings',${JSON.stringify(JSON.stringify({animations:'off',autoDismiss:0,keepHistory:true,...settings}))})`);
    if (chats) await js(`localStorage.setItem('qchat.chats',${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', {url:base+'/'+query});
    await wait(`location.pathname==='/' && document.readyState==='complete' && window.__mock && window.QSettings && ${query.includes('holdProvider') ? "typeof __mock.releaseProvider==='function'" : "__mock.count('chat_status')>0"}`);
    if (!query.includes('status=hold') && !query.includes('holdProvider')) await wait(`document.getElementById('status-dot').dataset.state!=='connecting'`);
    // Instrument command ownership and model a separate page per provider (the stock
    // mock has one pageConv, unlike native). Preserve stock stream/send implementations.
    await js(`window.edgeCalls=[];window.edgePages={chatgpt:null,gemini:null};window.edgeInvoke=__TAURI__.core.invoke;
      __TAURI__.core.invoke=async(c,a={})=>{
        edgeCalls.push({cmd:c,args:a,provider:__mock.provider,page:edgePages[__mock.provider]});
        if(c==='provider_set'){const result=await edgeInvoke(c,a);__mock.pageConv=edgePages[a.provider];return result}
        if(c==='chat_open'||c==='chat_new'){
          const p=__mock.provider;const result=await edgeInvoke(c,a);edgePages[p]=c==='chat_open'?a.conversationId:null;
          // Stock chat_open always emits /c/, which cannot confirm Gemini opens.
          if(c==='chat_open'&&!__mock.silentOpen&&!__mock.failOpen)__mock.emit('bridge',{type:'status',provider:p,ready:true,loggedIn:__mock.loggedIn,url:p==='gemini'?'https://gemini.google.com/app/'+a.conversationId:'https://chatgpt.com/c/'+a.conversationId});
          return result;
        }
        return edgeInvoke(c,a);
      }`);
  };
  const settled = p => wait(`${S}?.current.provider===${JSON.stringify(p)} && !document.getElementById('btn-reasoning').disabled`);
  const switchTo = async p => { await command(p); await settled(p); };
  const begin = async () => { await js('__mock.providerHold=true'); await command('gemini'); await wait(`typeof __mock.releaseProvider==='function'`); };
  const release = async () => { await js('__mock.providerHold=false;__mock.releaseProvider()'); await settled('gemini'); };
  const send = async text => { await js(`${I}.focus()`); await type(text); await key('Enter'); };
  const emit = event => js(`__mock.emit('bridge',${JSON.stringify(event)})`);
  const list = async () => { await js(`${I}.focus()`); await key('p',{ctrlKey:true}); await wait(`!document.querySelector('.feature-list').hidden`); };
  const tab = key => click(`#tabs [data-key="${key}"]`);
  const scenario = async (name, fn) => { try { await fn(); } catch(e) { check(name+' [scenario completed]',false,e.message); } };

  await scenario('rapid switching', async () => {
    await open(); await type('draft 🌏'); await begin();
    const n=await js(`__mock.count('provider_set')`);
    await command('gemini'); await command('gemini');
    check('rapid repeated commands issue one switch',await js(`__mock.count('provider_set')===${n}`));
    await type('newer draft 🌏'); await js(`${I}.setSelectionRange(2,8,'backward')`);
    await key('Enter');
    check('Send during held switch is blocked and preserves draft',await js(`__mock.count('chat_send')===0 && ${I}.value==='newer draft 🌏'`));
    await release();
    check('held switch preserves latest text and backward selection',await js(`${I}.value==='newer draft 🌏' && ${I}.selectionStart===2 && ${I}.selectionEnd===8 && ${I}.selectionDirection==='backward'`));
    for (const p of ['chatgpt','gemini','chatgpt','gemini']) await switchTo(p);
    check('A-B-A repeated switching keeps composer and provider coherent',await js(`${I}.value==='newer draft 🌏' && __mock.provider===${S}.current.provider`));
    await open({keep:true});
    check('switched provider and draft survive reload',await js(`__mock.provider==='gemini' && ${I}.value==='newer draft 🌏'`));
  });
  await scenario('reject and hang',async()=>{
    await open(); await type('retain on refusal'); await js('__mock.failProvider=true'); await command('gemini');
    await wait(`!document.getElementById('global-error').hidden`);
    check('provider_set rejection keeps original chat, draft and usable controls',await js(`__mock.provider==='chatgpt' && ${I}.value==='retain on refusal' && !document.getElementById('btn-reasoning').disabled`));
    await open(); await type('retain on refusal'); await begin();
    // Observe an actual deadline condition, not a fixed sleep. The provider never resolves.
    await js(`window.edgeDeadline=false;setTimeout(()=>edgeDeadline=true,30000)`);
    if (!await until('edgeDeadline',timerMs(30000)+5000)) throw Error('deadline marker not reached');
    check('hung provider_set offers recovery instead of locking composer indefinitely',await js(`!document.getElementById('btn-reasoning').disabled || (!document.getElementById('global-error').hidden && /switch|retry/i.test(document.getElementById('global-error').textContent))`));
    // The UI gave up and stayed put, so a switch landing late must not leave the backend elsewhere.
    const beforeLate=await js(`__mock.count('provider_set')`);
    await js('__mock.providerHold=false;__mock.releaseProvider()');
    check('late provider_set puts the backend back on the provider the UI shows',await until(`__mock.count('provider_set')===${beforeLate+1} && __mock.provider==='chatgpt'`,4000) && await js(`${S}.current.provider==='chatgpt' && ${I}.value==='retain on refusal'`));
    await command('gemini'); await settled('gemini');
    check('switching works again after a stalled attempt',await js(`__mock.provider==='gemini' && ${S}.current.provider==='gemini' && ${I}.value==='retain on refusal'`));
  });
  await scenario('picker double clicks and keyboard switching',async()=>{
    await open(); await click('#btn-reasoning'); await wait(`!${P}.hidden`);
    const n=await js(`__mock.count('provider_set')`);
    await js(`__mock.providerHold=true;window.edgeGemini=[...${P}.querySelectorAll('.picker-seg-btn')].find(n=>n.textContent.trim()==='Gemini');edgeGemini.click();edgeGemini.click();const a=[...${P}.querySelectorAll('.picker-seg-btn')].find(n=>n.textContent.trim()==='ChatGPT');a.click()`);
    await wait(`typeof __mock.releaseProvider==='function'`);
    check('double click and opposite picker click during switch issue one IPC',await js(`__mock.count('provider_set')===${n+1}`));
    await release();
    check('picker survives switch with enabled focused item and Gemini models',await js(`!${P}.hidden && ${P}.contains(document.activeElement) && !document.activeElement.disabled && ${P}.textContent.includes('Flash-Lite')`));
    await js(`[...${P}.querySelectorAll('.picker-seg-btn')].find(n=>n.textContent.trim()==='ChatGPT').focus()`);
    // Native button activation needs a trusted browser key (synthetic DOM Enter has
    // no default action). CDP targets only this headless page, never the OS.
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await settled('chatgpt');
    check('keyboard Enter switches provider and retains picker focus',await js(`!${P}.hidden && ${P}.contains(document.activeElement) && __mock.provider==='chatgpt'`));
  });
  await scenario('stream stop retry and stale events',async()=>{
    await open(); await js('__mock.hold=true'); await send('held reply');
    await wait(`__mock.count('chat_send')===1`);
    const id=await js(`__mock.last('chat_send').args.id`), count=await js(`__mock.count('provider_set')`);
    await command('gemini');
    check('switch immediately after Send and during streaming is refused',await js(`__mock.count('provider_set')===${count} && __mock.provider==='chatgpt'`));
    await emit({provider:'chatgpt',type:'delta',id,text:'partial reply'});
    await js(`${I}.focus()`); await key('.',{ctrlKey:true}); await wait(`__mock.count('chat_stop')>0 && !document.getElementById('btn-reasoning').disabled`);
    await switchTo('gemini'); await js('__mock.hold=true'); await send('Gemini active'); await wait(`__mock.count('chat_send')===2`);
    const gid=await js(`__mock.last('chat_send').args.id`);
    for(const type of ['start','delta','done','done','error','sources','media']) await emit({provider:'chatgpt',type,id:gid,text:'POISON',conversationId:'wrong',code:'auth',items:[]});
    await emit({provider:'gemini',type:'done',id:gid,text:'clean Gemini reply',conversationId:'gem-conv'});
    await wait(`!document.getElementById('btn-reasoning').disabled`);
    check('old-provider late duplicate events cannot mutate active turn even with matching ID',await js(`!localStorage.getItem('qchat.chats').includes('POISON') && ${S}.current.conversationId==='gem-conv'`));
    await emit({provider:'chatgpt',type:'done',id,text:'late stopped content',conversationId:'wrong'});
    check('stopped provider terminal event cannot replace current conversation',await js(`${S}.current.conversationId==='gem-conv'`));
    await switchTo('chatgpt'); await js(`__mock.sendError='rate_limited'`); await send('retry me');
    await wait(`document.querySelector('[data-action="retry-turn"]')`);
    await js('__mock.sendError=null;__mock.hold=true'); await click('[data-action="retry-turn"]');
    await wait(`__mock.count('chat_send')===4`); const before=await js(`__mock.count('provider_set')`); await command('gemini');
    check('switch during retry is refused',await js(`__mock.provider==='chatgpt' && __mock.count('provider_set')===${before}`));
  });
  const data=()=>({v:1,current:seedChat('c','chatgpt',{conversationId:'c-id',lastResponse:'ChatGPT needle',reasoningEffort:'high',transcript:[{id:'ca',role:'assistant',text:'ChatGPT needle'}]}),recent:[seedChat('g','gemini',{conversationId:'g-id',lastResponse:'Gemini only',model:'Flash-Lite',draft:'g draft',transcript:[{id:'ga',role:'assistant',text:'Gemini only'}]})]});
  await scenario('History and page ownership',async()=>{
    await open({chats:data()}); await list(); await js('__mock.failProvider=true');
    await js(`[...document.querySelectorAll('.feature-row')].find(n=>n.querySelector('.feature-title')?.textContent==='g').querySelector('.feature-choice').click()`);
    await wait(`!document.getElementById('global-error').hidden`);
    check('failed cross-provider History open retains original chat and target',await js(`${S}.current.key==='c' && ${S}.recent.some(c=>c.key==='g')`));
    await js('__mock.failProvider=false'); await tab('g'); await settled('gemini'); await wait(`__mock.count('chat_open')>0`);
    check('History chat opens on its owning provider with saved draft',await js(`${S}.current.key==='g' && ${I}.value==='g draft' && __mock.last('chat_open').args.conversationId==='g-id'`));
    await tab('c'); await settled('chatgpt'); await wait(`__mock.last('chat_open').args.conversationId==='c-id'`);
    check('opening ChatGPT History restores per-chat reasoning label',await js(`document.querySelector('.reasoning-label').textContent==='High'`));
    await tab('g'); await settled('gemini'); await js('__mock.hold=true'); await send('followup g'); await wait(`__mock.count('chat_send')===1`);
    check('A-B-A followup uses retained provider page conversation',await js(`edgeCalls.filter(c=>c.cmd==='chat_send').at(-1).provider==='gemini' && edgeCalls.filter(c=>c.cmd==='chat_send').at(-1).page==='g-id' && __mock.last('chat_send').args.provider==='gemini'`));
  });
  await scenario('pending switch and History',async()=>{
    await open({chats:data()}); await begin(); await tab('g'); await release();
    check('History click during held switch cannot silently select a wrong-provider chat',await js(`${S}.current.provider===__mock.provider && __mock.count('chat_open')===0`));
  });
  await scenario('composer quote files modes and labels',async()=>{
    await open({chats:data()}); await type('draft with files');
    await js(`__mock.emit('qchat://selection','quoted 🌏');const d=new DataTransfer();d.items.add(new File(['bytes'],'edge.txt',{type:'text/plain'}));const f=document.getElementById('attachment-input');f.files=d.files;f.dispatchEvent(new Event('change'))`);
    await wait(`document.querySelector('#attachments [data-state=ready]')`);
    const files=await js('[...__mock.attachmentFiles.keys()]'); await switchTo('gemini');
    check('switch preserves exact staged attachment identity and quoted context',await js(`JSON.stringify([...__mock.attachmentFiles.keys()])===${JSON.stringify(JSON.stringify(files))} && ${S}.current.selectionTexts[0]==='quoted 🌏' && document.querySelector('.selection-chip')`));
    if (await js(`${P}.hidden`)) await click('#btn-reasoning'); await wait(`!${P}.hidden`);
    check('Gemini picker shows free model and disables paid Pro',await js(`[...${P}.querySelectorAll('.picker-row')].some(n=>n.textContent.includes('Flash-Lite')) && [...${P}.querySelectorAll('.picker-row')].find(n=>n.textContent.includes('Pro'))?.disabled`));
    await js(`[...${P}.querySelectorAll('.picker-row')].find(n=>n.textContent.includes('Thinking')).click()`);
    await wait(`document.querySelector('.reasoning-label').textContent==='Thinking'`);
    await switchTo('chatgpt'); await switchTo('gemini');
    check('Gemini model choice survives provider round trip',await js(`document.querySelector('.reasoning-label').textContent==='Thinking'`));
    await switchTo('chatgpt'); await command('temp'); await type('temporary draft'); await switchTo('gemini');
    check('Temporary to Gemini drops privacy mode with notice and preserves draft',await js(`${I}.value==='temporary draft' && document.getElementById('mode-chip').hidden && document.getElementById('command-feedback').textContent.includes('Temporary chats are ChatGPT only')`));
    await switchTo('chatgpt'); check('returning from Gemini does not silently re-enable Temporary',await js(`!${S}.current.temporary && document.getElementById('mode-chip').hidden`));
    // Modes are UI/mock contract only; no assertion of native Work/Task support for free accounts.
    if (await js(`${P}.hidden`)) await click('#btn-reasoning'); await wait(`!${P}.hidden`);
    await js(`[...${P}.querySelectorAll('button')].find(n=>n.textContent.trim()==='Work').click()`);
    await wait(`${S}.current.mode==='work'`); await switchTo('gemini');
    check('provider change resets Work mode to Chat',await js(`${S}.current.mode==='chat' && !/Work|Task/.test(document.querySelector('.reasoning-label').textContent)`));
    if (await js(`${P}.hidden`)) await click('#btn-reasoning'); await wait(`!${P}.hidden`);
    await js(`[...${P}.querySelectorAll('button')].find(n=>n.textContent.trim()==='Task').click()`);
    await wait(`${S}.current.mode==='work'`); await switchTo('chatgpt');
    check('provider change resets Task mode to Chat and reasoning label',await js(`${S}.current.mode==='chat' && document.querySelector('.reasoning-label').textContent==='Medium'`));
  });
  await scenario('status picker focus Find and chat list',async()=>{
    await open({chats:data()}); await emit({type:'status',provider:'gemini',ready:false,loggedIn:false});
    await js(`${I}.focus()`); await key('f',{ctrlKey:true}); await wait(`!document.getElementById('find-bar').hidden`);
    await js(`const f=document.getElementById('find-input');f.value='needle';f.dispatchEvent(new Event('input',{bubbles:true}))`);
    await switchTo('gemini');
    check('Find clears old conversation highlights on provider switch',await js(`document.getElementById('find-bar').hidden && !(CSS.highlights.get('qchat-find')?.size)`));
    await js('__mock.statusHold=true'); await emit({type:'status',provider:'gemini',ready:false,loggedIn:false});
    const status=await js(`document.getElementById('status-label').textContent`);
    await emit({type:'status',provider:'chatgpt',ready:true,loggedIn:true});
    check('background provider status cannot overwrite active not-ready header',status===await js(`document.getElementById('status-label').textContent`));
    await emit({type:'status',provider:'gemini',ready:true,loggedIn:false,model:'Flash-Lite'});
    await click('#btn-reasoning'); await wait(`!${P}.hidden`);
    check('signed-out Gemini picker excludes ChatGPT models and labels provider',await js(`${P}.textContent.includes('Flash-Lite') && !${P}.textContent.includes('Mock alternate') && document.getElementById('btn-reasoning').getAttribute('aria-label').includes('Gemini')`));
    await js(`${P}.querySelector('button:not(:disabled)').focus()`); await key('ArrowRight');
    check('picker keyboard navigation retains visible enabled focus',await js(`${P}.contains(document.activeElement) && !document.activeElement.disabled`));
    await key('Escape'); check('picker Escape returns focus to model opener',await js(`${P}.hidden && document.activeElement.id==='btn-reasoning'`));
    await emit({type:'status',provider:'gemini',ready:true,loggedIn:true}); await list();
    await emit({type:'conversations',provider:'gemini',items:[{id:'gem-list',title:'Gemini account only'}],total:1});
    await key('Escape'); await switchTo('chatgpt'); await list();
    await emit({type:'conversations',provider:'gemini',items:[{id:'late',title:'LATE WRONG LIST'}],total:1});
    await emit({type:'conversations',provider:'chatgpt',items:[{id:'gpt-list',title:'GPT account only'}],total:1});
    check('accountChats reset and stale list events preserve provider isolation',await js(`document.querySelector('.feature-list').textContent.includes('GPT account only') && !/Gemini account only|LATE WRONG LIST/.test(document.querySelector('.feature-list').textContent)`));
    check('tabs retain provider identity after switches',await js(`!!document.querySelector('#tabs svg[data-provider="gemini"]')`));
  });
  await scenario('undo cross provider removal and clear',async()=>{
    await open({chats:data()}); await list();
    await js(`[...document.querySelectorAll('.feature-row')].find(n=>n.querySelector('.feature-title')?.textContent==='g').querySelector('[aria-label="Remove chat"]').click()`);
    await click('#command-feedback button');
    check('Undo removal restores other-provider chat with exact metadata',await js(`${S}.recent.some(c=>c.key==='g' && c.provider==='gemini' && c.conversationId==='g-id' && c.draft==='g draft')`));
    await key('Escape'); await command('clear'); await click('#btn-clear-yes'); await switchTo('gemini');
    await click('#command-feedback button');
    check('Undo clear after provider switch preserves new chat and restores old conversation to tabs',await js(`${S}.current.provider==='gemini' && ${S}.recent.some(c=>c.key==='c' && c.conversationId==='c-id') && __mock.provider==='gemini'`));
  });
  await scenario('startup and corrupted storage',async()=>{
    await open({settings:{defaultProvider:'gemini'}});
    check('startup default Gemini is applied',await js(`__mock.provider==='gemini'`));
    await open({settings:{defaultProvider:'garbage'},chats:{v:1,current:seedChat('bad','garbage'),recent:[seedChat('bad2','__proto__')]}});
    // Empty chats need not rewrite storage at launch; exercise a real draft write.
    await type('normalized'); await js(`window.dispatchEvent(new Event('pagehide'))`);
    await wait(`${S}.current.draft==='normalized'`);
    check('corrupt stored provider values normalize on next save',await js(`__mock.provider==='chatgpt' && ${S}.current.provider==='chatgpt' && ${S}.recent.every(c=>c.provider==='chatgpt')`));
    await open({chats:{v:1,current:seedChat('g','gemini',{draft:'fallback draft'}),recent:[]},query:'?mock=signedin&failProvider'});
    check('startup switch rejection follows backend and preserves draft',await js(`__mock.provider==='chatgpt' && ${I}.value==='fallback draft' && ${S}.current.provider==='chatgpt'`));
    await open({settings:{defaultProvider:'gemini'},query:'?mock=signedin&holdProvider'});
    await type('typed during startup'); await js('__mock.providerHold=false;__mock.releaseProvider()');
    await wait(`__mock.count('chat_status')>0 && __mock.provider==='gemini'`);
    check('slow startup provider selection retains typed draft',await js(`${I}.value==='typed during startup'`));
  });
  check('no unexpected browser runtime errors',problems.length===0,problems.slice(0,4).join(' | '));
} catch(e) { check('suite setup completed',false,e.stack); }
finally { await browserPage?.close(); closeServer(); }
console.log(`FINAL ${passed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
