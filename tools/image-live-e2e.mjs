// Opt-in saved-account image check. Sends one synthetic image-generation prompt.
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
if(!process.argv.includes('--run-with-saved-profile'))throw Error('Requires --run-with-saved-profile. Quit QChat first.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=9353, sleep=ms=>new Promise(r=>setTimeout(r,ms)), clients=[];
const app=spawn(path.join(root,'src-tauri/target/debug/qchat.exe'),[],{env:{...process.env,QCHAT_TEST_MODE:'1',QCHAT_TEST_PROFILE:path.join(process.env.LOCALAPPDATA,'com.qchat.app'),QCHAT_DEBUG_PORT:String(port)},windowsHide:true,stdio:'ignore'});
async function until(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(app.exitCode!==null)throw Error('App exited; quit other QChat instances.');const value=await fn();if(value)return value;await sleep(200);}throw Error('Timed out');}
async function connect(url){const ws=new WebSocket(url),pending=new Map();let id=0;ws.onmessage=e=>{const v=JSON.parse(e.data);pending.get(v.id)?.(v);pending.delete(v.id);};await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});const call=async(method,params={})=>{const n=++id,p=new Promise(r=>pending.set(n,r));ws.send(JSON.stringify({id:n,method,params}));const v=await p;if(v.error)throw Error('Browser operation failed');return v.result;};const evaluate=async expression=>{const v=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw Error('Page operation failed');return v.result?.value;};const client={call,evaluate,close:()=>ws.close()};clients.push(client);return client;}
let ui,site,failed=false;
try{
  const pages=await until(async()=>{try{const p=await(await fetch(`http://127.0.0.1:${port}/json`)).json();return p.some(v=>v.url.includes('tauri.localhost'))&&p.some(v=>v.url.includes('chatgpt.com'))?p:null;}catch{return null;}});
  ui=await connect(pages.find(p=>p.url.includes('tauri.localhost')).webSocketDebuggerUrl);site=await connect(pages.find(p=>p.url.includes('chatgpt.com')).webSocketDebuggerUrl);
  await until(()=>ui.evaluate(`document.getElementById('status-label')?.textContent==='Ready'`),60000);
  await site.evaluate(`window.__imageBaseline=new Set(document.querySelectorAll('img,[data-dil-source-message-id],[data-message-author-role]'));window.__imagePhases=[];window.__imageObserver=new MutationObserver(()=>{const nodes=[...document.querySelectorAll('[role="progressbar"],progress,[data-testid*="image"],[data-d-component*="image"],[data-dil-source-message-id] span,[data-dil-source-message-id] p')].filter(n=>!window.__imageBaseline.has(n)&&n.getClientRects().length&&!n.closest('[hidden],[aria-hidden="true"]'));for(const n of nodes){const text=n.innerText||'';const p=n.getAttribute('aria-valuenow')||n.getAttribute('value')||(/(?:^|\\s)(\\d{1,3})%/.exec(text)||[])[1];const label=n.getAttribute('aria-label')||'';if(!p&&!/creat.*image|generat.*image|image.*creat/i.test(text+' '+label))continue;const value={tag:n.tagName,component:n.getAttribute('data-d-component'),testid:n.getAttribute('data-testid'),role:n.getAttribute('role'),percentage:p||null,label:label.slice(0,80),text:text.slice(0,80)};const key=JSON.stringify(value);if(!window.__imagePhases.some(v=>JSON.stringify(v)===key)&&window.__imagePhases.length<50)window.__imagePhases.push(value);}});window.__imageObserver.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});`);
  await ui.evaluate(`window.__imageEvents=[];window.__TAURI__.event.listen('bridge',({payload:e})=>{if(e.id)window.__imageEvents.push({type:e.type,id:e.id,items:e.items,percentage:e.percentage,state:e.state});});document.getElementById('prompt-input').value='Generate an image: a simple bright blue circle centered on a plain white square background. No text. Please create the actual image.';document.getElementById('prompt-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click();`);
  console.log('PASS saved-account image generation started');
  mkdirSync(path.join(root,'dist/qa'),{recursive:true});
  await until(()=>ui.evaluate(`!!document.querySelector('.image-generation:not([hidden])')`),5000);
  const preparing=await ui.call('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(root,'dist/qa/image-generation.png'),Buffer.from(preparing.data,'base64'));
  console.log('PASS image generation graphic is visible while preparing');
  if(process.argv.includes('--inspect')) {
    await sleep(4000);
    console.log('Early response structure:',JSON.stringify(await site.evaluate(`[...document.querySelectorAll('[data-chatgpt-search-message-ids],[data-dil-source-message-id],[data-message-author-role="assistant"],[role="progressbar"],progress')].filter(n=>!window.__imageBaseline.has(n)).map(n=>({tag:n.tagName,attrs:[...n.attributes].map(a=>a.name),text:n.innerText?.slice(0,150),children:[...n.querySelectorAll('svg,canvas,[role="status"],[aria-label]')].slice(0,10).map(c=>({tag:c.tagName,label:c.getAttribute('aria-label'),cls:String(c.className).slice(0,120)}))}))`)));
    const clip=await site.evaluate(`(()=>{const r=(document.querySelector('main')||document.body).getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.max(1,r.width),height:Math.max(1,r.height),scale:1}})()`);
    const snap=await site.call('Page.captureScreenshot',{format:'png',clip});writeFileSync(path.join(root,'dist/qa/site-generation.png'),Buffer.from(snap.data,'base64'));
  }
  const control=await until(()=>site.evaluate(`(()=>{const n=document.querySelector('[data-testid="generated-image-preview"]');if(!n)return null;const ancestors=[];for(let p=n;p&&ancestors.length<12;p=p.parentElement)ancestors.push({tag:p.tagName,attrs:[...p.attributes].map(a=>a.name),component:p.getAttribute('data-d-component'),testid:p.getAttribute('data-testid'),role:p.getAttribute('role'),cls:String(p.className).slice(0,160)});return {ancestors,children:[...n.querySelectorAll('*')].slice(0,25).map(c=>({tag:c.tagName,attrs:[...c.attributes].map(a=>a.name),cls:String(c.className).slice(0,160),width:c.naturalWidth||0,bg:getComputedStyle(c).backgroundImage.startsWith('url('),hidden:c.hidden}))};})()`),180000);
  if(process.argv.includes('--inspect')) console.log('Generated-image control:',JSON.stringify(control));
  let image;
  try{image=await until(()=>site.evaluate(`(()=>{const control=document.querySelector('[data-testid="generated-image-preview"]');const nodes=control?[control,...control.querySelectorAll('*')]:[];for(const n of nodes){const bg=getComputedStyle(n).backgroundImage;const src=n.currentSrc||n.src||(/^url\\(["']?(.*?)["']?\\)$/.exec(bg)||[])[1];if(!src)continue;const u=new URL(src,location.href);return {tag:n.tagName,width:n.naturalWidth||n.clientWidth,height:n.naturalHeight||n.clientHeight,protocol:u.protocol,host:u.hostname,path:u.protocol==='https:'?u.pathname.replace(/[a-z0-9_-]{24,}/gi,'<id>'):null,hidden:n.hidden};}return null;})()`),180000);}catch{console.log('Image not mounted before deadline');}
  if(process.argv.includes('--inspect')) {console.log('Image structure:',JSON.stringify(image));console.log('Generation controls:',JSON.stringify(await site.evaluate('window.__imagePhases')));}
  if(!image)throw Error('Generated site image unavailable');
  await until(()=>ui.evaluate(`document.querySelector('.media-preview img')?.naturalWidth>=128`),60000);
  console.log('PASS generated image renders in QChat');
  const progress=await ui.evaluate(`window.__imageEvents.some(e=>e.type==='image_progress'&&e.state==='generating')`);
  console.log(`${progress?'PASS':'FAIL'} real generation progress reaches QChat`);if(!progress)failed=true;
  await until(()=>ui.evaluate(`document.querySelector('[data-role="assistant"]')?.dataset.status==='done'`),60000);
  const clean=await ui.evaluate(`! /^(?:Loading images?[.…]*|Edit)$/i.test(document.querySelector('[data-role="assistant"] .turn-content')?.textContent.trim()||'')`);
  if(!clean)throw Error('Image placeholder remained after completion');
  await ui.evaluate(`document.querySelector('.media-card .image-copy').click()`);
  await until(()=>ui.evaluate(`document.querySelector('.media-card .image-copy')?.textContent==='Copied'`),15000);
  console.log('PASS generated image copies to native Windows clipboard');
  mkdirSync(path.join(root,'dist/qa'),{recursive:true});
  const screenshot=await ui.call('Page.captureScreenshot',{format:'png'});writeFileSync(path.join(root,'dist/qa/image-preview.png'),Buffer.from(screenshot.data,'base64'));
  await ui.evaluate(`(async()=>{const source=document.querySelector('.media-preview img');const blob=await(await fetch(source.src)).blob();const data=new DataTransfer();data.items.add(new File([blob],'qchat-upload-preview.png',{type:blob.type}));const input=document.getElementById('attachment-input');input.files=data.files;input.dispatchEvent(new Event('change'));})()`);
  await until(()=>ui.evaluate(`document.querySelector('#attachments [data-state="ready"] img')?.naturalWidth>=128`));
  console.log('PASS selected upload has a real image thumbnail');
  await ui.evaluate(`document.querySelector('#attachments .image-copy').click()`);
  await until(()=>ui.evaluate(`document.querySelector('#attachments .image-copy')?.textContent==='Copied'`),15000);
  console.log('PASS uploaded image copies to native Windows clipboard');
  await ui.evaluate(`document.getElementById('prompt-input').value='What color is the circle in the attached image? Reply with only the color.';document.getElementById('prompt-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click();`);
  await until(()=>ui.evaluate(`document.querySelector('.uploaded-image img')?.naturalWidth>=128`));
  await until(()=>ui.evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-role="assistant"]')];return rows.length===2&&rows.at(-1).dataset.status==='done'&&/blue/i.test(rows.at(-1).textContent);})()`),90000);
  console.log('PASS sent image stays visible and ChatGPT reads the uploaded image');
}catch(e){failed=true;console.log('FAIL image check:',String(e.message).slice(0,120));}
finally{if(ui)try{await ui.evaluate(`window.__TAURI__.core.invoke('quit_app')`);}catch{}clients.forEach(c=>c.close());await Promise.race([new Promise(r=>app.once('exit',r)),sleep(1500)]);if(app.pid&&app.exitCode===null)spawnSync('taskkill.exe',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}
process.exitCode=failed?1:0;
