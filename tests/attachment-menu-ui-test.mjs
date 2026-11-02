// The add menu and its actions, in a private headless browser. No account or OS input.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, serveUI, sleep, root } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();
const problems = [];
let page, failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};
try {
  page = await openPage('attachment-menu', { problems });
  const { cdp, evalJS } = page;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 516, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  const until = async (expression) => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (await evalJS(`!!(${expression})`)) return;
      await sleep(15);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const $ = id => `document.getElementById(${JSON.stringify(id)})`;
  const click = id => evalJS(`${$(id)}.click()`);
  const pointerClick = async id => {
    const { x, y } = await evalJS(`(()=>{const r=${$(id)}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const press = async (key, code) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  };
  const open = () => click('btn-attach');
  const hidden = () => evalJS(`${$('attachment-menu')}.hidden`);
  const focus = () => evalJS(`document.activeElement.id`);
  const draft = () => evalJS(`${$('prompt-input')}.value`);
  const geometry = () => evalJS(`['bar','prompt-input'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})`);
  const shot = async name => {
    const dir = path.join(root, 'dist', 'qa-attachment-menu');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  };

  await cdp('Page.navigate', { url: `${base}/?mock=signedin` });
  await until(`window.__mock && ${$('btn-attach')}?.disabled===false && window.QSettings`);
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,animations:'off',idleCollapse:0,look:'graphite'});const input=${$('prompt-input')};input.value='Keep this draft';input.dispatchEvent(new Event('input',{bubbles:true}));input.setSelectionRange(2,7)`);
  await sleep(180);
  check('one plus button replaces both bar icons', await evalJS(`${$('btn-attach')}.textContent.trim()==='\uE710' && !${$('bar')}.contains(${$('btn-snapshot')}) && ${$('btn-attach')}.getAttribute('aria-haspopup')==='menu'`));
  check('menu starts closed', await hidden());
  await pointerClick('btn-attach');
  check('pointer opens the menu', !await hidden());
  await pointerClick('btn-attach');
  check('clicking plus again closes the focused menu', await hidden());
  const before = JSON.stringify(await geometry());
  await open();
  check('menu opens with image, selection and file actions', await evalJS(`!${$('attachment-menu')}.hidden && ${$('btn-attach')}.getAttribute('aria-expanded')==='true' && [...${$('attachment-menu')}.children].map(n=>n.lastElementChild.textContent).join('|')==='Add image|Add selection|Add file'`));
  check('opening preserves bar and input geometry', before === JSON.stringify(await geometry()));
  check('menu sits above the bar and inside the viewport', await evalJS(`(()=>{const m=${$('attachment-menu')}.getBoundingClientRect(),b=${$('bar')}.getBoundingClientRect();return m.bottom<b.top&&m.top>=0&&m.left>=0&&m.right<=innerWidth})()`));
  check('focus starts on image', await focus() === 'btn-snapshot');
  await press('ArrowDown', 40);
  check('down moves to selection', await focus() === 'btn-selection');
  await press('End', 35);
  check('end moves to file', await focus() === 'btn-file');
  await press('ArrowDown', 40);
  check('arrows wrap', await focus() === 'btn-snapshot');
  await press('Home', 36);
  await press('Escape', 27);
  check('escape dismisses only the menu and restores the plus focus', await hidden() && await focus() === 'btn-attach' && await evalJS(`__mock.count('hide_main')===0`));
  check('draft and caret survive menu navigation', await evalJS(`${$('prompt-input')}.value==='Keep this draft'&&${$('prompt-input')}.selectionStart===2&&${$('prompt-input')}.selectionEnd===7`));
  await press('ArrowUp', 38);
  check('up on plus opens at the last action', !await hidden() && await focus() === 'btn-file');
  await press('Tab', 9);
  check('tab closes the menu and moves focus to the composer controls', await hidden() && await evalJS(`!${$('attachment-menu')}.contains(document.activeElement)&&document.activeElement!==document.body`));
  await open();
  await evalJS(`${$('prompt-input')}.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));${$('prompt-input')}.focus()`);
  check('outside pointer dismisses the menu', await hidden());
  await open();
  await click('btn-reasoning');
  check('model picker dismisses the add menu', await hidden() && await evalJS(`!${$('picker')}.hidden`));
  await open();
  check('add menu dismisses the model picker', !await hidden() && await evalJS(`${$('picker')}.hidden`));

  await shot('dark.png');
  await click('btn-snapshot');
  await until(`__mock.count('attachment_finish')===1`);
  check('image action captures and stages an image without sending', await hidden() && await evalJS(`__mock.count('snapshot_capture')===1&&__mock.count('chat_send')===0&&!!document.querySelector('#attachments img')`));
  check('image capture preserves draft', await draft() === 'Keep this draft');
  await evalJS(String.raw`__mock.selectionText='  Selected <literal> text\nfrom another window.  '`);
  await open();
  await click('btn-selection');
  await until(`__mock.count('selection_capture')===1 && !${$('btn-attach')}.disabled`);
  check('selection action stages exact text without sending', await evalJS(`document.querySelector('#attachments .selection-chip')?.textContent.includes('Selected <literal> text')&&JSON.parse(localStorage.getItem('qchat.chats')).current.selectionTexts[0]===__mock.selectionText&&__mock.count('chat_send')===0`));
  check('selection preserves draft and caret', await evalJS(`${$('prompt-input')}.value==='Keep this draft'&&${$('prompt-input')}.selectionStart===2&&${$('prompt-input')}.selectionEnd===7`));
  await evalJS(`__mock.selectionError='No selected text was available.'`);
  await open();
  await click('btn-selection');
  await until(`!${$('global-error')}.hidden`);
  check('selection failures keep draft and existing attachments', await evalJS(`${$('global-error-text')}.textContent.includes('No selected text')&&${$('prompt-input')}.value==='Keep this draft'&&document.querySelectorAll('#attachments .selection-chip').length===1&&!!document.querySelector('#attachments img')`));
  await evalJS(`__mock.selectionError=null;window.fileOpens=0;${$('attachment-input')}.click=()=>fileOpens++`);
  await open();
  await click('btn-file');
  check('file action opens the existing multiple-file picker', await hidden() && await evalJS(`fileOpens===1&&${$('attachment-input')}.multiple&&!${$('attachment-input')}.accept`));
  await evalJS(`const data=new DataTransfer();data.items.add(new File(['hello'],'notes.txt',{type:'text/plain'}));${$('attachment-input')}.files=data.files;${$('attachment-input')}.dispatchEvent(new Event('change'))`);
  await until(`__mock.count('attachment_finish')===2`);
  check('file selection stages alongside image and selected text', await evalJS(`document.querySelectorAll('#attachments .attachment-chip:not(.selection-chip)').length===2&&document.querySelectorAll('#attachments .selection-chip').length===1&&${$('prompt-input')}.value==='Keep this draft'`));

  await evalJS(`window.originalInvoke=__TAURI__.core.invoke;__TAURI__.core.invoke=(cmd,args)=>cmd==='selection_capture'?new Promise(resolve=>window.releaseSelection=resolve):originalInvoke(cmd,args)`);
  await open();
  await click('btn-selection');
  await until(`window.releaseSelection`);
  check('pending selection blocks duplicate capture and sending', await evalJS(`${$('btn-attach')}.disabled&&${$('btn-send')}.disabled&&!${$('prompt-input')}.disabled`));
  await evalJS(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));releaseSelection('old selection');__TAURI__.core.invoke=originalInvoke`);
  await until(`!${$('btn-attach')}.disabled`);
  check('late selection cannot leak into a new chat', await evalJS(`!JSON.parse(localStorage.getItem('qchat.chats')).current.selectionTexts.length&&${$('attachments')}.hidden`));

  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,barWidth:340,look:'frost'});`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 396, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });
  await sleep(120);
  await open();
  check('narrow layout keeps all menu actions readable and within the viewport', await evalJS(`(()=>{const m=${$('attachment-menu')}.getBoundingClientRect(),b=${$('bar')};return m.left>=0&&m.right<=innerWidth&&b.scrollWidth<=b.clientWidth&&[...${$('attachment-menu')}.children].every(n=>n.scrollWidth<=n.clientWidth)})()`));
  await shot('light-narrow.png');
  await press('Escape', 27);
  await evalJS(`__mock.emit('qchat://settings-changed',{...QSettings.settings,showAttach:false})`);
  check('existing visibility setting hides the plus button', await evalJS(`getComputedStyle(${$('btn-attach')}).display==='none'`));
  check('no page errors', problems.length === 0);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await page?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
