// The reserved window must not get in the way. Real window, isolated guest profile, real cursor
// moves but no clicks (owner's consent; refuses over a fullscreen app). Checks that the empty area
// lets the pointer through, that the bar takes it, and that a fresh launch does not shift later.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-area-'));
const port = 9417;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };
const lib = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Runtime.InteropServices; using System.Threading;
public static class A {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public static string Rect(IntPtr h) { R r; GetWindowRect(h, out r); return r.L + "," + r.T + "," + r.Ri + "," + r.B; }
  // Top-level window under the point after the pointer has rested there.
  public static long Under(int x, int y) {
    Point home; GetCursorPos(out home);
    SetCursorPos(x, y); Thread.Sleep(400);
    long top = GetAncestor(WindowFromPoint(new Point(x, y)), 2).ToInt64();
    SetCursorPos(home.X, home.Y);
    return top;
  }
}
'@
`;
const ps = body => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lib + body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw Error(`Timed out: ${label}`); }
let app, ws;
try {
  const front = ps(`$h=[A]::GetForegroundWindow();$r=New-Object A+R;[void][A]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;($r.Ri-$r.L) -eq $s.Width -and ($r.B-$r.T) -eq $s.Height`).stdout.trim();
  if (front !== 'False') { console.log('SKIP: a fullscreen app may be in front', front); process.exit(0); }
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: '1' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
  let serial = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const ev = expression => new Promise(res => { const id = ++serial; pending.set(id, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'ui');
  const dbg = await until(async () => { const d = await ev(`window.__TAURI__.core.invoke('surfaces_debug')`); return d?.glassVisible ? d : null; }, 'glass', 20000);
  const rect = () => ps(`[A]::Rect([IntPtr]${dbg.mainHwnd})`).stdout.trim();
  // A fresh launch, with no reload: does the window settle, or shift on the first change?
  await sleep(1500);
  const settled = rect();
  await ev(`(()=>{const i=document.getElementById('prompt-input');i.value='/';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(900);
  const withMenu = rect();
  await ev(`(()=>{const i=document.getElementById('prompt-input');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(900);
  const afterMenu = rect();
  check('a fresh window stays put when content first opens and closes', settled === withMenu && withMenu === afterMenu, JSON.stringify({ settled, withMenu, afterMenu }));

  const [L, T, Ri] = settled.split(',').map(Number);
  const screen = ps(`$c=New-Object System.Drawing.Point;[void][A]::GetCursorPos([ref]$c);$s=[System.Windows.Forms.Screen]::FromPoint($c).WorkingArea;"$($s.Left),$($s.Right)"`).stdout.trim().split(',').map(Number);
  const off = Math.abs((L + Ri) / 2 - (screen[0] + screen[1]) / 2);
  check('a fresh profile opens centred on the screen', off <= 2, JSON.stringify({ settled, screen, off }));
  const emptyX = Math.round((L + Ri) / 2), emptyY = T + 40;
  const bar = await ev(`(()=>{const r=document.getElementById('prompt-input').getBoundingClientRect(),d=devicePixelRatio;return {x:Math.round((r.left+r.width/2)*d),y:Math.round((r.top+r.height/2)*d)};})()`);
  const under = (x, y) => ps(`[A]::Under(${x},${y})`).stdout.trim();
  const overEmpty = under(emptyX, emptyY);
  check('the empty area above the bar lets the pointer through', overEmpty !== String(dbg.mainHwnd) && overEmpty !== String(dbg.glassHwnd), JSON.stringify({ overEmpty, main: dbg.mainHwnd, glass: dbg.glassHwnd }));
  const overBar = under(L + bar.x, T + bar.y);
  check('the bar takes the pointer', overBar === String(dbg.mainHwnd), JSON.stringify({ overBar, main: dbg.mainHwnd }));
  const overEmptyAgain = under(emptyX, emptyY);
  check('and lets go again', overEmptyAgain !== String(dbg.mainHwnd), overEmptyAgain);
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ws?.close();
  if (app?.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1200);
  for (let i = 0; i < 5 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(800); }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
