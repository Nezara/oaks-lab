# Draws the Oak's Lab pokeball mark with GDI+ (matching assets/favicon.svg's
# five swatches) at several sizes and packs them into one multi-resolution
# .ico, then makes a desktop-style shortcut to oaks-lab.html using it --
# an ordinary .html file can't carry its own Explorer icon, but a shortcut
# to one can.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$sizes = @(256, 48, 32, 16)

function Draw-Pokeball([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $ink    = [System.Drawing.Color]::FromArgb(255, 0x38, 0x40, 0x48)
    $red    = [System.Drawing.Color]::FromArgb(255, 0xa8, 0x20, 0x28)
    $panel  = [System.Drawing.Color]::FromArgb(255, 0xf0, 0xf0, 0xf8)
    $button = [System.Drawing.Color]::FromArgb(255, 0xcc, 0xd4, 0xe0)
    $shine  = [System.Drawing.Color]::FromArgb(160, 0xc8, 0x50, 0x48)

    $inkBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList @(,$ink)
    $redBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList @(,$red)
    $panelBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList @(,$panel)
    $buttonBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList @(,$button)

    $penW = [Math]::Max(1.0, $size * 0.06)
    $pen = New-Object -TypeName System.Drawing.Pen -ArgumentList $ink, $penW
    $thinPen = New-Object -TypeName System.Drawing.Pen -ArgumentList $ink, ([Math]::Max(1.0, $penW * 0.6))
    $shinePen = New-Object -TypeName System.Drawing.Pen -ArgumentList $shine, ([Math]::Max(1.0, $penW * 0.7))

    $pad = [Math]::Max(1.0, $size * 0.06)
    $d = $size - $pad * 2

    # bottom (white) half, then top (red) half as a pie over the top 180deg
    $g.FillEllipse($panelBrush, $pad, $pad, $d, $d)
    $g.FillPie($redBrush, $pad, $pad, $d, $d, 180.0, 180.0)
    $g.DrawEllipse($pen, $pad, $pad, $d, $d)

    # centre band
    $bandH = [Math]::Max(1.0, $size * 0.09)
    $g.FillRectangle($inkBrush, $pad, ($size / 2.0 - $bandH / 2.0), $d, $bandH)

    # button ring + inner cap
    $btnR = $d * 0.32
    $btnXY = ($size - $btnR) / 2.0
    $g.FillEllipse($panelBrush, $btnXY, $btnXY, $btnR, $btnR)
    $g.DrawEllipse($pen, $btnXY, $btnXY, $btnR, $btnR)
    $innerR = $btnR * 0.42
    $innerXY = ($size - $innerR) / 2.0
    $g.FillEllipse($buttonBrush, $innerXY, $innerXY, $innerR, $innerR)
    $g.DrawEllipse($thinPen, $innerXY, $innerXY, $innerR, $innerR)

    # a small shine arc, top-left of the red half -- the one "fun" flourish
    if ($size -ge 32) {
        $sx = $pad + $d * 0.14
        $sy = $pad + $d * 0.12
        $sd = $d * 0.34
        $g.DrawArc($shinePen, $sx, $sy, $sd, $sd, 180.0, 90.0)
    }

    $g.Dispose()
    return $bmp
}

$images = foreach ($s in $sizes) { Draw-Pokeball $s }

$pngBytes = @()
foreach ($bmp in $images) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes += ,$ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
}

$icoPath = Join-Path $root "assets\favicon.ico"
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter $fs

# ICONDIR
$bw.Write([uint16]0)      # reserved
$bw.Write([uint16]1)      # type: icon
$bw.Write([uint16]$sizes.Count)

$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $wByte = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$wByte)   # width
    $bw.Write([byte]$wByte)   # height
    $bw.Write([byte]0)        # color count
    $bw.Write([byte]0)        # reserved
    $bw.Write([uint16]1)      # planes
    $bw.Write([uint16]32)     # bit count
    $bw.Write([uint32]$pngBytes[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $pngBytes[$i].Length
}
foreach ($b in $pngBytes) { $bw.Write($b) }
$bw.Flush(); $fs.Close()
Write-Host "wrote $icoPath"

# A shortcut to the app, iconed with the file above -- oaks-lab.html itself
# can't carry a custom Explorer icon (that's the file-type association's
# icon, shared by every .html file on the system), but a .lnk to it can.
$wsh = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $root "Oak's Lab.lnk"
$shortcut = $wsh.CreateShortcut($lnkPath)
$shortcut.TargetPath = Join-Path $root "oaks-lab.html"
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icoPath,0"
$shortcut.Description = "Oak's Lab -- gen1recomp modding tool"
$shortcut.Save()
Write-Host "wrote $lnkPath"
