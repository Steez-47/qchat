import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile=await mkdtemp(path.join(tmpdir(),'qchat-temp-bridge-'));
const browser=spawn(process.env.QCHAT_TEST_EDGE||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let ws, count=0;
try {
 let port; for(let i=0;i<100&&!port;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])}catch{} if(!port) await sleep(100)}
 const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json(); ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl); await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
 let n=0; const pending=new Map();
 const cdp=(method,params={})=>new Promise((ok,no)=>{const id=++n;pending.set(id,{ok,no});ws.send(JSON.stringify({id,method,params}))});
 ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.no(Error(m.error.message)):p.ok(m.result)}} else if(m.method==='Fetch.requestPaused'){cdp('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<!doctype html><html><body></body></html>').toString('base64')}).catch(()=>{})}};
 await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Fetch.enable',{patterns:[{urlPattern:'*'}]});
 const ev=async expr=>{const r=await cdp('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const check=async(name,expr)=>{assert.equal(await ev(expr),true,name);console.log('PASS '+name);count++};
 for(const provider of (process.argv.includes('--gemini-only') ? ['gemini'] : ['chatgpt','gemini'])){
  const url=provider==='chatgpt'?'https://chatgpt.com/?temporary-chat=true':'https://gemini.google.com/app';
  await cdp('Page.navigate',{url}); await sleep(400);
  const html=provider==='chatgpt'?'<textarea id="prompt-textarea"></textarea><input type="file" multiple>':'<button aria-label="Google Account: test">account</button><chat-window class="is-temporary-chat"><rich-textarea><div contenteditable="true"></div></rich-textarea></chat-window><input type="file" multiple>';
  await ev(`document.body.innerHTML=${JSON.stringify(html)};window.__events=[];window.__QCHAT_EMIT__=e=>__events.push(e);window.__fileEvents=0;document.querySelector('input').addEventListener('change',()=>__fileEvents++);`);
  await ev(await readFile(new URL('../ui/response-tags.js',import.meta.url),'utf8'));
  const src=await readFile(new URL(`../src-tauri/bridge/${provider}-bridge.js`,import.meta.url),'utf8'); await ev(src);
  if(provider==='chatgpt') {
    await check('chatgpt query without active marker fails closed', '__qchat.temporaryReady()===false');
    await check('chatgpt unconfirmed query rejects send', `(async()=>{await __qchat.send({id:'unconfirmed',prompt:'secret',temporary:true});return __events.some(e=>e.id==='unconfirmed'&&e.code==='temporary_unavailable')&&document.querySelector('#prompt-textarea').value===''})()`);
    await check('chatgpt normal offering is not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<button aria-label="Temporary chat">Temporary chat</button>');return !__qchat.temporaryReady()})()`);
    await check('chatgpt hidden control is not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<div hidden><button aria-label="Turn off temporary chat"></button></div>');return !__qchat.temporaryReady()})()`);
    await check('chatgpt CSS hidden ancestor is not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<div style="visibility:hidden"><button style="visibility:visible" aria-label="Turn off temporary chat"></button></div>');return !__qchat.temporaryReady()})()`);
    await check('chatgpt detached control is not confirmation', `(()=>{const b=document.createElement('button');b.setAttribute('aria-label','Turn off temporary chat');return !b.isConnected&&!__qchat.temporaryReady()})()`);
    await check('chatgpt control embedded in message is not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<article><button aria-label="Turn off temporary chat"></button></article>');return !__qchat.temporaryReady()})()`);
    await check('chatgpt control inside a turn is not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<div data-turn-key="old"><button aria-label="Turn off temporary chat"></button></div>');return !__qchat.temporaryReady()})()`);
    await check('chatgpt dialog and menu controls are not confirmation', `(()=>{document.body.insertAdjacentHTML('beforeend','<div role="dialog"><button aria-label="Turn off temporary chat"></button></div><div role="menu"><button aria-label="Turn off temporary chat"></button></div>');return !__qchat.temporaryReady()})()`);
    await ev(`document.body.insertAdjacentHTML('beforeend','<button id="temp-control" aria-label="Turn off temporary chat">Temporary</button>')`);
    await check('chatgpt active control on wrong URL is not confirmation', `(()=>{history.replaceState({},'', '/');const ok=!__qchat.temporaryReady();history.replaceState({},'', '/?temporary-chat=true');return ok})()`);
    await check('chatgpt visibility-hidden composer is not confirmation', `(()=>{const c=document.querySelector('#prompt-textarea');c.style.visibility='hidden';const ok=!__qchat.temporaryReady();c.style.visibility='';return ok})()`);
    await check('chatgpt hidden composer is not confirmation', `(()=>{const c=document.querySelector('#prompt-textarea');c.hidden=true;const ok=!__qchat.temporaryReady();c.hidden=false;return ok})()`);
  }
  await check(`${provider} verified mode`, '__qchat.temporaryReady()===true');
  await check(`${provider} detached stage and binary commit`, `(async()=>{const d=await __qchat.stageTemporaryFiles('a');const t=new DataTransfer();t.items.add(new File([new Uint8Array([0,128,255,17])],'x.bin'));d.files=t.files;return !d.isConnected&&__qchat.commitTemporaryFiles('a')&&__fileEvents===1&&Array.from(new Uint8Array(await document.querySelector('input').files[0].arrayBuffer())).join(',')==='0,128,255,17'})()`);
  await ev(`document.querySelector('input').value='';__fileEvents=0`);
  const lose=provider==='chatgpt'?"document.querySelector('#temp-control').hidden=true":"document.querySelector('chat-window').classList.remove('is-temporary-chat')";
  const restore=provider==='chatgpt'?"document.querySelector('#temp-control').hidden=false":"document.querySelector('chat-window').classList.add('is-temporary-chat')";
  await check(`${provider} mode loss blocks commit`, `(async()=>{const d=await __qchat.stageTemporaryFiles('b');const t=new DataTransfer();t.items.add(new File(['secret'],'x'));d.files=t.files;${lose};return !__qchat.commitTemporaryFiles('b')&&__fileEvents===0&&document.querySelector('input').files.length===0})()`);
  await check(`${provider} send rejects unknown mode`, `(async()=>{await __qchat.send({id:'bad',prompt:'secret',temporary:true});return __events.some(e=>e.id==='bad'&&e.code==='temporary_unavailable')&&document.querySelector('${provider==='chatgpt'?'#prompt-textarea':'[contenteditable]'}').textContent===''})()`);
  await ev(restore);
  await ev(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(provider==='chatgpt'?'<button id="fixture-send" data-testid="send-button">Send</button>':'<button id="fixture-send" aria-label="Send message">Send</button>')});window.__clicks=0;document.querySelector('#fixture-send').addEventListener('click',()=>__clicks++);`);
  await check(`${provider} mode loss during delayed send prevents submission`, `(async()=>{const b=document.querySelector('#fixture-send');b.disabled=true;const p=__qchat.send({id:'delayed',prompt:'synthetic safe text',temporary:true});await new Promise(r=>setTimeout(r,30));${lose};b.disabled=false;await p;await new Promise(r=>setTimeout(r,150));const ok=__clicks===0&&__events.some(e=>e.id==='delayed'&&e.code==='temporary_unavailable');${restore};if(!ok) throw Error(JSON.stringify({clicks:__clicks,events:__events.filter(e=>e.id==='delayed')}));return ok})()`);
  await check(`${provider} confirmed temporary send reaches composer and button`, `(async()=>{await Promise.race([__qchat.send({id:'good',prompt:'synthetic safe text',temporary:true}),new Promise((_,reject)=>setTimeout(()=>reject(Error('send timeout')),3000))]);const ok=__clicks===1;__qchat.stop();await new Promise(r=>setTimeout(r,150));return ok})()`);
  await check(`${provider} cancelled staging rejects stale commit`, `(async()=>{await __qchat.stageTemporaryFiles('c');__qchat.clearTemporaryStage('c');return !__qchat.commitTemporaryFiles('c')&&__fileEvents===0})()`);
  await check(`${provider} replaced input rejects commit`, `(async()=>{await __qchat.stageTemporaryFiles('d');const el=document.querySelector('input');el.replaceWith(el.cloneNode());return !__qchat.commitTemporaryFiles('d')&&__fileEvents===0})()`);
  await check(`${provider} late attachment mode loss keeps temporary error`, `(async()=>{const p=__qchat.send({id:'file-loss',prompt:'synthetic',attachmentCount:1,temporary:true});await new Promise(r=>setTimeout(r,30));${lose};await p;await new Promise(r=>setTimeout(r,250));const ok=__clicks===1&&__events.some(e=>e.id==='file-loss'&&e.code==='temporary_unavailable');${restore};return ok})()`);
  // Start a fresh page after a simulated uncleared provider attachment.
  await ev(`window.__qchat.cancelAttachmentSelection(0)`);
  if(provider==='gemini'){
   await check('gemini hidden host rejects',`(()=>{const h=document.querySelector('chat-window');h.hidden=true;const ok=!__qchat.temporaryReady();h.hidden=false;return ok})()`);
   await check('gemini guest rejects',`(()=>{const a=document.querySelector('[aria-label^="Google Account"]');a.hidden=true;const ok=!__qchat.temporaryReady();a.hidden=false;return ok})()`);
   await check('gemini wrong host rejects',`(()=>{const h=document.querySelector('chat-window');h.classList.remove('is-temporary-chat');document.body.insertAdjacentHTML('beforeend','<chat-window class="is-temporary-chat">Temporary chat</chat-window>');return !__qchat.temporaryReady()})()`);
  }
 }
 console.log(`ALL PASS (${count})`);
} finally {if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({id:999999,method:'Browser.close'}));ws?.close();if(browser.pid&&browser.exitCode===null)spawnSync('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{})}
