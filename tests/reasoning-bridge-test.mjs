// Synthetic semantic DOM fixtures. No profile, credentials or network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src-tauri/bridge/chatgpt-bridge.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  let reasoningSelection ='),source.indexOf('  window.__qchat = {'));
async function run(effort,{missing=false,ambiguous=false,unsupported=false,cancel=false,unverified=false,disabled=false,current=false,modern=false,detached=false,slider=false}={}){
 let opened=false,selected=current||modern?'Medium':'Standard',clicks=0,failures=[],waits=0;
 const job={};
 const node=(text,attrs={})=>({textContent:text,innerText:text,getClientRects:()=>[{}],closest:()=>null,getAttribute:k=>attrs[k]??null,dispatchEvent(){},focus(){}});
 const control=node(modern?'Medium':'Thinking time');control.getAttribute=k=>k==='aria-expanded'?String(opened):k==='aria-controls'?'thinking-menu':null;
 control.dispatchEvent=e=>{if(e.key==='ArrowDown')opened=true;if(e.key==='Escape')opened=false;};control.disabled=disabled;control.click=()=>{opened=!opened;};
 const options=(unsupported?[current||modern?'Medium':'Standard']:current?['Instant','Medium','High','Extra High','Pro']:modern?['Low','Medium','High']:['Light','Standard','Extended']).map(text=>{const n=node(text);n.getAttribute=k=>k==='aria-checked'?String(selected===text):null;n.click=()=>{clicks++;if(!unverified)selected=text;if(detached){n.isConnected=false;opened=false;}};return n;});
 const group=node('Thinking');group.querySelectorAll=()=>slider?[]:options;const menu=node('');menu.querySelectorAll=selector=>selector.includes('data-reasoning-slider')?[]:current?[group]:slider?[]:options;menu.dispatchEvent=control.dispatchEvent;
 const area={querySelectorAll:()=>missing||current?[]:ambiguous?[control,control]:[control]};
 const ctx=vm.createContext({active:job,composerArea:()=>area,document:{querySelectorAll:()=>current?[control]:[],getElementById:id=>id==='thinking-menu'?menu:null},KeyboardEvent:class{constructor(_,args){Object.assign(this,args);}},sleep:async()=>{waits++;if(cancel)job.cancelled=true;},fail:(_,code)=>failures.push(code)});
 vm.runInContext(helper+'\nglobalThis.select=selectReasoning;',ctx);
 const result=await ctx.select(job,{},effort);
 assert.equal(opened,false,'owned menu closes');
 if(cancel){assert.equal(result,false);assert.equal(clicks,0);assert.deepEqual(failures,[]);}
 return {result,selected,clicks,failures};
}
for(const [effort,label] of [['low','Light'],['medium','Standard'],['high','Extended']]){const r=await run(effort);assert.equal(r.result,true);assert.equal(r.selected,label);}
assert.equal((await run(undefined)).clicks,0);
assert.equal((await run('medium',{missing:true})).result,true);
for(const config of [{missing:true},{ambiguous:true},{unsupported:true},{unverified:true},{disabled:true}]){const r=await run('high',config);assert.equal(r.result,false);assert.deepEqual(r.failures,['reasoning_unavailable']);}
await run('high',{cancel:true});
for(const config of [{current:true},{modern:true}]) {
 for(const [effort,label] of [['low',config.current?'Instant':'Low'],['medium','Medium'],['high','High']]) {
  const r=await run(effort,config);assert.equal(r.result,true);assert.equal(r.selected,label);
 }
 await run('low',{...config,cancel:true});
 assert.equal((await run('high',{...config,unsupported:true})).result,false);
 assert.equal((await run('high',{...config,detached:true})).result,false);
}
assert.equal((await run('high',{current:true,slider:true})).result,false,'unmapped numeric slider rejected');
assert.equal((await run('extra-high',{current:true})).result,false);

// Captured signed-in menu: Power is the keyboard target and its linked live
// status provides the label/position. The visual numeric slider is aria-hidden.
async function runPower(effort,{start=1,frozen=false,badStatus=false,cancelAfterKey=false,disabled=false}={}) {
 let opened=false,index=start,keys=0;const failures=[];const job={};
 const node=(text='')=>({textContent:text,isConnected:true,getClientRects:()=>[{}],closest:()=>null,focus(){},getAttribute:()=>null});
 const control=node();control.getAttribute=k=>k==='aria-expanded'?String(opened):k==='aria-controls'?'menu':null;
 control.dispatchEvent=e=>{if(e.key==='ArrowDown')opened=true;if(e.key==='Escape')opened=false;};control.click=()=>{opened=!opened;};
 const status=node();status.getAttribute=k=>k==='role'?'status':null;
 Object.defineProperty(status,'textContent',{get:()=>badStatus?'High, 2 of 3.':`${['Instant','Medium','High'][index]}, ${index+1} of 3.`});
 const power=node();power.getAttribute=k=>k==='aria-describedby'?'level help':k==='aria-disabled'?String(disabled):null;
 power.dispatchEvent=e=>{keys++;if(cancelAfterKey)job.cancelled=true;if(!frozen)index=Math.max(0,Math.min(2,index+(e.key==='ArrowRight'?1:-1)));};
 const menu=node();menu.contains=n=>n===status;menu.querySelectorAll=selector=>selector.includes('data-reasoning-slider')?[power]:[];menu.dispatchEvent=control.dispatchEvent;
 const ctx=vm.createContext({active:job,composerArea:()=>({querySelectorAll:()=>[]}),document:{querySelectorAll:()=>[control],getElementById:id=>id==='menu'?menu:id==='level'?status:null},KeyboardEvent:class{constructor(_,v){Object.assign(this,v);}},sleep:async()=>{},fail:(_,code)=>failures.push(code)});
 vm.runInContext(helper+'\nglobalThis.select=selectReasoning;',ctx);
 const result=await ctx.select(job,{},effort);
 assert.equal(opened,false,'Power menu closes');
 return {result,index,keys,failures};
}
for(const [effort,index] of [['low',0],['medium',1],['high',2]]) {
 for(const start of [0,1,2]) {const r=await runPower(effort,{start});assert.equal(r.result,true);assert.equal(r.index,index);assert.equal(r.keys,Math.abs(start-index));}
}
for(const config of [{frozen:true},{badStatus:true},{disabled:true}]) {const r=await runPower('high',config);assert.equal(r.result,false);assert.deepEqual(r.failures,['reasoning_unavailable']);}
const cancelledPower=await runPower('high',{cancelAfterKey:true});assert.equal(cancelledPower.result,false);assert.deepEqual(cancelledPower.failures,[]);

// Ensure invalid native IPC is rejected before page creation/attachments, and
// bridge callers are also validated before starting a job.
const rust=readFileSync(new URL('../src-tauri/src/main.rs',import.meta.url),'utf8');
assert.match(rust,/reasoning_effort: Option<String>/);
assert.match(rust,/validate_reasoning_effort\(reasoning_effort.as_deref\(\)\)\?;\s*chat_page/);
assert.match(rust,/"reasoningEffort":reasoning_effort/);
assert.match(source,/if \(reasoningEffort != null && !\['low', 'medium', 'high'\].includes\(reasoningEffort\)\)/);
assert.ok(source.indexOf('await selectReasoning(job, composer, reasoningEffort)')<source.indexOf('composer.focus();',source.indexOf('async send(')));
console.log('ALL PASS: actual control selection, verified state, missing/ambiguous/unsupported/disabled controls, cancellation, optional IPC validation');
