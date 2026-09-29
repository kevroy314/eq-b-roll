<#
EQ B-Roll: update to the latest version. Run it with Update.bat (double-click).

Downloads the newest release from GitHub and copies it over this folder. Your exported zones,
saved takes, rendered videos, tools (private Python, LanternExtractor) and settings are kept.
Then it runs the setup again, which only redoes what changed (usually nothing but a quick check).
#>
param(
  [string]$Zip = "",        # use a local zip instead of downloading (for testing)
  [switch]$NoSetup
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Url = 'https://github.com/kevroy314/eq-b-roll/archive/refs/heads/main.zip'

function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Fail($m) { Write-Host "`n$m`n" -ForegroundColor Red; exit 1 }

$before = if (Test-Path "$Root\VERSION") { (Get-Content "$Root\VERSION" -Raw).Trim() } else { '1.0.0' }
Write-Host "EQ B-Roll update (installed: v$before)" -ForegroundColor White

$tmp = Join-Path $env:TEMP 'eq-b-roll-update'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory $tmp | Out-Null
if (-not $Zip) {
  $Zip = Join-Path $tmp 'main.zip'
  Write-Host "   Downloading the latest version..."
  $p = Start-Process curl.exe -NoNewWindow -Wait -PassThru -ArgumentList @('-L', '--fail', '--retry', '3', '-s', '-o', "`"$Zip`"", $Url)
  if ($p.ExitCode -ne 0) { Fail "Download failed. Check your internet connection and try again." }
}
$p = Start-Process tar.exe -NoNewWindow -Wait -PassThru -ArgumentList @('-xf', "`"$Zip`"", '-C', "`"$tmp`"")
if ($p.ExitCode -ne 0) { Fail "Could not unpack the update." }
$src = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'broll.py') } | Select-Object -First 1
if (-not $src) { Fail "The download does not look like EQ B-Roll." }

# Copy code over this folder, never touching user data.
$rc = (Start-Process robocopy.exe -NoNewWindow -Wait -PassThru -ArgumentList @(
  "`"$($src.FullName)`"", "`"$Root`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  '/XD', 'zones', 'takes', 'renders', 'tools', '/XF', 'config.json')).ExitCode
if ($rc -ge 8) { Fail "Copying the update failed (robocopy code $rc). Is the Studio still running? Close it and try again." }
Remove-Item -Recurse -Force $tmp
$after = (Get-Content "$Root\VERSION" -Raw).Trim()
Ok "Updated: v$before -> v$after"

if (-not $NoSetup) {
  Write-Host "   Re-running setup (quick when nothing changed)..."
  & (Join-Path $Root 'windows\setup.ps1')
}
