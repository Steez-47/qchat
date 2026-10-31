// Opt-in, read-only: do images in a saved chat really render? QChat must be closed. Runs the debug
// build off screen on a disposable copy of the signed-in profile, using only chats already saved on
// this PC (no account list call, which is rate limited). Prints counts only and deletes the copy.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-old-image-'));
const port = 9407;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 60000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(400); } throw Error(`Timed out: ${label}`); }
const connect = async url => { const s = new WebSocket(url); await new Promise((a, b) => { s.onopen = a; s.onerror = b; }); let n = 0; const p = new Map(); s.onmessage = ({ data }) => { const m = JSON.parse(data); p.get(m.id)?.(m); p.delete(m.id); }; s.ev = expression => new Promise(res => { const id = ++n; p.set(id, m => res(m.result?.result?.value)); s.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); return s; };
let app, ui, page;
try {
  const skip = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|BrowserMetrics.*|Service Worker|blob_storage|lockfile|LOCK)$/;
  cpSync(path.join(process.env.LOCALAPPDATA, 'com.qchat.app', 'EBWebView'), path.join(profile, 'EBWebView'), { recursive: true, filter: f => !skip.test(path.basename(f)) });
  app = spawn(path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe'), [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: 'offscreen' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main');
  ui = await connect(main.webSocketDebuggerUrl);
  await until(() => ui.ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'ui');
  const ids = await ui.ev(`(()=>{const c=JSON.parse(localStorage.getItem('qchat.chats')||'{}');return [...(c.recent||[])].filter(x=>x.conversationId).map(x=>x.conversationId).slice(0,8);})()`);
  check('saved chats exist on this PC', ids?.length > 0, String(ids?.length));
  const chat = await until(async () => (await pages()).find(p => p.url.includes('chatgpt.com')), 'page');
  await sleep(9000);
  page = await connect(chat.webSocketDebuggerUrl);
  const found = await page.ev(`(async()=>{const t=(await (await fetch('/api/auth/session')).json()).accessToken;const h={Authorization:'Bearer '+t};for(const id of ${JSON.stringify(ids)}){await new Promise(r=>setTimeout(r,800));const r=await fetch('/backend-api/conversation/'+id,{headers:h});if(!r.ok)return {status:r.status};const d=await r.json();let n=0;for(let k=d.current_node;k&&d.mapping[k];k=d.mapping[k].parent){const m=d.mapping[k].message;if(m&&!m.metadata?.is_visually_hidden_from_conversation&&(m.content?.parts||[]).some(p=>p?.asset_pointer||(typeof p==='string'&&p.includes('<AsyncImage'))))n++;}if(n)return {id,images:n};}return {none:true};})()`);
  check('one of them holds an image on the account', !!found?.id, JSON.stringify({ status: found?.status, none: found?.none, images: found?.images }));
  if (found?.id) {
    await ui.ev(`localStorage.setItem('qchat.chats',JSON.stringify({v:1,current:{key:'image-check',conversationId:${JSON.stringify(found.id)},title:'Check',lastActive:Date.now(),lastPrompt:'',lastResponse:'',transcript:[],createdAt:1},recent:[]}));setTimeout(()=>location.reload(),50);1`);
    await sleep(3000);
    ui.close();
    ui = await connect((await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')).webSocketDebuggerUrl);
    await until(() => ui.ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__ && !document.getElementById('history-controls').hidden`), 'chat refreshed itself', 60000);
    const opened = await ui.ev(`(async()=>{
      const wait=async(f,ms)=>{const end=Date.now()+ms;while(Date.now()<end){const v=f();if(v)return v;await new Promise(r=>setTimeout(r,250));}return null;};
      const panel=document.getElementById('history-panel');
      document.getElementById('btn-history').click();
      await wait(()=>panel.querySelectorAll('.stored-media, .web-figure').length>0,30000);
      const cards=[...panel.querySelectorAll('.stored-media, .web-figure')];
      for(const card of cards.slice(0,24)){card.scrollIntoView({block:'center'});await wait(()=>card.querySelector('img')?.naturalWidth>0||card.querySelector('.media-status .btn')||card.hasAttribute('data-failed'),15000);await new Promise(r=>setTimeout(r,120));}
      const imgs=[...panel.querySelectorAll('.stored-media img, .web-figure img')];
      const prose=[...panel.querySelectorAll('.turn-content')].map(n=>{const c=n.cloneNode(true);c.querySelectorAll('pre,code').forEach(x=>x.remove());return c.textContent;}).join(' ');
      const reply=[...panel.querySelectorAll('[data-role=assistant] .turn-content')].find(n=>n.querySelector('.web-figure'));
      const first=reply?.querySelector('.web-figure');
      const firstText=reply?[...reply.querySelectorAll('p')].find(p=>p.textContent.trim().length>40&&!p.querySelector('.web-figure')):null;
      return {rows:panel.querySelectorAll('.turn-row').length,cards:cards.length,web:panel.querySelectorAll('.web-figure').length,loaded:imgs.filter(i=>i.naturalWidth>0).length,failed:panel.querySelectorAll('.web-figure[data-failed]').length,sizes:imgs.slice(0,3).map(i=>i.naturalWidth+'x'+i.naturalHeight),placeholders:(panel.textContent.match(/View attachments/g)||[]).length,rawTags:(prose.match(/<[/]?(?:box|row|grid|grid-item|text|title|divider|icon|AsyncImage\w*|Entity|Cite)\b/g)||[]).length,tokens:(prose.match(/[\uE200-\uE206]/g)||[]).length,links:panel.querySelectorAll('.turn-content a').length,inline:first&&firstText?!!(first.compareDocumentPosition(firstText)&Node.DOCUMENT_POSITION_FOLLOWING):null};
    })()`);
    check('old images render for real, with no placeholders', opened?.cards > 0 && opened.loaded + opened.failed >= Math.min(opened.cards, 24) && opened.loaded > 0 && opened.placeholders === 0, JSON.stringify(opened));
    check('no raw layout tags or tokens remain', opened?.rawTags === 0 && opened?.tokens === 0, JSON.stringify(opened));
  }
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ui?.close(); page?.close();
  if (app?.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
  for (let i = 0; i < 6 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(1000); }
  console.log(existsSync(profile) ? 'WARNING copy not removed' : 'disposable profile removed');
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
