// Inspect an explicitly supplied hidden test page. --select-levels verifies the
// production selector on the site's real controls, restores the starting level,
// and never sends a chat. No profile copy, launch, credentials or chat contents.
import {readFileSync} from 'node:fs';
const selectLevels=process.argv.includes('--select-levels');
const port = process.env.QCHAT_REASONING_DEBUG_PORT;
if (!port || !/^\d+$/.test(port)) {
 console.error('LIVE LIMIT: Set QCHAT_REASONING_DEBUG_PORT for an existing hidden test instance. No profile copy or launch attempted.');
 process.exitCode=1;
} else {
 let socket;
 try {
  const pages=await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page=pages.find(p=>{try{return new URL(p.url).hostname==='chatgpt.com';}catch{return false;}});
  if(!page) throw Error('No ChatGPT page in supplied test instance');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  const source=readFileSync(new URL('../../src-tauri/bridge/chatgpt-bridge.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('  let reasoningSelection ='),source.indexOf('  window.__qchat = {'));
  const selection=String.raw`(async()=>{
    const trigger=()=>document.querySelector('button[aria-label="Select ChatGPT model"]');
    const labels={Instant:'low',Light:'low',Low:'low',Standard:'medium',Medium:'medium',Extended:'high',High:'high'};
    const original=labels[trigger()?.innerText.trim().split('\n').at(-1)];
    if(!original)throw Error('Cannot identify original thinking level; nothing changed');
    if(trigger().getAttribute('aria-expanded')==='true')throw Error('Close the existing menu before verifying');
    let active;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const composer=()=>document.querySelector('#prompt-textarea, form .ProseMirror[role="textbox"]');
    const composerArea=()=>composer()?.closest('form')||composer()?.parentElement?.parentElement;
    const fail=(job,code)=>{job.failure=code;};
    ${helper}
    const results=[];
    try{for(const effort of ['low','medium','high','low','high']){
      const job=active={};const ok=await selectReasoning(job,composer(),effort);
      const label=trigger()?.innerText.trim().split('\n').at(-1);
      results.push({effort,ok,label,closed:trigger()?.getAttribute('aria-expanded')!=='true',failure:job.failure});
      if(!ok||labels[label]!==effort)throw Error('Could not verify '+effort);
    }}finally{
      const job=active={};if(!await selectReasoning(job,composer(),original))throw Error('Could not restore original thinking level');
    }
    return {results,restored:labels[trigger()?.innerText.trim().split('\n').at(-1)]===original};
  })()`;
  const result=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Inspection timed out')),45000);
   socket.onmessage=({data})=>{const m=JSON.parse(data);if(m.id===1){clearTimeout(timer);if(m.result?.exceptionDetails)reject(Error(m.result.exceptionDetails.exception?.description||m.result.exceptionDetails.text));else resolve(m.result?.result?.value);}};
   socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{returnByValue:true,awaitPromise:true,expression:selectLevels?selection:`(()=>{
    const c=document.querySelector('#prompt-textarea, form .ProseMirror[role="textbox"]');
    const area=c?.closest('form')||c?.closest('[data-testid="composer"]');
    const describe=n=>({role:n.getAttribute('role'),label:n.getAttribute('aria-label'),labelledby:n.getAttribute('aria-labelledby'),controls:n.getAttribute('aria-controls'),expanded:n.getAttribute('aria-expanded'),checked:n.getAttribute('aria-checked'),selected:n.getAttribute('aria-selected'),value:n.getAttribute('aria-valuetext')});
    return {composer:!!c,controls:[...(area?.querySelectorAll('button[aria-haspopup]')||[])].map(describe),modelControls:[...document.querySelectorAll('[data-testid="model-switcher-dropdown-button"],button[aria-label="Select ChatGPT model"]')].map(describe),thinking:[...document.querySelectorAll('[role="radiogroup"], [role="slider"]')].filter(n=>/^Thinking(?: time)?$/i.test(n.getAttribute('aria-label')||'')).map(n=>({...describe(n),options:[...n.querySelectorAll('[role="radio"]')].map(describe)}))};
   })()`}}));
  });
  console.log(JSON.stringify(result));
 } catch(error) {console.error('LIVE LIMIT: '+error.message);process.exitCode=1;}
 finally {socket?.close();}
}
