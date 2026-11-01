// Bubble UI checks and screenshots in an isolated, invisible Edge profile. Mock backend only:
// no account, no site access, no OS-level input. `--shots <dir>` also captures review PNGs.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openPage, serveUI, sleep } from './lib/ui-harness.mjs';

const { base, close: closeServer } = await serveUI();

const shotsArg = process.argv.indexOf('--shots');
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : null;

let browserPage;
let failed = 0;
const problems = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` :: ${detail}` : ''}`);
  if (!ok) failed++;
};

try {
  browserPage = await openPage('history-ui', { problems });
  const { cdp, evalJS } = browserPage;
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Emulation.setScrollbarsHidden', { hidden: false });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1080 });

  const until = async (expr, what = expr, tries = 400) => {
    for (let i = 0; i < tries; i++) { if (await evalJS(`!!(${expr})`)) return; await sleep(10); }
    const state = await evalJS(`JSON.stringify({rows:[...document.querySelectorAll('.turn-row')].map(r=>({role:r.dataset.role,status:r.dataset.status,hidden:r.hidden,cls:r.className})),calls:window.__mock?.calls.slice(-4).map(c=>c.cmd),fits:window.__mock?.fits.length,lastFits:window.__mock?.fits.slice(-4).map(x=>x.height),text:document.querySelector('[data-role=assistant] .turn-content')?.textContent.length,capped:document.querySelector('[data-role=assistant]')?.hasAttribute('data-capped'),now:performance.now()|0,hold:window.__mock?.hold,rel:!!window.__mock?.release,btn:document.getElementById('btn-send')?.dataset.mode})`).catch(() => 'n/a');
    throw new Error(`Timed out waiting for: ${what} :: ${state}`);
  };
  const open = async (url = '/', { settings, chats, keep = false } = {}) => {
    await cdp('Page.navigate', { url: `${base}/__blank` });
    await until(`document.readyState==='complete'`);
    if (!keep) await evalJS(`localStorage.clear()`);
    if (settings !== undefined) await evalJS(`localStorage.setItem('qchat.settings', ${JSON.stringify(typeof settings === 'string' ? settings : JSON.stringify(settings))})`);
    if (chats !== undefined) await evalJS(`localStorage.setItem('qchat.chats', ${JSON.stringify(JSON.stringify(chats))})`);
    await cdp('Page.navigate', { url: `${base}${url}` });
    await until(`document.readyState==='complete' && window.QSettings`);
    await cdp('Page.bringToFront');
    await sleep(60);
  };
  const type = (text) => evalJS(`(()=>{const i=document.getElementById('prompt-input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const key = (k, extra = {}) => evalJS(`(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.getElementById('prompt-input');t.dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key: k, bubbles: true, cancelable: true, ...extra })}));})()`);
  const send = async (text) => { await type(text); await key('Enter'); };

  const count = (cmd) => evalJS(`__mock.count('${cmd}')`);
  const finishReply = () => until(`document.querySelector('[data-role=assistant]')?.dataset.status==='done'`, 'reply done', 1500);
  const settle = () => sleep(650);
  const fixture = `## Game collection

{@body const games = ["Red Dead Redemption 2", "GTA V", "Hollow Knight", "Rocket League"]}
{@body const [items,setItems] = DIL.useState(["Arthur Morgan","John Marston","Dutch van der Linde"])}
{@body const extras = ["Sadie Adler","Charles Smith","Hosea Matthews","Micah Bell"]}
{#each games as game}<box><strong>{game}</strong></box>{/each}
{#each items as item}<text>{item}</text>{/each}
<button onClick={()=>setItems([...items, extras[(items.length-3) % extras.length]])}>Add another item</button>`;
  const content = "document.querySelector('[data-role=assistant] .turn-content')";
  const begin = async (source,style='instant') => {
    await open('/',{settings:{v:4,animations:'off',autoDismiss:0,streamStyle:style}});
    await evalJS('window.__mock.hold=true'); await send('Interactive fixture'); await until("__mock.last('chat_send')");
    await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(source)}})`);
  };
  await begin(fixture);
  await until(`${content}?.querySelector('button.qinteractive-control')`,'interactive button renders');
  check('screenshot declarations render component loops and hide source',await evalJS(`(()=>{const c=${content};return ['Red Dead Redemption 2','GTA V','Hollow Knight','Rocket League','Arthur Morgan','John Marston','Dutch van der Linde'].every(x=>c.textContent.includes(x)) && !c.textContent.includes('@body') && !c.textContent.includes('DIL.useState') && !c.textContent.includes('{#each')})()`));
  for (const name of ['Sadie Adler','Charles Smith','Hosea Matthews']) {
    await evalJS(`${content}.querySelector('button.qinteractive-control').click()`);
    check('button updates state and loop: '+name,await evalJS(`${content}.textContent.includes(${JSON.stringify(name)})`));
  }
  await evalJS(`__mock.emit('bridge',{type:'done',id:__mock.last('chat_send').args.id,text:${JSON.stringify(fixture)}})`); await finishReply();
  check('completion preserves clicked state',await evalJS(`${content}.textContent.includes('Hosea Matthews')`));
  await evalJS(`${content}.querySelector('button.qinteractive-control').click()`);
  check('completed reply remains interactive',await evalJS(`${content}.textContent.includes('Micah Bell')`));
  if(shotsDir){await mkdir(shotsDir,{recursive:true});const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(shotsDir,'interactive-games.png'),Buffer.from(shot.data,'base64'));}
  const form=`{@body const [name,setName]=DIL.useState("Ada")}
{@body const [seats,setSeats]=DIL.useState(2)}
{@body const [checked,setChecked]=DIL.useState(false)}
<input aria-label="Name" value={name} onChange={setName}/>
<select aria-label="Choice" value={name} onChange={e=>setName(e.target.value)}><option value="Ada">Ada</option><option value="Grace">Grace</option></select>
<slider aria-label="Seats" min={1} max={10} value={seats} onChange={setSeats}/>
<checkbox aria-label="Check" checked={checked} onChange={setChecked}/>
<text>{name}: {seats*29}: {checked}</text>`;
  await begin(form);
  await until(`${content}?.querySelector('input[aria-label=Name]')`);
  await evalJS(`(()=>{const n=${content}.querySelector('input[aria-label=Name]');n.focus();n.value='Lin';n.dispatchEvent(new Event('input',{bubbles:true}));window.focusInput=n;})()`);
  check('input updates derived text and preserves focus',await evalJS(`${content}.textContent.includes('Lin: 58: false') && document.activeElement===focusInput`));
  await evalJS(`(()=>{const n=${content}.querySelector('select');n.value='Grace';n.dispatchEvent(new Event('change',{bubbles:true}));const s=${content}.querySelector('input[type=range]');s.value='5';s.dispatchEvent(new Event('input',{bubbles:true}));${content}.querySelector('input[type=checkbox]').click();})()`);
  check('select slider and checkbox update local state',await evalJS(`${content}.textContent.includes('Grace: 145: true')`));
  check('controls trigger no native command or new model turn',await evalJS(`__mock.count('chat_send')===1 && !__mock.calls.some(c=>['open_external','shell','eval'].includes(c.cmd))`));
  await begin('{@body const games=[\n\n"Pending', 'paragraph'); await sleep(50);
  check('partial body declaration stays hidden during paragraph streaming',await evalJS(`!${content}.textContent.includes('@body') && !${content}.textContent.includes('Pending')`));
  await evalJS(`__mock.emit('bridge',{type:'delta',id:__mock.last('chat_send').args.id,text:${JSON.stringify(fixture+'\n\n')}})`);
  await until(`${content}?.querySelector('button.qinteractive-control')`);
  check('paragraph mode renders interactive content before completion',await evalJS(`${content}.textContent.includes('Arthur Morgan')`));
  await begin('{@body const [choice,setChoice]=DIL.useState("")}<select onChange={setChoice}><option value="a">A</option><option value="b" selected>B</option></select><input onInput={setChoice}/><text>{choice}</text>');
  await until(`${content}?.querySelector('select')`);
  check('select honors its selected option without a value binding',await evalJS(`${content}.querySelector('select').value==='b'`));
  await evalJS(`(()=>{const n=${content}.querySelector('input');n.value='typed';n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  check('onInput handler updates state',await evalJS(`${content}.textContent.includes('typed')`));
  const dangerous='{@body const [n,setN]=DIL.useState(0)}<button onClick={()=>window.__TAURI__.core.invoke("quit_app")}>Unsafe action</button><text>{n}</text>';
  await begin(dangerous);
  await until(`${content}?.querySelector('button.qinteractive-control')`);
  check('unsupported external actions are disabled',await evalJS(`${content}.querySelector('button.qinteractive-control').disabled`));
  await open('/',{settings:{v:4,animations:'off',autoDismiss:0},chats:{v:1,current:{key:'interactive',conversationId:null,title:'Interactive',lastActive:1,lastPrompt:'Games',lastResponse:fixture,createdAt:1},recent:[]}});
  await settle();
  await evalJS(`${content}.querySelector('button.qinteractive-control').click()`);
  check('saved replies restore a working interactive session',await evalJS(`${content}.textContent.includes('Sadie Adler')`));
  check('no runtime or CSP errors',problems.length===0,problems.join(' | '));
} catch (e) { console.error(e); if (problems.length) console.error("console:", problems.slice(0, 5).join(" | ")); failed++; }
finally {
  await browserPage?.close();
  closeServer();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
