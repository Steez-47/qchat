param([int64]$h,[int64]$m)
Add-Type @'
using System; using System.Runtime.InteropServices;
public class R { [StructLayout(LayoutKind.Sequential)] public struct RC{public int l,t,r,b;} [StructLayout(LayoutKind.Sequential)] public struct PT{public int x,y;}
[DllImport("user32.dll")] public static extern int GetWindowRgnBox(IntPtr h, out RC r);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int i);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);}
'@
$r=New-Object R+RC; $k=[R]::GetWindowRgnBox([IntPtr]$h,[ref]$r); "rgn type $k box $($r.l),$($r.t),$($r.r),$($r.b)"
$w=New-Object R+RC; [void][R]::GetWindowRect([IntPtr]$h,[ref]$w); "rect $($w.l),$($w.t),$($w.r),$($w.b) vis $([R]::IsWindowVisible([IntPtr]$h)) ex $('{0:X}' -f [R]::GetWindowLong([IntPtr]$h,-20))"
$p=New-Object R+PT; $p.x=$w.l+4; $p.y=$w.t+4; "gutter hit: $([R]::WindowFromPoint($p)) main $m glass $h"
