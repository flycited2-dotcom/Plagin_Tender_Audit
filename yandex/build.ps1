# Сборка скрипта для Tampermonkey:
#   tender-tracker.user.js        — публичная версия (без ключей), её можно выкладывать
#   tender-tracker.local.user.js  — личная версия с адресом и ключом из ../tender-tracker/config.js (не публикуется)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object Text.UTF8Encoding $false

$src = [IO.File]::ReadAllText((Join-Path $here 'userscript.src.js'), $utf8)
$extract = [IO.File]::ReadAllText((Join-Path $here '..\tender-tracker\extract.js'), $utf8)
$extract = $extract.Substring($extract.IndexOf('function extractTender'))
$extract = '// --- распознавание полей (копия tender-tracker/extract.js) ---' + "`n  " + ($extract.TrimEnd() -replace "`n", "`n  ")
$public = $src.Replace('//@@EXTRACT@@', $extract)
[IO.File]::WriteAllText((Join-Path $here 'tender-tracker.user.js'), $public, $utf8)

$config = Join-Path $here '..\tender-tracker\config.js'
if (Test-Path $config) {
  $c = [IO.File]::ReadAllText($config, $utf8)
  $url = [regex]::Match($c, "url:\s*'([^']*)'").Groups[1].Value
  $token = [regex]::Match($c, "token:\s*'([^']*)'").Groups[1].Value
  $sheet = 'https://docs.google.com/spreadsheets/d/1FrmX4f42kx-mG3DnQwS2z27ANHWmjoKONOnhiN9PN4E/edit'
  $line = "const DEFAULT_SETTINGS = { url: '', token: '', sheetUrl: '' };"
  if (-not $public.Contains($line)) { throw 'Не найдена строка DEFAULT_SETTINGS' }
  $local = $public.Replace($line, "const DEFAULT_SETTINGS = { url: '$url', token: '$token', sheetUrl: '$sheet' };")
  [IO.File]::WriteAllText((Join-Path $here 'tender-tracker.local.user.js'), $local, $utf8)
  'Собрано: tender-tracker.user.js и tender-tracker.local.user.js'
} else {
  'Собрано: tender-tracker.user.js (config.js не найден — личная версия не создана)'
}
