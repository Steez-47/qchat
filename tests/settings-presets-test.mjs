// Bubble UI checks and screenshots in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input. `--shots <dir>` also captures review PNGs.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('glass-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({rows:[...document.querySelectorAll('.turn-row')].map(r=>({role:r.dataset.role,status:r.dataset.status,hidden:r.hidden,cls:r.className})),calls:window.__mock?.calls.slice(-4).map(c=>c.cmd),fits:window.__mock?.fits.length,lastFits:window.__mock?.fits.slice(-4).map(x=>x.height),text:document.querySelector('[data-role=assistant] .turn-content')?.textContent.length,capped:document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped'),now:performance.now()|0,hold:window.__mock?.hold,rel:!!window.__mock?.release,btn:document.getElementById('btn-send')?.dataset.mode})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await until(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await until(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };
  const cssVar = (name) => evalJS(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const chat = (key, conv, ago, title = key) => ({ key, conversationId: conv, title, lastActive: Date.now() - ago, lastPrompt: `prompt ${key}`, lastResponse: `Cached **reply** for ${key}`, createdAt: Date.now() - ago });
  const seeded = (current, ...recent) => ({ v: 1, current, recent });

  await open('/settings.html');
  check('settings rows cover active schema', await evalJS(`Object.keys(QSettings.SCHEMA).every(k=>['look','streamStyle','streamSpeed'].includes(k)||document.querySelector('.row[data-key="'+k+'"]'))`));
  check('obsolete streaming controls are hidden while saved choices remain compatible',await evalJS(`!document.querySelector('.row[data-key="streamStyle"],.row[data-key="streamSpeed"]') && QSettings.sanitize({...QSettings.DEFAULTS,streamStyle:'type',streamSpeed:2}).streamStyle==='type'`));
  check('literal glass and guarded replies',await evalJS(`(()=>{QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,glassOpacity:20,replyOpacity:20});const s=document.documentElement.style;return s.getPropertyValue('--glass-a')==='0.200' && +s.getPropertyValue('--reply-a')>.2})()`));
  check('unguarded reply opacity',await evalJS(`(()=>{QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,replyOpacity:20,readableGuard:false});return document.documentElement.style.getPropertyValue('--reply-a')==='0.200'})()`));
  check('chat glass and chat layout are grouped and independent of the bar',await evalJS(`['replyOpacity','replyNativeBlur','replyBlur','replyCorners','replyBorder'].every(k=>document.querySelector('#section-glass .row[data-key="'+k+'"]')) && ['replyWidth','replyPadding','bubbleGap','maxHeightPct'].every(k=>document.querySelector('#section-chat .row[data-key="'+k+'"]'))`));
  check('chat shape does not change bar shape',await evalJS(`(()=>{QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,replyCorners:3,replyBorder:0,replyOpacity:0,readableGuard:false});const s=document.documentElement.style;return s.getPropertyValue('--r-bubble')==='3px'&&s.getPropertyValue('--reply-bw')==='0px'&&s.getPropertyValue('--bw')==='1px'&&s.getPropertyValue('--reply-a')==='0.000'&&s.getPropertyValue('--glass-a')==='0.620'})()`));
  check('old shared glass choices migrate to chat',await evalJS(`(()=>{localStorage.setItem('qchat.settings',JSON.stringify({v:4,nativeBlur:false,blur:20,cornerWeight:0,border:.5}));const s=QSettings.load();return !s.replyNativeBlur&&s.replyBlur===50&&s.replyCorners===6&&s.replyBorder===.5&&JSON.parse(localStorage.getItem('qchat.settings')).v===QSettings.VERSION})()`));
  check('presets sanitize and preserve behavior',await evalJS(`QSettings.PRESETS.length>=14 && QSettings.PRESETS.every(p=>{const s={...QSettings.DEFAULTS,keepHistory:false,alwaysOnTop:false,sendKey:'ctrl',rememberPosition:false,hideOnBlur:true,selectionClipboard:false,autoDismiss:30}; const r=QSettings.applyPreset(s,p.id);return JSON.stringify(r)===JSON.stringify(QSettings.sanitize(r)) && ['keepHistory','alwaysOnTop','sendKey','rememberPosition','hideOnBlur','selectionClipboard','autoDismiss'].every(k=>r[k]===s[k])})`));
  check('v2 migration preserves choices',await evalJS(`(()=>{localStorage.setItem('qchat.settings',JSON.stringify({v:2,glassOpacity:25,blur:3,feel:'springy',textSize:14,lineHeight:1.6,keepHistory:false}));const s=QSettings.load();return s.glassOpacity===25&&s.blur===40&&s.feel==='calm'&&s.textSize===15&&s.lineHeight===1.65&&!s.keepHistory&&s.replyOpacity===92})()`));
  check('save export import delete and malformed input',await evalJS(`(()=>{const p=QSettings.savePreset('Mine',{...QSettings.DEFAULTS,textSize:19});const j=QSettings.exportPreset(p.id);const imported=QSettings.importPreset(j);const ok=imported&&imported.values.textSize===19&&!('keepHistory' in imported.values)&&QSettings.importPreset('{')===null&&QSettings.importPreset('null')===null;QSettings.deletePreset(p.id);return ok&&!QSettings.listPresets().some(x=>x.id===p.id)})()`));
  check('unknown and behavior import keys dropped',await evalJS(`(()=>{const p=QSettings.importPreset(JSON.stringify({label:'Safe',values:{unknown:1,keepHistory:false,textSize:18}}));return p&&!('unknown' in p.values)&&!('keepHistory' in p.values)&&p.values.textSize===18})()`));
  check('custom tint selects readable ink',await evalJS(`(()=>{const lum=c=>c.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);return ['#FFFFFF','#000000','#888888','#526A84'].every(t=>{QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,tintSource:'custom',tintColor:t});const s=document.documentElement.style,a=lum(s.getPropertyValue('--ink').split(' ').map(Number)),b=lum(s.getPropertyValue('--tint-a').split(' ').map(Number));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5})})()`));
  await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='wrap code';s.dispatchEvent(new Event('input'))})()`);
  check('search filters rows',await evalJS(`!document.querySelector('[data-key=codeWrap]').hidden && document.querySelector('[data-key=replyWidth]').hidden`));
  await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='zzzznoresult';s.dispatchEvent(new Event('input'))})()`);
  check('search empty state',await evalJS(`!document.getElementById('search-empty').hidden`));
  await evalJS(`document.getElementById('settings-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  check('escape clears search',await evalJS(`document.getElementById('settings-search').value===''&&!document.querySelector('[data-key=replyWidth]').hidden`));

  // Navigation: grouped sidebar, one page at a time, changed markers and per-page reset.
  await open('/settings.html');
  const shown = () => evalJS(`JSON.stringify([...document.querySelectorAll('.section')].filter(n=>n.offsetParent!==null).map(n=>n.id))`);
  const setRange = (key, value) => evalJS(`(()=>{const i=document.getElementById('control-${key}');i.value=${value};i.dispatchEvent(new Event('input'))})()`);
  check('one page shows at a time, starting at General', await shown()==='["section-general"]', await shown());
  check('sidebar groups pages under headings', await evalJS(`[...document.querySelectorAll('.nav-heading')].map(n=>n.textContent).join()==='Basics,Look & feel,Account'`));
  check('every setting appears exactly once', await evalJS(`Object.keys(QSettings.SCHEMA).every(k=>document.querySelectorAll('.row[data-key="'+k+'"]').length===(['look','streamStyle','streamSpeed'].includes(k)?0:1))`));
  check('update checking belongs to General after merging the settings pages', await evalJS(`!!document.querySelector('#section-general .row[data-key="checkUpdates"]')`));
  check('choices have readable names', await evalJS(`[...document.querySelectorAll('.row[data-key=tintSource] [data-value], .row[data-key=quoteStyle] [data-value]')].map(b=>b.textContent).join()==='From theme,Custom,Shaded,Plain,Italic'`));
  await evalJS(`document.querySelector('[data-section=glass]').click()`);
  check('sidebar switches page and marks it current', await shown()==='["section-glass"]' && await evalJS(`document.querySelector('[data-section=glass]').getAttribute('aria-current')==='page' && !document.querySelector('[data-section=general]').hasAttribute('aria-current')`));
  check('untouched page has no changed marker or page reset', await evalJS(`!document.querySelector('[data-section=glass]').hasAttribute('data-changed') && document.querySelector('[data-reset-page=glass]').hidden`));
  await setRange('glassOpacity', 40); await setRange('textSize', 18);
  check('a change marks its page in the sidebar', await evalJS(`document.querySelector('[data-section=glass]').hasAttribute('data-changed') && document.querySelector('[data-section=text]').hasAttribute('data-changed') && !document.querySelector('[data-section=window]').hasAttribute('data-changed') && !document.querySelector('[data-reset-page=glass]').hidden`));
  await evalJS(`document.querySelector('[data-reset-page=glass]').click()`);
  check('page reset restores only that page', await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.settings'));return s.glassOpacity===62 && s.textSize===18 && !document.querySelector('[data-section=glass]').hasAttribute('data-changed') && document.querySelector('[data-section=text]').hasAttribute('data-changed')})()`));
  check('custom accent colour stays tucked away until Custom is chosen', await evalJS(`document.querySelector('.row[data-key=accentColor]').hasAttribute('data-collapsed')`));
  await evalJS(`document.querySelector('.row[data-key=accentSource] [data-value=custom]').click()`);
  check('choosing Custom reveals the colour picker', await evalJS(`!document.querySelector('.row[data-key=accentColor]').hasAttribute('data-collapsed')`));
  await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='size';s.dispatchEvent(new Event('input'))})()`);
  const sizeHits = JSON.parse(await shown());
  check('search looks across every page and opens fine-tune', sizeHits.includes('section-text') && sizeHits.includes('section-bar') && !sizeHits.includes('section-glass') && await evalJS(`document.querySelector('#section-text .fine-tune').open && document.querySelector('.nav-heading[hidden]')!==null`), JSON.stringify(sizeHits));
  await evalJS(`document.getElementById('settings-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  check('clearing search returns to the open page and closes what it opened', await shown()==='["section-glass"]' && await evalJS(`!document.querySelector('#section-text .fine-tune').open`));
  await evalJS(`(()=>{const s=document.getElementById('settings-search');s.value='blur';s.dispatchEvent(new Event('input'))})()`);
  await evalJS(`document.querySelector('[data-section=motion]').click()`);
  check('picking a page from search results clears the search', await shown()==='["section-motion"]' && await evalJS(`document.getElementById('settings-search').value===''`));
  await open('/settings.html', { keep: true });
  check('settings reopen on the last page', await shown()==='["section-motion"]', await shown());
  check('no-blur fallback and blur strength',await evalJS(`(()=>{let call;window.QSurfaces={setBlur:(...args)=>{call=args;return Promise.resolve()}};QSettings.apply(document.documentElement,{...QSettings.DEFAULTS,glassOpacity:20,nativeBlur:false,replyNativeBlur:false,blur:10});return +document.documentElement.style.getPropertyValue('--glass-a')>.2&&call[0]===false&&call[2]===0&&call[3]===0})()`));
  await evalJS(`document.querySelector('[data-preset=reader]').click()`);
  check('preset card applies and relays',await evalJS(`JSON.parse(localStorage.getItem('qchat.settings')).fontFamily==='serif'&&document.getElementById('preset-status').textContent==='Reader'&&__mock.calls.filter(c=>c.cmd==='emit:qchat://settings-changed').at(-1).args.textSize===18`));
  await evalJS(`document.getElementById('control-textSize').value=19;document.getElementById('control-textSize').dispatchEvent(new Event('input'))`);
  check('modified preset state',await evalJS(`document.getElementById('preset-status').textContent==='Custom'`));
  await evalJS(`document.querySelector('[data-section=chat]').click()`);
  if (shotsDir) {
    await mkdir(shotsDir,{recursive:true}); await sleep(300);
    const shot=await cdp('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(shotsDir,'chat-panel-settings.png'),Buffer.from(shot.data,'base64'));
  }
  await open('/', {settings:{v:5,...await evalJS('QSettings.DEFAULTS'),animations:'off',nativeBlur:false,replyNativeBlur:true,replyBlur:65,replyOpacity:25,readableGuard:false,replyCorners:4,replyBorder:.5,showPrompt:true}});
  await send('Chat material test'); await finishReply(); await settle();
  check('rendered chat material is independent',await evalJS(`(()=>{const c=getComputedStyle(document.querySelector('.bubble-response')),b=getComputedStyle(document.getElementById('bar'));return c.getPropertyValue('--fill-alpha').trim()==='0.250'&&c.borderTopLeftRadius==='4px'&&c.getPropertyValue('--bw').trim()==='0.5px'&&b.getPropertyValue('--fill-alpha').trim()==='0.620'})()`));
  await until(`__mock.last('surfaces_set')?.args.rects.some(r=>r.s===.65)`, 'chat native surface strength');
  check('native chat and bar blur strengths independent',await evalJS(`(()=>{const a=__mock.last('surfaces_set').args.rects;return a.some(r=>r.b&&r.s===.65)&&a.some(r=>r.b&&r.s===0)&&__mock.last('surfaces_set_blur').args.enabled})()`));
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,replyBlur:0,replyNativeBlur:false,nativeBlur:true,blur:40,replyOpacity:35,readableGuard:false})`);
  await until(`__mock.last('surfaces_set')?.args.rects.some(r=>r.b&&r.s===1)`, 'bar blur update');
  check('live chat material update reaches native surfaces',await evalJS(`(()=>{const a=__mock.last('surfaces_set').args.rects;return a.some(r=>r.b&&r.s===0)&&a.some(r=>r.b&&r.s===1)&&getComputedStyle(document.querySelector('.bubble-response')).getPropertyValue('--fill-alpha').trim()==='0.350'})()`));
  // Screen fit: a first start measures the screen once and sizes the defaults for it.
  check('tiers follow the logical screen size',await evalJS(`[[1280,680],[1366,728],[1536,824],[1920,1032],[2048,1104],[2560,1392],[3840,2112]].map(([w,h])=>QSettings.screenTier(w,h)).join()==='small,small,small,medium,medium,large,large'`));
  await open('/settings.html');
  check('without a measurement the big-screen defaults stay',await evalJS(`QSettings.screenFit==='large'&&QSettings.DEFAULTS.textSize===15&&QSettings.settings.replyWidth===640&&!localStorage.getItem('qchat.screenfit')`));
  await open('/settings.html?screen=1280x680');
  check('a first start on a 720p screen picks small sizes',await evalJS(`(()=>{const s=QSettings.settings,d=QSettings.DEFAULTS,fit=JSON.parse(localStorage.getItem('qchat.screenfit'));return QSettings.screenFit==='small'&&fit.tier==='small'&&fit.height===680&&s.textSize===13&&s.barWidth===380&&s.replyWidth===480&&s.maxHeightPct===50&&s.density==='compact'&&d.replyWidth===480&&s.glassOpacity===62})()`));
  check('small sizes reach the CSS',await evalJS(`(()=>{const st=document.documentElement.style;return st.getPropertyValue('--text-size')==='13px'&&st.getPropertyValue('--bar-w')==='380px'&&st.getPropertyValue('--bar-h')==='38px'})()`));
  check('fitted sizes count as unchanged',await evalJS(`!document.querySelector('.row[data-key=textSize]').hasAttribute('data-changed')&&!document.querySelector('.row[data-key=replyWidth]').hasAttribute('data-changed')`));
  check('the Default preset uses the fitted sizes',await evalJS(`(()=>{const r=QSettings.applyPreset({...QSettings.settings,textSize:20},'default');return r.textSize===13&&r.replyWidth===480})()`));
  await open('/settings.html?screen=2560x1392', {keep:true});
  check('the measured fit is kept on later starts',await evalJS(`QSettings.screenFit==='small'&&QSettings.settings.textSize===13`));
  await evalJS(`document.querySelector('[data-section=chat]').click()`);
  await evalJS(`document.getElementById('btn-fit-screen').click()`);
  check('Fit measures again and resets only the sizes',await evalJS(`(()=>{const s=JSON.parse(localStorage.getItem('qchat.settings'));return QSettings.screenFit==='large'&&JSON.parse(localStorage.getItem('qchat.screenfit')).tier==='large'&&s.textSize===15&&s.replyWidth===640&&s.density==='cozy'&&!document.querySelector('.row[data-key=textSize]').hasAttribute('data-changed')&&/large screen/.test(document.querySelector('#btn-fit-screen').parentElement.textContent)&&__mock.calls.filter(c=>c.cmd==='emit:qchat://settings-changed').at(-1).args.replyWidth===640})()`));
  await open('/settings.html?screen=1920x1032', {settings:{v:6,textSize:15,barWidth:460,replyWidth:700,maxHeightPct:60,density:'cozy',look:'frost'}});
  check('upgrading on a 1080p screen shrinks sizes left at the old defaults only',await evalJS(`(()=>{const s=QSettings.settings;return QSettings.screenFit==='medium'&&s.textSize===14&&s.barWidth===420&&s.maxHeightPct===55&&s.replyWidth===700&&s.look==='frost'&&JSON.parse(localStorage.getItem('qchat.settings')).v===QSettings.VERSION})()`));
  await open('/?screen=1366x728');
  check('the chat window fits a 768p screen',await evalJS(`(()=>{const f=__mock.fit||__mock.last('fit_window')?.args;return QSettings.screenFit==='small'&&document.getElementById('bar').offsetWidth===380&&f&&f.width<=480+56})()`));
  check('no runtime errors',problems.length===0,problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
