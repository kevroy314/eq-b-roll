<#
EQ B-Roll: one-time setup for filming inside the real EverQuest client, on a private server
running on this PC. Run it with Setup.bat (double-click). Safe to run again at any time: it
reuses what is already there and repairs what isn't.

What it does
  1. Docker Desktop: checks it is installed and running (offers to install it if not).
  2. Server: builds our image (the community EQMacEmu server plus our fixes) and starts it.
  3. Client: downloads the TAKP client if needed, installs two updated DLLs, and points it at
     the local server.
  4. Checks this PC has a mouse (the 2002 client crashes without one).
  5. Studio: the synthetic renderer (smooth camera paths, frame-perfect MP4s) with a private
     Python and a starter set of zones exported from the client.
  6. Puts "EQ B-Roll" (the game) and "EQ B-Roll Studio" shortcuts on the desktop.

Every fix here was found the hard way; docs/LOCAL_SERVER.md explains each one.
#>
param(
  [string]$ClientDir = "C:\TAKP-broll",   # where the game client lives (created if missing)
  [string]$ClientZip = "",                # use an already-downloaded client zip instead
  [switch]$SkipServer,
  [switch]$SkipClient,
  [switch]$SkipStudio,
  [string[]]$StudioZones = @('qeynos', 'gfaydark', 'northkarana', 'erudsxing', 'lavastorm')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is 10x slower with the bar on
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root   # cmd.exe refuses (on stderr) to start in a network/UNC current directory

$Image     = 'eq-broll-server'
$Container = 'eq-broll-server'
$Volume    = 'eq-broll-data'               # the server database; survives rebuilds
# Ports are bound to 127.0.0.1 only: the server is not reachable from the network.
# (TCP 9000, the world admin console, is deliberately not published; see problem #1.)
$Ports = @('6000:6000/udp', '5998:5998', '9000:9000/udp', '7778:7778/udp',
           '7375-7400:7375-7400/udp', '7375-7400:7375-7400',
           '7000-7374:7000-7374/udp', '7000-7374:7000-7374')

# Pinned downloads: what we tested, byte for byte.
$ClientUrl = 'https://www.dropbox.com/s/bppy4ebt7vl7hwk/TAKP%20PC%20V2.1c.zip?dl=1'
$ClientSha = '0059ef699c4dbada38dae79d450d111e8b41248fa832b174a928552f3aea1674'
$Dlls = @(
  @{ Name = 'eqw.dll';    Sha = 'dffb97ac1f47d41f450614c8d6d4da30f3f47b7ed5046dbdbd111b3ba1fbe5ba'
     Url  = 'https://github.com/CoastalRedwood/eqw_takp/releases/download/v1.0.2/eqw.dll' },
  @{ Name = 'eqgame.dll'; Sha = 'f0ca8e4bdcf3875419ecb1067a95bd6dbf8197e564f9d51ff4dec98a30f14b97'
     Url  = 'https://github.com/EQMacEmu/eqgame_dll_takp/releases/download/v0.0.0.3/eqgame.dll' }
)

# Studio runs on a private copy of Python (the official embeddable build): nothing is installed
# system-wide, and broll.py only needs the standard library.
$PyUrl = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
$PySha = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Info($m) { Write-Host "   $m" }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "`n$m`n" -ForegroundColor Red; exit 1 }
# Native programs (docker, curl, tar, python) write normal progress to stderr. Under
# $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns captured stderr into a terminating
# error, so the script dies mid-step with no message. Every native call goes through these.
function Quiet($cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { cmd /c "$cmd >nul 2>&1" 2>$null | Out-Null } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}
function Capture($cmd) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { return (cmd /c "$cmd 2>nul" 2>$null) } finally { $ErrorActionPreference = $old }
}
function Native($exe, [string[]]$argv) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & $exe @argv 2>&1 | ForEach-Object {
      # stderr lines arrive as ErrorRecords; their original text is in TargetObject
      $t = if ($_ -is [System.Management.Automation.ErrorRecord]) { [string]$_.TargetObject } else { [string]$_ }
      if ($t.Trim()) { Write-Host "   $t" }
    }
  } finally { $ErrorActionPreference = $old }
  return $LASTEXITCODE
}
function Sha($path) { (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower() }
function Download($url, $dest) {
  # curl.exe ships with Windows 10+, follows redirects and shows real progress.
  # Started as its own process so its progress bar goes straight to the console instead of
  # through PowerShell's stderr handling (which renders it as a red error block).
  $p = Start-Process curl.exe -NoNewWindow -Wait -PassThru `
         -ArgumentList @('-L', '--fail', '--retry', '3', '--progress-bar', '-o', "`"$dest`"", "`"$url`"")
  if ($p.ExitCode -ne 0) { Fail "Download failed: $url" }
}

# --- 1. Docker ----------------------------------------------------------------------------------
function Ensure-Docker {
  Step "Docker Desktop"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn "Docker Desktop is not installed. The game server runs inside it."
    Info "It needs hardware virtualization enabled in the BIOS (most PCs from the last 10 years"
    Info "have it on) and a restart after installing."
    $a = Read-Host "   Install Docker Desktop now with winget? [Y/n]"
    if ($a -notmatch '^[Nn]') {
      Native 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements') | Out-Null
      Fail ("Docker Desktop installed. Now: RESTART Windows, open Docker Desktop once and accept its " +
            "terms (no account needed), then run Setup.bat again.")
    }
    Fail "Install Docker Desktop from https://docs.docker.com/desktop/install/windows-install/ then run Setup.bat again."
  }
  if ((Quiet 'docker info') -ne 0) {
    $exe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exe) { Info "Starting Docker Desktop..."; Start-Process $exe }
    $t = 0
    while ((Quiet 'docker info') -ne 0) {
      if ($t -ge 240) {
        Fail ("Docker Desktop did not start. Open it yourself and look for an error. The usual cause " +
              "is virtualization being disabled in the BIOS, or it asking you to accept its terms.")
      }
      Start-Sleep 5; $t += 5
    }
  }
  Ok "Docker is running."
}

# --- 2. Server ----------------------------------------------------------------------------------
function Ensure-Server {
  Step "Game server"
  Info "Building the server image. The first time downloads about 5.5 GB; later runs take seconds."
  if ((Native 'docker' @('build', '-t', $Image, (Join-Path $Root 'server'))) -ne 0) {
    Fail "Building the server image failed (see the output above)."
  }
  $want = ((Capture "docker image inspect $Image --format {{.Id}}") -join '').Trim()

  $have = ((Capture "docker ps -a --filter `"name=^$Container`$`" --format {{.ID}}") -join '').Trim()
  if ($have) {
    $cur = ((Capture "docker inspect $Container --format {{.Image}}") -join '').Trim()
    if ($cur -ne $want) {
      Info "Server image changed; recreating the server (your characters are kept)."
      Quiet "docker rm -f $Container" | Out-Null
      $have = ''
    }
  }
  if (-not $have) {
    Quiet "docker volume create $Volume" | Out-Null
    $runArgs = @('run', '-d', '--name', $Container, '--restart', 'unless-stopped',
              '-v', "${Volume}:/var/lib/mysql")
    foreach ($p in $Ports) { $runArgs += @('-p', "127.0.0.1:$p") }
    $runArgs += $Image
    if ((Native 'docker' $runArgs) -ne 0) {
      Fail ("Could not start the server. If it says a port is already allocated, another " +
            "EverQuest server (or other program) is using it: stop that, then run Setup.bat again.")
    }
  } else {
    Quiet "docker start $Container" | Out-Null
  }
  Info "Waiting for the server to come up..."
  for ($t = 0; $t -lt 180; $t += 3) {
    $log = (Capture "docker logs --tail 400 $Container 2>&1") -join "`n"
    if ($log -match 'Connected to Loginserver' -and $log -match 'Zone started') {
      Ok "Server is running (it starts automatically whenever Docker Desktop is running)."
      return
    }
    Start-Sleep 3
  }
  Fail "The server did not finish starting. Check Docker Desktop -> Containers -> $Container -> Logs."
}

# --- 3. Client ----------------------------------------------------------------------------------
function Ensure-Client {
  Step "Game client ($ClientDir)"
  $exe = Join-Path $ClientDir 'eqgame.exe'
  if (-not (Test-Path $exe)) {
    $zip = $ClientZip
    if (-not $zip) {
      $zip = Join-Path $env:TEMP 'TAKP_PC_V2.1c.zip'
      if (-not (Test-Path $zip) -or (Sha $zip) -ne $ClientSha) {
        Info "Downloading the TAKP client (2.3 GB, from the TAKP project's official link)..."
        Download $ClientUrl $zip
      }
    }
    if ((Sha $zip) -ne $ClientSha) { Fail "The client download is corrupt or not the expected version: $zip" }
    Info "Unpacking..."
    $tmp = Join-Path $env:TEMP 'takp-unpack'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    New-Item -ItemType Directory $tmp | Out-Null
    if ((Native 'tar.exe' @('-xf', $zip, '-C', $tmp)) -ne 0) { Fail "Could not unpack $zip" }
    $parent = Split-Path $ClientDir
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force $parent | Out-Null }
    Move-Item (Join-Path $tmp 'TAKP PC V2.1') $ClientDir
    Remove-Item -Recurse -Force $tmp
    $n = (Get-ChildItem -Recurse -File $ClientDir).Count
    if ($n -lt 2637) {
      Warn ("Only $n of 2637 client files are there. Antivirus sometimes deletes one; add an " +
            "exclusion for $ClientDir and run Setup.bat again.")
    }
    if (-not $ClientZip) { Remove-Item $zip }
  } else {
    Info "Using the existing client."
  }

  # Updated DLLs: the stock ones crash on modern Windows (TAKP's own guide requires these).
  $orig = Join-Path $ClientDir '_orig'
  foreach ($d in $Dlls) {
    $dest = Join-Path $ClientDir $d.Name
    if ((Test-Path $dest) -and (Sha $dest) -eq $d.Sha) { continue }
    $tmp = Join-Path $env:TEMP $d.Name
    Download $d.Url $tmp
    if ((Sha $tmp) -ne $d.Sha) { Fail "Downloaded $($d.Name) does not match the tested version." }
    New-Item -ItemType Directory -Force $orig | Out-Null
    if ((Test-Path $dest) -and -not (Test-Path (Join-Path $orig $d.Name))) { Copy-Item $dest $orig }
    Copy-Item $tmp $dest -Force
    Remove-Item $tmp
  }
  Ok "Client DLLs are up to date."

  # Point the client at this PC.
  $hostFile = Join-Path $ClientDir 'eqhost.txt'
  if ((Test-Path $hostFile) -and -not (Test-Path (Join-Path $orig 'eqhost.txt'))) {
    New-Item -ItemType Directory -Force $orig | Out-Null
    Copy-Item $hostFile $orig
  }
  Set-Content -Path $hostFile -Encoding ASCII -Value @(
    '[Registration Servers]', '{', '"127.0.0.1:6000"', '}',
    '[Login Servers]', '{', '"127.0.0.1:6000"', '}')
  Ok "Client points at the local server."

  # Desktop shortcut.
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'EQ B-Roll.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $ClientDir
  $s.Save()
  Ok "Desktop shortcut: EQ B-Roll"
}

# --- 4. Mouse -----------------------------------------------------------------------------------
function Check-Mouse {
  Step "Mouse"
  Add-Type -Namespace BRoll -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);'
  if ([BRoll.U]::GetSystemMetrics(19) -eq 0) {
    Warn ("Windows reports NO mouse attached. The game will crash when you click Play. This happens " +
          "on PCs used only through remote desktop / VNC. Plug in any mouse, or see problem #2 in " +
          "docs/LOCAL_SERVER.md for a virtual-mouse driver.")
  } else {
    Ok "A mouse is attached."
  }
}

# --- 5. Studio ----------------------------------------------------------------------------------
function Ensure-Studio {
  Step "Studio (synthetic renderer)"
  $pyDir = Join-Path $Root 'tools\python'
  $py = Join-Path $pyDir 'python.exe'
  if (-not (Test-Path $py)) {
    $zip = Join-Path $env:TEMP 'python-embed.zip'
    Download $PyUrl $zip
    if ((Sha $zip) -ne $PySha) { Fail "Downloaded Python does not match the tested version." }
    New-Item -ItemType Directory -Force $pyDir | Out-Null
    Expand-Archive -Force $zip $pyDir
    Remove-Item $zip
  }
  Ok "Python ready (private copy in tools\python)."
  Info "Exporting starter zones from the client: $($StudioZones -join ', ')"
  Info "(first time: a few minutes; add more later with tools\python\python.exe broll.py extract <zone>)"
  Push-Location $Root
  try { $rc = Native $py (@('broll.py', 'extract') + $StudioZones + @('--eq', $ClientDir)) } finally { Pop-Location }
  if ($rc -ne 0) { Warn "Some zones did not export; the Studio still works with the others." }

  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'EQ B-Roll Studio.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = $py
  $s.Arguments = '"' + (Join-Path $Root 'broll.py') + '" serve'
  $s.WorkingDirectory = $Root
  $s.Save()
  Ok "Desktop shortcut: EQ B-Roll Studio (opens in your browser; close its window to stop it)"
}

# --- main ---------------------------------------------------------------------------------------
Write-Host "EQ B-Roll setup" -ForegroundColor White
if (-not $SkipServer) { Ensure-Docker; Ensure-Server }
if (-not $SkipClient) { Ensure-Client }
Check-Mouse
if (-not $SkipStudio) { Ensure-Studio }

Write-Host @"

All set. Two ways to film:

EQ B-Roll Studio (desktop shortcut) - camera paths through the zones, rendered to MP4.
  Fly with WASD + mouse, press K to drop keyframes, P to preview, then Render MP4.

EQ B-Roll (the real game on your private server):
  1. Double-click "EQ B-Roll" on the desktop.
  2. Log in with ANY name and password (the first time it asks twice), create any character.
     Every character here is a GM that can fly, can't die, and nothing attacks.
  3. In game: Options (Alt+O) -> Display -> Clip Plane all the way up, Level of Detail off.

Handy commands (type in the chat box):
  #zone qeynos                 go to a zone (short names: gfaydark, northkarana, erudsxing...)
  #goto -551 315 44            teleport to x y z  (/loc shows these as y, x, z)
  Page Up / Page Down + W      fly up / down
  #set time 19                 time of day (0-23)
  #set weather 1 0 30          rain for 30 min (2 = snow, 0 = clear; clear before switching)
  #set zone clipping 500 10000 2000 9500   view distance / fog, if you want to tweak it
"@ -ForegroundColor White
