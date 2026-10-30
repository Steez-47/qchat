import {target,transfer} from './helper.js';
const consent=document.querySelector('#consent'), button=document.querySelector('#connect'), status=document.querySelector('#status');
let selected;
try { const [tab]=await chrome.tabs.query({active:true,currentWindow:true}); target(tab?.url); selected=tab.url; status.textContent='Review the warning, then confirm.'; } catch { status.textContent='Open a fresh QChat connect tab and open this helper from the toolbar.'; }
consent.onchange=()=>{button.disabled=!consent.checked||!selected;};
button.onclick=async()=>{button.disabled=true;let url=selected;selected=undefined;try {const pending=transfer(chrome,fetch,url,consent.checked);url=undefined;status.textContent=await pending;}catch(e){status.textContent=e.message;}finally{consent.checked=false;url=undefined;}};
