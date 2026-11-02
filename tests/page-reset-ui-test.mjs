// A provider page that reloads mid-reply forgets the reply, so no terminal event will ever come.
// The UI must notice from the page's load id instead of waiting on a reply that can't finish.
// Mock backend only, in an invisible Edge profile: no account, site access or OS-level input.
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
  browserPage = await openPage('page-reset-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const waitFor = async (expr, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(`!!(${expr})`)) return true; } catch {}
      await sleep(10);
    }
    return false;
  };
  const open = async () => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await waitFor(`document.readyState==='complete'`);
    await evalJS(`localStorage.clear()`);
    await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(JSON.stringify({ v: 4, animations: 'off', autoDismiss: 0, streamStyle: 'instant' }))})`);
    await cdp('Page.navigate', { url: `${base}/?mock=signedin` });
    await waitFor(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
  };
  const status = (loadId, provider = 'chatgpt') => evalJS(`__mock.emit('bridge',{type:'status',provider:${JSON.stringify(provider)},loadId:${JSON.stringify(loadId)},ready:true,loggedIn:true})`);
  const ask = async (prompt) => {
    await evalJS('window.__mock.hold=true');
    await evalJS(`(()=>{const i=document.getElementById('prompt-input');i.focus();i.value=${JSON.stringify(prompt)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
    await waitFor(`__mock.last('chat_send')`);
    await sleep(40);
    return evalJS(`__mock.last('chat_send').args.id`);
  };
  const row = "document.querySelector('[data-role=assistant]')";

  // Nothing streamed yet: the prompt comes back so nothing is lost.
  await open();
  await status('load-a');
  let id = await ask('keep this prompt');
  await status('load-a');
  await sleep(40);
  check('a status from the same load leaves the reply running', await evalJS(`${row}?.dataset.status==='streaming'`));
  const stopsBefore = await evalJS(`__mock.count('chat_stop')`);
  await status('load-b');
  check('a new load ends the reply', await waitFor(`${row}?.dataset.status==='error'`, 2000), await evalJS(`${row}?.dataset.status`));
  check('the user is told why', await evalJS(`${row}?.textContent.includes('reloaded before it finished')`), await evalJS(`${row}?.textContent`));
  check('the backend flight is released', (await evalJS(`__mock.count('chat_stop')`)) > stopsBefore);
  check('the prompt returns to the composer', (await evalJS(`document.getElementById('prompt-input').value`)) === 'keep this prompt', await evalJS(`document.getElementById('prompt-input').value`));
  check('the composer is ready to send', await evalJS(`document.getElementById('btn-send').dataset.mode!=='stop'`));

  // Part of the reply arrived: it stays on screen.
  await open();
  await status('load-a');
  id = await ask('partial');
  await evalJS(`__mock.emit('bridge',{type:'delta',id:${JSON.stringify(id)},text:'Kept so far.\\n\\n'})`);
  await waitFor(`${row}?.textContent.includes('Kept so far.')`);
  await status('load-b');
  check('a partial reply survives the reset', await waitFor(`${row}?.dataset.status==='error' && ${row}.textContent.includes('Kept so far.')`, 2000), await evalJS(`${row}?.textContent`));

  // Late events from the lost job can't reopen it.
  await evalJS(`__mock.emit('bridge',{type:'delta',id:${JSON.stringify(id)},text:'STALE'})`);
  await sleep(40);
  check('late events don\'t reopen the reply', await evalJS(`${row}?.dataset.status==='error' && !${row}.textContent.includes('STALE')`));

  // A reply that finishes with nothing in it is a failure the user can act on.
  await open();
  await status('load-a');
  id = await ask('empty reply');
  await evalJS(`__mock.emit('bridge',{type:'done',id:${JSON.stringify(id)},text:''})`);
  check('an empty finished reply reports an error', await waitFor(`${row}?.dataset.status==='error'`, 2000), await evalJS(`${row}?.dataset.status`));
  check('an empty finished reply returns the prompt', (await evalJS(`document.getElementById('prompt-input').value`)) === 'empty reply', await evalJS(`document.getElementById('prompt-input').value`));

  // A finished reply and a page that reloads later have nothing to do with each other.
  await open();
  await status('load-a');
  id = await ask('finished');
  await evalJS(`__mock.emit('bridge',{type:'done',id:${JSON.stringify(id)},text:'All done.'})`);
  await waitFor(`${row}?.dataset.status==='done'`);
  await status('load-b');
  await sleep(40);
  check('a reload after the reply finished changes nothing', await evalJS(`${row}?.dataset.status==='done' && ${row}.textContent.includes('All done.')`));

  // Older bridges and early pages report no load id, which proves nothing.
  await open();
  await evalJS(`__mock.emit('bridge',{type:'status',provider:'chatgpt',ready:true,loggedIn:true})`);
  await ask('no id');
  await status('load-first');
  await sleep(40);
  check('the first load id seen isn\'t mistaken for a reload', await evalJS(`${row}?.dataset.status==='streaming'`));

  // The other provider's page reloading is not this reply's problem.
  await open();
  await status('load-a');
  await ask('other provider');
  await status('gemini-load', 'gemini');
  await sleep(40);
  check('the other provider reloading leaves the reply running', await evalJS(`${row}?.dataset.status==='streaming'`));

  check('no runtime or CSP errors', problems.length === 0, problems.join(' | '));
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
