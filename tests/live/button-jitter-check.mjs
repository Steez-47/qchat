// Does pressing a button disturb anything else? Real window, real cursor (owner's consent; refuses
// over a fullscreen app), isolated guest profile. Captures frames across a press and release and
// counts the pixels that change outside the button, with the window rect and style each frame.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exe = path.resolve('src-tauri/target-surfaces-test/debug/qchat.exe');
const profile = mkdtempSync(path.join(tmpdir(), 'qchat-jitter-'));
const port = 9413;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lib = String.raw`
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Threading; using System.Text; using System.Collections.Generic;
public static class J {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Ri,B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  static byte[] Grab(R r, out int stride, out int w, out int h) {
    w = r.Ri - r.L; h = r.B - r.T;
    using (var b = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(b)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, h));
      var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, b.PixelFormat);
      stride = d.Stride; var bytes = new byte[stride * h]; Marshal.Copy(d.Scan0, bytes, 0, bytes.Length); b.UnlockBits(d); return bytes;
    }
  }
  // Frames across a press at frame 15 and a release at frame 30; returns changes per frame outside the excluded box.
  public static string Run(IntPtr main, IntPtr glass, int bx, int by, int bw, int bh, bool press, bool click) {
    Point home; GetCursorPos(out home);
    R r; GetWindowRect(main, out r);
    SetCursorPos(r.L + bx + bw / 2, r.T + by + bh / 2); Thread.Sleep(600);
    var sb = new StringBuilder("["); int stride, w, h; byte[] prev = null;
    long style0 = GetWindowLongPtrW(main, -20).ToInt64();
    for (int f = 0; f < 50; f++) {
      if (press && f == 15) mouse_event(2, 0, 0, 0, IntPtr.Zero);
      if (press && f == 30) { if (!click) SetCursorPos(r.L + bx + bw + 40, r.T + by + bh + 40); mouse_event(4, 0, 0, 0, IntPtr.Zero); if (!click) SetCursorPos(r.L + bx + bw / 2, r.T + by + bh / 2); }
      R now; GetWindowRect(main, out now); R gl; GetWindowRect(glass, out gl);
      var cur = Grab(r, out stride, out w, out h);
      int changed = 0, minx = w, miny = h, maxx = 0, maxy = 0;
      if (prev != null) for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        if (x >= bx - 2 && x < bx + bw + 2 && y >= by - 2 && y < by + bh + 2) continue;
        int i = y * stride + x * 4;
        if (Math.Abs(cur[i] - prev[i]) > 10 || Math.Abs(cur[i+1] - prev[i+1]) > 10 || Math.Abs(cur[i+2] - prev[i+2]) > 10) { changed++; if (x<minx)minx=x; if (y<miny)miny=y; if (x>maxx)maxx=x; if (y>maxy)maxy=y; }
      }
      long style = GetWindowLongPtrW(main, -20).ToInt64();
      sb.Append("{\"f\":" + f + ",\"c\":" + changed + (changed>0 ? ",\"box\":[" + minx + "," + miny + "," + maxx + "," + maxy + "]" : "") + ",\"moved\":" + ((now.L != r.L || now.T != r.T || now.Ri != r.Ri || now.B != r.B) ? 1 : 0) + ",\"rect\":[" + (now.L-r.L) + "," + (now.T-r.T) + "," + (now.Ri-r.Ri) + "," + (now.B-r.B) + "]" + ",\"gm\":" + ((gl.L != now.L || gl.T != now.T) ? 1 : 0) + ",\"style\":" + (style != style0 ? 1 : 0) + "},");
      prev = cur; Thread.Sleep(4);
    }
    SetCursorPos(home.X, home.Y);
    return sb.ToString().TrimEnd(',') + "]";
  }
}
'@
`;
const ps = body => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lib + body, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
async function pages() { try { return await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return []; } }
async function until(fn, label, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw Error(`Timed out: ${label}`); }
let app, ws;
try {
  const front = ps(`$h=[J]::GetForegroundWindow();$r=New-Object J+R;[void][J]::GetWindowRect($h,[ref]$r);$s=[System.Windows.Forms.Screen]::FromHandle($h).Bounds;($r.Ri-$r.L) -eq $s.Width -and ($r.B-$r.T) -eq $s.Height`).stdout.trim();
  if (front !== 'False') { console.log('SKIP: a fullscreen app may be in front', front); process.exit(0); }
  app = spawn(exe, [], { env: { ...process.env, QCHAT_DEBUG_PORT: String(port), QCHAT_TEST_MODE: '1', QCHAT_TEST_PROFILE: profile, QCHAT_TEST_SHOW_MAIN: '1' }, stdio: 'ignore', windowsHide: true });
  const connect = async () => { const main = await until(async () => (await pages()).find(p => p.url.includes('tauri.localhost') && !p.url.includes('settings.html')), 'main'); const s = new WebSocket(main.webSocketDebuggerUrl); await new Promise((a, b) => { s.onopen = a; s.onerror = b; }); return s; };
  ws = await connect();
  let serial = 0; let pending = new Map();
  const wire = () => { ws.onmessage = ({ data }) => { const m = JSON.parse(data); pending.get(m.id)?.(m); pending.delete(m.id); }; }; wire();
  const ev = expression => new Promise(res => { const id = ++serial; pending.set(id, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  await until(() => ev(`!!document.getElementById('prompt-input') && !!window.__TAURI__`), 'ui');
  const text = 'A restored reply to test on.\\n\\nIt has a few lines of ordinary text, long enough to wrap across the bubble so that any shift of the text would show up clearly in the captured frames.';
  await ev(`localStorage.setItem('qchat.settings',JSON.stringify({v:4,autoDismiss:0}));localStorage.setItem('qchat.chats',JSON.stringify({v:1,current:{key:'j',conversationId:null,title:'J',lastActive:Date.now(),lastPrompt:'Hi',lastResponse:"${text}",createdAt:1},recent:['One','Two','Three'].map((t,i)=>({key:'r'+i,conversationId:null,title:t,lastActive:Date.now()-60000,lastPrompt:t,lastResponse:'x',createdAt:1}))}));setTimeout(()=>location.reload(),30);1`);
  await sleep(2500);
  ws.close(); ws = await connect(); wire();
  await until(() => ev(`!!document.querySelector('.bubble-response') && !!window.__TAURI__`), 'seeded bubble');
  await sleep(1800);
  const dbg = await until(async () => { const d = await ev(`window.__TAURI__.core.invoke('surfaces_debug')`); return d?.glassVisible ? d : null; }, 'glass', 15000);
  const box = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect(),d=devicePixelRatio;return {x:Math.round(r.left*d),y:Math.round(r.top*d),w:Math.round(r.width*d),h:Math.round(r.height*d)};})()`);
  const run = async (label, sel, press = true, click = false) => {
    const b = await box(sel);
    if (!b) { console.log(label, 'not found'); return; }
    const raw = ps(`[J]::Run([IntPtr]${dbg.mainHwnd},[IntPtr]${dbg.glassHwnd},${b.x},${b.y},${b.w},${b.h},$${press},$${click})`);
    let frames = []; try { frames = JSON.parse(raw.stdout.trim()); } catch { console.log(label, 'bad', raw.stderr.slice(0, 300)); return; }
    const noisy = frames.filter(f => f.c > 0);
    const summary = noisy.slice(0, 6).map(f => `${f.f}:${f.c}${f.box ? '@' + f.box.join(',') : ''}`).join(' ');
    console.log('  rectDelta', JSON.stringify(frames.find(f => f.moved)?.rect), JSON.stringify(frames.at(-1)?.rect));
    console.log(`${label} windowMoved=${frames.filter(f => f.moved).length} glassOff=${frames.filter(f => f.gm).length} styleFlips=${frames.filter(f => f.style).length} noisyFrames=${noisy.length} peak=${Math.max(0, ...frames.map(f => f.c))} | ${summary}`);
  };
  console.log('window', JSON.stringify(await ev(`({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`)));
  await run('idle (no press)', '#btn-attach', false);
  await run('press attach', '#btn-attach');
  await run('press tab', '#tabs .tab');
  await run('press history', '#btn-history');
  await run('click history (opens)', '#btn-history', true, true);
  await sleep(700);
  await run('click latest (closes)', '#btn-history', true, true);
  await sleep(700);
  await run('click history again (opens)', '#btn-history', true, true);
  await sleep(700);
  await run('click latest again (closes)', '#btn-history', true, true);
  await sleep(700);
  await run('click a tab (switches)', '#tabs .tab', true, true);
} catch (e) { console.error(`FAIL ${e.message}`); }
finally {
  ws?.close();
  if (app?.pid) spawnSync('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(1200);
  for (let i = 0; i < 5 && existsSync(profile); i++) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch {} if (existsSync(profile)) await sleep(800); }
}
