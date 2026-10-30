param($out,$h)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object Drawing.Bitmap $b.Width,$b.Height
$g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)
$bmp.Save((Resolve-Path .).Path+'\'+$out); "$out $($b.Width)x$($b.Height)"
