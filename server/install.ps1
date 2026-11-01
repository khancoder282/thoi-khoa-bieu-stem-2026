# ============================================================
#  Work Monitoring Agent - Windows installer
#  Usage (run on the employee PC):
#    powershell -c "irm __SERVER_URL__/install.ps1 | iex"
#  Installs per-user (no admin required), auto-detects 32/64-bit.
# ============================================================

$ErrorActionPreference = 'Stop'
$Server = '__SERVER_URL__'

Write-Host ''
Write-Host '============================================================'
Write-Host '  Work Monitoring Agent - Installer'
Write-Host '============================================================'

# --- Detect operating system ---
$os   = (Get-WmiObject Win32_OperatingSystem).Caption
$is64 = [Environment]::Is64BitOperatingSystem
$arch = if ($is64) { 'x64 (64-bit)' } else { 'x86 (32-bit)' }
Write-Host ("  Detected OS   : {0}" -f $os)
Write-Host ("  Architecture  : {0}" -f $arch)
Write-Host ("  Server        : {0}" -f $Server)
Write-Host ''

# --- Enable TLS 1.2 (needed for https downloads on older Windows) ---
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# --- Install location (per-user, no admin needed) ---
$InstallDir = Join-Path $env:LOCALAPPDATA 'WorkMonitor'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'work') | Out-Null
$NodePath  = Join-Path $InstallDir 'node.exe'      # bundled Node 12 runtime (supports Win7 SP1)
$AgentPath = Join-Path $InstallDir 'agent.cjs'     # bundled agent code (no npm install needed)
$CfgPath   = Join-Path $InstallDir 'config.json'

# --- Allow the screen-capture helper to run (Windows Defender flags screen capture as suspicious) ---
# This company tool needs the install folder on Defender's exclusion list. Asks once via UAC if needed.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Add-DefenderExclusion($dir) {
  Add-MpPreference -ExclusionPath $dir -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue
}
$DefenderMark = Join-Path $InstallDir '.defender-ok'   # set after the one-time approval -> later installs/updates never ask again
if (Test-Path $DefenderMark) {
  Write-Host '  Defender      : exclusion already approved'
} elseif ($isAdmin) {
  try { Add-DefenderExclusion $InstallDir; Set-Content -Path $DefenderMark -Value 'ok'; Write-Host '  Defender      : exclusion added (screenshots enabled)' }
  catch { Write-Host '  Defender      : could not add exclusion (screenshots may be blocked)' -ForegroundColor Yellow }
} else {
  Write-Host '  Defender      : screenshots need a one-time approval (a UAC prompt will appear)...'
  try {
    $cmd = "Add-MpPreference -ExclusionPath '$InstallDir' -ErrorAction SilentlyContinue; Add-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue"
    Start-Process -FilePath 'powershell' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',$cmd -Wait
    Set-Content -Path $DefenderMark -Value 'ok'
    Write-Host '  Defender      : exclusion added (screenshots enabled)'
  } catch {
    Write-Host '  Defender      : approval declined - screenshots stay off (activity + idle still work)' -ForegroundColor Yellow
  }
}

# --- Stop any running instance before replacing (only our own node/powershell, not other Node apps) ---
function Stop-Agent {
  try {
    Get-WmiObject Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='powershell.exe'" |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$InstallDir*" } |
      ForEach-Object { try { [void]$_.Terminate() } catch {} }
  } catch {}
}
Stop-Agent
Start-Sleep -Milliseconds 400

# --- Download helper with retries ---
function Get-File($url, $dest) {
  for ($i = 1; $i -le 3; $i++) {
    try { (New-Object System.Net.WebClient).DownloadFile($url, $dest); return $true }
    catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

# Runtime (~25 MB): reuse if already present to avoid slow/flaky re-downloads
if ((Test-Path $NodePath) -and ((Get-Item $NodePath).Length -gt 20MB)) {
  Write-Host '  Runtime       : already installed (reused)'
} else {
  Write-Host '  Downloading   : runtime (node.exe, ~25 MB)'
  if (-not (Get-File "$Server/download/node.exe" $NodePath)) {
    Write-Host ''
    Write-Host ("  ERROR: could not download node.exe from {0}" -f $Server) -ForegroundColor Red
    Write-Host '  Check the network/server, then run the installer again.' -ForegroundColor Red
    return
  }
}

# Agent code (tiny): always refresh
Write-Host '  Downloading   : agent (agent.cjs)'
if (-not (Get-File "$Server/download/agent.cjs" $AgentPath)) {
  Write-Host ''
  Write-Host ("  ERROR: could not download agent.cjs from {0}" -f $Server) -ForegroundColor Red
  Write-Host '  Check the network/server, then run the installer again.' -ForegroundColor Red
  return
}

# --- Write config.json (points the agent at this server) ---
$cfg = @{
  server                = $Server
  token                 = '__AGENT_TOKEN__'
  name                  = ''
  screenshotIntervalSec = 30
  activityIntervalSec   = 5
  jpegQuality           = 40
} | ConvertTo-Json
# Write UTF-8 WITHOUT BOM (Windows PowerShell 5.1 Set-Content -Encoding UTF8 adds a BOM that breaks JSON.parse)
[System.IO.File]::WriteAllText($CfgPath, $cfg, (New-Object System.Text.UTF8Encoding $false))

# --- Hidden launcher: run node with NO visible console window (via wscript + VBScript) ---
$VbsPath = Join-Path $InstallDir 'agent-hidden.vbs'
$vbs = @'
' Keeps the agent running: restarts it if it crashes or after a self-update (exit code 3).
' Exit code 0 = stopped on purpose / another copy already running -> stop looping.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
sh.Environment("PROCESS")("WM_SUPERVISED") = "1"
sh.CurrentDirectory = dir
Do
  rc = sh.Run(q & dir & "\node.exe" & q & " " & q & dir & "\agent.cjs" & q, 0, True)
  If rc = 0 Then Exit Do
  If rc = 3 Then WScript.Sleep 1000 Else WScript.Sleep 10000
Loop
'@
[System.IO.File]::WriteAllText($VbsPath, $vbs, (New-Object System.Text.ASCIIEncoding))

# --- Auto-start at user logon (no admin: HKCU Run key), launched hidden via wscript ---
try {
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'WorkMonitorAgent' -Value ('wscript.exe "{0}"' -f $VbsPath) -PropertyType String -Force | Out-Null
  Write-Host '  Auto-start    : enabled (runs hidden at logon)'
} catch {
  Write-Host '  Auto-start    : could not register (continuing anyway)' -ForegroundColor Yellow
}

# --- Launch now (hidden, no console window) ---
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"{0}"' -f $VbsPath) -WorkingDirectory $InstallDir

Write-Host ''
Write-Host '  Installation complete. The agent is now running.' -ForegroundColor Green
Write-Host ("  Installed at  : {0}" -f $InstallDir)
Write-Host '  This machine is being monitored for work activity by your company.'
Write-Host '============================================================'
Write-Host ''
