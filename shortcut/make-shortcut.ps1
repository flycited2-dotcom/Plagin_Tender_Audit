# Создаёт на рабочем столе ярлык «Учёт тендеров»: таблица открывается отдельным окном Chrome (без вкладок и адресной строки).
# После этого: правой кнопкой по ярлыку → «Закрепить на панели задач».
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sheetUrl = 'https://docs.google.com/spreadsheets/d/1FrmX4f42kx-mG3DnQwS2z27ANHWmjoKONOnhiN9PN4E/edit'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome не найден' }

# --- иконка: зелёная «таблица» с тёмно-синей шапкой (как оформлен лист) ---
$size = 256
$bmp = New-Object Drawing.Bitmap $size, $size
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([Drawing.Color]::Transparent)
$path = New-Object Drawing.Drawing2D.GraphicsPath
$r = 48; $x = 8; $y = 8; $w = 240; $h = 240
$path.AddArc($x, $y, $r, $r, 180, 90); $path.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
$path.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90); $path.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(24, 128, 56))), $path)
$white = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
$navy = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(31, 56, 100))
$g.FillRectangle($white, 44, 52, 168, 152)
$g.FillRectangle($navy, 44, 52, 168, 34)
$pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(24, 128, 56)), 6
foreach ($yy in 120, 154) { $g.DrawLine($pen, 44, $yy, 212, $yy) }
$g.DrawLine($pen, 100, 86, 100, 204)
# цветные «плашки статусов» в первой колонке
$g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(52, 168, 83))), 52, 94, 40, 20)
$g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(251, 188, 4))), 52, 128, 40, 20)
$g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(234, 67, 53))), 52, 162, 40, 20)
$g.Dispose()

$ms = New-Object IO.MemoryStream
$bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ico = Join-Path $here 'tenders.ico'
$fs = [IO.File]::Create($ico)
$bw = New-Object IO.BinaryWriter $fs
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)          # заголовок ICO, 1 картинка
$bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0) # 256x256, без палитры
$bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]$png.Length); $bw.Write([UInt32]22)
$bw.Write($png); $bw.Close()

# --- ярлык на рабочем столе ---
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Учёт тендеров.lnk'
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath = $chrome
$lnk.Arguments = "--app=$sheetUrl"
$lnk.WorkingDirectory = Split-Path $chrome
$lnk.IconLocation = "$ico,0"
$lnk.Description = 'Google Таблица «Учет заявок_ТЕНЕДЕРов_v1»'
$lnk.Save()
"Ярлык создан: $lnkPath"
