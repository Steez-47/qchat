// The blur companion must stay up and aligned while the window moves. Runs the real app in an
// isolated guest profile, placed off screen, and moves it from outside with SetWindowPos: this is
// the same message path as a drag, with no OS input. `--visual` also parks it on screen for about
// two seconds and saves crops of only its own area to compare blur strengths. Refuses to run while
// a fullscreen app (a game) is in front.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'src-tauri/target-surfaces-test/debug/qchat.exe');
if (!existsSync(exe)) throw Error('Build first: cargo build --target-dir target-surfaces-test');
const visual = process.argv.includes('--visual');
const shots = path.join(root, '.tmp/drag-sync');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-dragsync-'));
const port = 9361;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };

const helper = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public static string Sweep(IntPtr main, IntPtr glass, int steps) {
    R m, g; GetWindowRect(main, out m);
    int hidden = 0, worst = 0, x = m.L, y = m.T; var sb = new StringBuilder();
    for (int i = 0; i < steps; i++) {
      x += 37; y += (i % 2 == 0) ? 9 : -9;
      SetWindowPos(main, IntPtr.Zero, x, y, 0, 0, 0x1 | 0x4 | 0x10);
      System.Threading.Thread.Sleep(1);
      GetWindowRect(glass, out g);
      if (!IsWindowVisible(glass)) hidden++;
      worst = Math.Max(worst, Math.Max(Math.Abs(g.L - x), Math.Abs(g.T - y)));
      System.Threading.Thread.Sleep(7);
    }
    return "{\\"steps\\":" + steps + ",\\"hidden\\":" + hidden + ",\\"worstOffset\\":" + worst + "}";
  }
}
'@
`;
const runPS = (body) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(helper + body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json(); } catch { return []; } }
async function until(fn, label) { const end = Date.now() + 20000; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(120); } throw Error(`Timed out: ${label}`); }

let app, ws;
const fullscreenInFront = () => runPS(`$h=[W]::GetForegroundWindow();$r=New-Object W+R;[void][W]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;($r.Ri-$r.L) -eq $s.Width -and ($r.B-$r.T) -eq $s.Height`).stdout.trim() === 'True';
try {
  if ((await pages()).length) throw Error('Test debug port already in use');
  if (fullscreenInFront()) { console.log('SKIP: a fullscreen app is in front'); process.exit(0); }
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: 'offscreen' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let serial = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const ev = expression => new Promise(res => { const id = ++serial; pending.set(id, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');
  const debug = () => ev(`window.__TAURI__.core.invoke('surfaces_debug')`);
  const ready = await until(async () => { const d = await debug(); return d.glassHwnd && d.blurOk && d.glassVisible && d.rectCount > 0 ? d : false; }, 'companion visible');
  check('companion shows under the real window', ready.glassIsBelowMain);
    // Give the pages time to load: a late focus grab is the failure this looks for.
  await sleep(6000);
  const owner = runPS('$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);$p').stdout.trim();
  check('neither hidden window takes the foreground', owner !== String(app.pid), owner);
  const hitOnly = await ev(`(()=>{const n=document.getElementById('bar');return n.classList.contains('glass');})()`);
  check('the bar is a blur surface', hitOnly);

  const sweep = runPS(`[W]::Sweep([IntPtr]${ready.mainHwnd},[IntPtr]${ready.glassHwnd},60)`);
  const result = JSON.parse(sweep.stdout.trim() || '{}');
  check('glass never hides while the window moves', result.hidden === 0, sweep.stdout + sweep.stderr);
  // 37px per step: anything smaller than one step means it was not a frame behind.
  check('glass tracks the window to within one step', result.worstOffset < 37, sweep.stdout);
  await sleep(200);
  const after = await debug();
  check('still visible and below the window afterwards', after.glassVisible && after.glassIsBelowMain);

  const round = await ev(`(async()=>{const i=window.__TAURI__.core.invoke;await i('surfaces_set_blur',{enabled:true,tintArgb:1427117088,strength:0.25});await new Promise(r=>setTimeout(r,120));const low=await i('surfaces_debug');await i('surfaces_set_blur',{enabled:true,tintArgb:1427117088,strength:1});await new Promise(r=>setTimeout(r,120));return {low,ok:(await i('surfaces_debug')).blurOk};})()`);
  check('blur strength applies without a composition error', round.low.blurOk && round.ok && !round.low.compositionError, JSON.stringify(round));

  if (visual) {
    mkdirSync(shots, { recursive: true });
    await ev(`(()=>{const z=document.getElementById('bubble-zone');z.hidden=false;const d=document.createElement('div');d.className='bubble glass';d.style.cssText='padding:14px 18px;margin-bottom:8px';d.innerHTML='<b>Desktop blur check.</b> Compare this glass across strengths.';z.append(d);QSettings.apply(document.documentElement,{...QSettings.settings,glassOpacity:20,replyOpacity:20,readableGuard:false});})()`);
    await sleep(300);
    const fg = runPS(`$h=[W]::GetForegroundWindow();$r=New-Object W+R;[void][W]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"$($r.Ri-$r.L)x$($r.B-$r.T) of $($s.Width)x$($s.Height)"`).stdout.trim();
    console.log('foreground window size:', fg);
    const [w, h] = fg.split(' of ')[0].split('x').map(Number);
    const [sw, sh] = fg.split(' of ')[1].split('x').map(Number);
    if (w >= sw && h >= sh) console.log('SKIP visual: a fullscreen app is in front');
    else {
      const park = `[void][W]::SetWindowPos([IntPtr]${ready.mainHwnd},[IntPtr]::Zero,40,40,0,0,0x1 -bor 0x4 -bor 0x10);`;
      const hide = `[void][W]::SetWindowPos([IntPtr]${ready.mainHwnd},[IntPtr]::Zero,-20000,-20000,0,0,0x1 -bor 0x4 -bor 0x10);`;
      const grab = name => `Start-Sleep -Milliseconds 350;$r=New-Object W+R;[void][W]::GetWindowRect([IntPtr]${ready.mainHwnd},[ref]$r);$b=New-Object Drawing.Bitmap ($r.Ri-$r.L),($r.B-$r.T);$g=[Drawing.Graphics]::FromImage($b);$g.CopyFromScreen($r.L,$r.T,0,0,$b.Size);$b.Save('${path.join(shots, name).replaceAll('\\', '\\\\')}');`;
      console.log(runPS(park).stderr);
      for (const [name, strength] of [['blur-100.png', 1], ['blur-30.png', 0.3], ['blur-0.png', 0]]) {
        await ev(`window.__TAURI__.core.invoke('surfaces_set_blur',{enabled:true,tintArgb:1427117088,strength:${strength}})`);
        runPS(grab(name));
      }
      runPS(hide);
      console.log('saved', shots);
    }
  }
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ws?.close();
  if (app?.pid && app.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
