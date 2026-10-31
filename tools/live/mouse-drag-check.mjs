// A real mouse drag of the real window: moves the actual cursor, so it needs the owner's consent and
// refuses to run over a fullscreen app. Isolated guest profile. A test-owned striped panel sits
// behind the bar, and sharpness is measured through the glass at rest and mid-drag. The same drag
// with blur off is the control: it shows what the old "more transparent while moving" looks like.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const out = path.resolve('.tmp/mouse-drag');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-mouse-drag-'));
const port = 9389;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` :: ${detail}` : ''}`); if (!ok) failed++; };

const lib = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Windows.Forms; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Threading; using System.Text;
public static class D {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int c, uint f);
  // Mean absolute difference between horizontal neighbours: high when stripes and text show through sharply.
  public static double Sharp(Rectangle a, string save) {
    using (var b = new Bitmap(a.Width, a.Height)) { using (var g = Graphics.FromImage(b)) g.CopyFromScreen(a.Location, Point.Empty, a.Size);
      if (save != null) b.Save(save, ImageFormat.Png);
      double sum = 0; int n = 0;
      for (int y = 0; y < a.Height; y++) for (int x = 1; x < a.Width; x++) { var p = b.GetPixel(x, y); var q = b.GetPixel(x - 1, y); sum += Math.Abs(p.R - q.R) + Math.Abs(p.G - q.G) + Math.Abs(p.B - q.B); n++; }
      return sum / n; }
  }
  public static string Drag(IntPtr main, IntPtr glass, int ox, int oy, int px, int py, int pw, int ph, string tag, string dir) {
    Point home; GetCursorPos(out home);
    R r; GetWindowRect(main, out r);
    double rest = Sharp(new Rectangle(r.L + px, r.T + py, pw, ph), dir + "\\" + tag + "-rest.png");
    SetCursorPos(r.L + ox, r.T + oy); Thread.Sleep(350);
    mouse_event(2, 0, 0, 0, IntPtr.Zero); Thread.Sleep(60);
    int cx = r.L + ox, cy = r.T + oy, hidden = 0, worst = 0, samples = 0; double during = 0; int moved = 0;
    for (int i = 1; i <= 70; i++) {
      cx += 3; cy -= (i % 3 == 0) ? 1 : 0;
      SetCursorPos(cx, cy); Thread.Sleep(12);
      R m, g; GetWindowRect(main, out m); GetWindowRect(glass, out g);
      moved = Math.Max(moved, Math.Abs(m.L - r.L));
      if (m.L != r.L) { samples++; if (!IsWindowVisible(glass)) hidden++; worst = Math.Max(worst, Math.Abs(g.L - m.L)); }
      if (i == 40) { R a; GetWindowRect(main, out a); during = Sharp(new Rectangle(a.L + px, a.T + py, pw, ph), dir + "\\" + tag + "-drag.png"); }
    }
    mouse_event(4, 0, 0, 0, IntPtr.Zero); Thread.Sleep(250);
    SetCursorPos(home.X, home.Y);
    return "{\"rest\":" + rest.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + ",\"during\":" + during.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + ",\"moved\":" + moved + ",\"samples\":" + samples + ",\"hidden\":" + hidden + ",\"worst\":" + worst + "}";
  }
}
public class StripePanel : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80; return p; } }
  public StripePanel(Rectangle at) { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual; Bounds = at; BackColor = Color.White; }
  protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e);
    for (int x = 0; x < Width; x += 60) using (var b = new SolidBrush((x / 60) % 2 == 0 ? Color.FromArgb(245, 200, 150) : Color.FromArgb(140, 200, 245))) e.Graphics.FillRectangle(b, x, 0, 60, Height);
    using (var f = new Font("Consolas", 12)) for (int y = 0; y < Height; y += 20) e.Graphics.DrawString("SHARP TEXT BEHIND THE GLASS 0123456789 ABCDEFGHIJ SHARP TEXT BEHIND THE GLASS 0123456789 ABCDEFGHIJ SHARP TEXT BEHIND THE GLASS", f, Brushes.Black, 0, y); }
}
'@
`;
const ps = body => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lib + body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw Error(`Timed out: ${label}`); }

let app, ws, panel;
try {
  const front = ps(`$h=[D]::GetForegroundWindow();$r=New-Object D+R;[void][D]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;($r.Ri-$r.L) -eq $s.Width -and ($r.B-$r.T) -eq $s.Height`).stdout.trim();
  if (front !== 'False') { console.log('SKIP: a fullscreen app may be in front', front); process.exit(0); }
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: '1' }, stdio: 'ignore', windowsHide: true });
  const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main webview');
  ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let serial = 0; const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const ev = expression => new Promise(res => { const id = ++serial; pending.set(id, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'main UI');
  const dbg = await until(async () => { const d = await ev(`window.__TAURI__.core.invoke('surfaces_debug')`); return d?.glassVisible ? d : null; }, 'companion visible');
  await sleep(500);
  // Panel: a band around the window, then lift the window and its glass back above it.
  const rectText = ps(`$r=New-Object D+R;[void][D]::GetWindowRect([IntPtr]${dbg.mainHwnd},[ref]$r);"$($r.L),$($r.T),$($r.Ri),$($r.B)"`).stdout.trim();
  const [L, T, Ri, B] = rectText.split(',').map(Number);
  const panelRect = [L - 80, T - 120, Ri - L + 480, B - T + 240];
  panel = spawn('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(lib + `[System.Windows.Forms.Application]::Run((New-Object StripePanel (New-Object System.Drawing.Rectangle ${panelRect.join(',')})))`, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
  await sleep(2500);
  ps(`[void][D]::SetWindowPos([IntPtr]${dbg.mainHwnd},[IntPtr](-1),0,0,0,0,0x1 -bor 0x2 -bor 0x10)`);
  await sleep(500);
  const geo = await ev(`(()=>{const o=document.getElementById('orb').getBoundingClientRect(),b=document.getElementById('bar').getBoundingClientRect(),a=document.getElementById('btn-attach').getBoundingClientRect(),d=devicePixelRatio;return {ox:Math.round((o.left+o.width/2)*d),oy:Math.round((o.top+o.height/2)*d),px:Math.round((a.left-110)*d),py:Math.round((b.top+6)*d),pw:Math.round(90*d),ph:Math.round((b.height-12)*d)};})()`);
  const drag = tag => JSON.parse(ps(`[D]::Drag([IntPtr]${dbg.mainHwnd},[IntPtr]${dbg.glassHwnd},${geo.ox},${geo.oy},${geo.px},${geo.py},${geo.pw},${geo.ph},'${tag}','${out.replaceAll('\\', '\\\\')}')`).stdout.trim());

  const on = drag('blur-on');
  console.log('blur on ', JSON.stringify(on));
  check('the mouse really moved the window', on.moved > 60 && on.samples > 10, JSON.stringify(on));
  check('the glass never hid during the drag', on.hidden === 0, JSON.stringify(on));
  check('the look through the glass matches at rest and mid-drag', Math.abs(on.during - on.rest) <= Math.max(1.5, on.rest * 0.35), JSON.stringify(on));

  await ev(`window.__TAURI__.core.invoke('surfaces_set_blur',{enabled:false,tintArgb:1427117088,strength:1})`);
  await sleep(500);
  const off = drag('blur-off');
  console.log('blur off', JSON.stringify(off));
  check('control: the measure sees sharp desktop when there is no blur', off.rest > on.rest * 1.5, JSON.stringify({ on: on.rest, off: off.rest }));
} catch (e) { console.error(`FAIL ${e.message}`); failed++; }
finally {
  ws?.close();
  for (const child of [panel, app]) if (child?.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1200);
  for (let i = 0; i < 5 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(800); }
}
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
