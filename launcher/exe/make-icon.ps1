# Builds launcher\aiplay.ico from the AI PLAY mark in web\assets.
#
# The SVG in web\assets wraps a 400x400 PNG, which is sharper at 256 px than the
# 192 px aiplay-logo.png, so it is preferred. 256 px is stored PNG-compressed;
# smaller sizes are classic 32-bit bitmaps, which every Windows API decodes
# (System.Drawing and some shell paths mis-read PNG entries at small sizes).
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if ($Source -like "*.svg") {
  $m = [regex]::Match((Get-Content -Raw $Source), 'base64,([A-Za-z0-9+/=]+)')
  if (-not $m.Success) { throw "No embedded PNG in $Source" }
  $stream = New-Object IO.MemoryStream(, [Convert]::FromBase64String($m.Groups[1].Value))
  $src = [Drawing.Bitmap]::FromStream($stream)
} else {
  $src = [Drawing.Bitmap]::FromFile((Resolve-Path $Source))
}

function Resize([int]$s) {
  $bmp = New-Object Drawing.Bitmap($s, $s, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  return $bmp
}

# BITMAPINFOHEADER + bottom-up BGRA rows + all-zero AND mask (alpha does the work).
function Dib($bmp) {
  $s = $bmp.Width
  $ms = New-Object IO.MemoryStream
  $w = New-Object IO.BinaryWriter($ms)
  $w.Write([UInt32]40); $w.Write([Int32]$s); $w.Write([Int32]($s * 2))
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]0)
  $maskRow = [int]([Math]::Floor(($s + 31) / 32) * 4)
  $w.Write([UInt32]($s * $s * 4 + $maskRow * $s))
  $w.Write([Int32]0); $w.Write([Int32]0); $w.Write([UInt32]0); $w.Write([UInt32]0)
  $rect = New-Object Drawing.Rectangle(0, 0, $s, $s)
  $data = $bmp.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $px = New-Object byte[] ($s * $s * 4)
  [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
  $bmp.UnlockBits($data)
  for ($y = $s - 1; $y -ge 0; $y--) { $w.Write($px, $y * $s * 4, $s * 4) }
  $w.Write((New-Object byte[] ($maskRow * $s)))
  $w.Flush()
  return , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 128, 256
$entries = foreach ($s in $sizes) {
  $bmp = Resize $s
  if ($s -ge 256) {
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
  } else {
    $bytes = Dib $bmp
  }
  $bmp.Dispose()
  , $bytes
}
$src.Dispose()

$fs = [IO.File]::Create($Out)
$w = New-Object IO.BinaryWriter($fs)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([Byte]$dim); $w.Write([Byte]$dim); $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$entries[$i].Length); $w.Write([UInt32]$offset)
  $offset += $entries[$i].Length
}
foreach ($e in $entries) { $w.Write([byte[]]$e) }
$w.Close()
Write-Output "icon: $Out ($($sizes -join ', ') px)"
