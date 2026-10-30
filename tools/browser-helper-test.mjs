import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../browser-helper/helper.js',import.meta.url),'utf8');
const {target,transfer,filterCookies}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const url='http://127.0.0.1:43210/qchat-connect#'+'a'.repeat(64);
const cookie={name:'__Secure-authjs.session-token',value:'synthetic',domain:'.chatgpt.com',path:'/'};
assert.throws(()=>target('https://example.com/'));assert.throws(()=>target(url+'?bad'));
assert.equal(filterCookies([cookie,{...cookie,domain:'evil.com'},{...cookie,name:'other'},{...cookie,path:'/x'}]).length,1);
for(const scenario of ['consent','target','denied','empty','failure','success']){
 let reads=0,requests=0,releases=0,posts=0;
 const api={permissions:{request:async()=>{requests++;return scenario!=='denied'},remove:async()=>{releases++}},cookies:{getAll:async()=>{reads++;return scenario==='empty'?[]:[cookie]}}};
 const fetcher=async(u,o)=>{posts++;assert.equal(u,url.split('#')[0]);assert.equal(o.credentials,'omit');assert.equal(o.cache,'no-store');assert.equal(o.redirect,'error');return {ok:scenario!=='failure'}};
 if(scenario==='success') assert.match(await transfer(api,fetcher,url,true),/copied/);
 else await assert.rejects(transfer(api,fetcher,scenario==='target'?'https://evil.com':url,scenario!=='consent'));
 if(['consent','target','denied'].includes(scenario))assert.equal(reads,0);
 if(['consent','target'].includes(scenario))assert.equal(requests,0);
 assert.equal(releases,1);assert.equal(posts,['success','failure'].includes(scenario)?1:0);
}
assert(!/console\./.test(source));console.log('PASS: synthetic consent, target, filtering, denied permissions, transfer and cleanup');
