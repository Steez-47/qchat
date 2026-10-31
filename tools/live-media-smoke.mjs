// Explicit opt-in: sends synthetic prompts/files using QChat's saved login.
// Does not read credentials, delete the saved profile, or show a window.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
if (process.argv[2] !== '--run-with-saved-profile') throw Error('Requires --run-with-saved-profile; this test sends synthetic messages to your ChatGPT account.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(process.env.LOCALAPPDATA, 'com.qchat.app');
const port = 9347;
const app = spawn(path.join(root, 'src-tauri/target/debug/qchat.exe'), [], {
  env: { ...process.env, QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_DEBUG_PORT: String(port) },
  stdio: 'ignore', windowsHide: true
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
let failures = 0, phase = 'startup', ui, site;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (app.exitCode !== null) throw Error('App exited; quit other QChat instances before using the saved-profile test.');
    const value = await fn(); if (value) return value; await sleep(150);
  }
  throw Error('Timed out');
}
async function cdp(url) {
  const ws = new WebSocket(url), pending = new Map(); let sequence = 0;
  ws.onmessage = event => { const value = JSON.parse(event.data); if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const evaluate = async expression => {
    const id = ++sequence, result = new Promise(resolve => pending.set(id, resolve));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const value = await result;
    if (value.error || value.result?.exceptionDetails) throw Error('Page operation failed');
    return value.result?.result?.value;
  };
  const client = { evaluate, close: () => ws.close() }; clients.push(client); return client;
}
function bluePNG() {
  const crc = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + 2] = 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
try {
  const pages = await until(async () => { try { const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return pages.some(p => p.url.includes('tauri.localhost')) && pages.some(p => p.url.includes('chatgpt.com')) ? pages : null; } catch { return null; } });
  ui = await cdp(pages.find(p => p.url.includes('tauri.localhost')).webSocketDebuggerUrl);
  site = await cdp(pages.find(p => p.url.includes('chatgpt.com')).webSocketDebuggerUrl);
  phase = 'saved account readiness';
  await until(() => ui.evaluate(`document.getElementById('status-label').textContent === 'Ready'`), 60000);
  check('saved account is authenticated and composer ready', true);
  await ui.evaluate(`window.__liveResults = {}; window.__TAURI__.event.listen('bridge', ({payload:e}) => { if (!e?.id?.startsWith('qchat-live-')) return; const r=window.__liveResults[e.id] ||= {text:'',media:[]}; if (typeof e.text === 'string') r.text=e.text; if(e.type==='media') r.media=e.items; if(e.type==='done'||e.type==='error'){r.terminal=e.type;r.code=e.code;} });`);
  const invoke = (command, args = {}) => ui.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
  let sequence = 0;
  async function ask(prompt, attachmentIds = []) {
    const id = `qchat-live-${++sequence}`;
    await invoke('chat_send', { id, prompt, attachmentIds });
    return until(() => ui.evaluate(`window.__liveResults[${JSON.stringify(id)}]?.terminal ? window.__liveResults[${JSON.stringify(id)}] : null`), 180000);
  }
  async function file(name, mime, bytes) {
    const { uploadGeneration } = await invoke('launch_info');
    const item = await invoke('attachment_begin', { name, mime, size: bytes.length, uploadGeneration });
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) await invoke('attachment_chunk', { id: item.id, offset, data: bytes.subarray(offset, offset + 512 * 1024).toString('base64') });
    await invoke('attachment_finish', { id: item.id }); return item.id;
  }
  let result;
  if (!process.argv.includes('--file-only')) {
    phase = 'Unicode response';
    result = await ask('Write 12 numbered short lines. Each line must contain 😊 👨‍👩‍👧‍👦 👍🏽 🇳🇿 followed by its number. End with QCHAT_UNICODE_DONE.');
    check('live Unicode reply completes without interruption', result.terminal === 'done' && ['QCHAT_UNICODE_DONE','😊','👨‍👩‍👧‍👦','👍🏽','🇳🇿'].every(s => result.text.includes(s)));
  }
  if (!process.argv.includes('--unicode-only')) {
    if (!process.argv.includes('--skip-uploads')) {
      phase = 'text file upload';
      const text = await file('qchat_é_😊.txt', 'text/plain', Buffer.from('QCHAT_ATTACHMENT_CHECK=brightblue\n', 'utf8'));
      result = await ask('Read the attached text file and reply with only the value of QCHAT_ATTACHMENT_CHECK.', [text]);
      check('live text attachment is read by ChatGPT', result.terminal === 'done' && /brightblue/i.test(result.text));
      phase = 'image upload';
      const image = await file('qchat_blue.png', 'image/png', bluePNG());
      result = await ask('What is the single main color of the attached image? Reply with one word.', [image]);
      check('live image attachment is read by ChatGPT', result.terminal === 'done' && /blue/i.test(result.text));
    }
    phase = 'file reply';
    result = await ask('Create a small downloadable CSV file named qchat_media_test.csv containing two rows: name,value and sample,42. Return a download link to the file.');
    const attachment = result.media?.find(item => item.kind === 'file' && /qchat_media_test\.csv/i.test(item.name)) || result.media?.findLast(item => item.kind === 'file');
    check('live file reply appears as an attachment', result.terminal === 'done' && Boolean(attachment));
    if (attachment) {
      const loaded = await invoke('media_load', { mediaId: attachment.id });
      const valid = await ui.evaluate(`fetch(${JSON.stringify(loaded.src)}).then(r=>r.text()).then(t=>t.includes('sample')&&t.includes('42'))`);
      check('authenticated generated file loads through native broker', valid);
    }
  }
  check('website remains signed in after media operations', await site.evaluate(`fetch('/api/auth/session').then(r=>r.json()).then(s=>!!(s.user||s.accessToken))`));
} catch (error) {
  check(`${phase} could not complete`, false);
  console.log('Reason:', ['Timed out', 'Page operation failed', 'App exited; quit other QChat instances before using the saved-profile test.'].includes(error?.message) ? error.message : 'App operation failed');
  if (ui) console.log('Readiness:', await ui.evaluate(`(()=>{const s=document.getElementById('status-label')?.textContent||'';return {ready:s==='Ready',guest:s==='Guest',loading:/loading|connect/i.test(s),signIn:/sign in/i.test(s)}})()`).catch(() => ({ unavailable: true })));
} finally {
  if (ui) { try { await ui.evaluate(`window.__TAURI__.core.invoke('quit_app')`); } catch {} }
  clients.forEach(client => client.close());
  await Promise.race([new Promise(resolve => app.once('exit', resolve)), sleep(2000)]);
  if (app.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
