# ============================================================
#  Go agent giam sat khoi may nhan vien (Windows).
#  Chay trong PowerShell (nen bang quyen Administrator de go loai tru Defender).
#  Mot dong:
#    [Net.ServicePointManager]::SecurityProtocol = 3072; iex (New-Object Net.WebClient).DownloadString('https://monitor.tponegroup.net/download/uninstall.ps1')
# ============================================================
$ErrorActionPreference = 'SilentlyContinue'
$Dir = Join-Path $env:LOCALAPPDATA 'WorkMonitor'

Write-Host ''
Write-Host '============================================================'
Write-Host '  Go agent giam sat (WorkMonitor)'
Write-Host '============================================================'

# 1) Bo tu chay khi dang nhap (de khong bat lai o lan dang nhap sau)
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'WorkMonitorAgent' -ErrorAction SilentlyContinue
Write-Host '  Auto-start    : da xoa khoa Run (HKCU\...\WorkMonitorAgent)'

# 2) Tat tien trinh cua WorkMonitor: wscript (bo giam sat) + node + powershell con.
#    Loc theo CommandLine chua thu muc cai -> KHONG dong nham Node/PowerShell khac.
$killed = 0
try {
  Get-WmiObject Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='powershell.exe'" |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$Dir*" } |
    ForEach-Object { if ($_.Terminate() -eq 0) { $killed++ } }
} catch {}
Start-Sleep -Milliseconds 600
# Lan 2 phong truong hop bo giam sat kip bat lai node truoc khi bi tat
try {
  Get-WmiObject Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Dir*" } |
    ForEach-Object { if ($_.Terminate() -eq 0) { $killed++ } }
} catch {}
Write-Host ("  Processes     : da tat {0} tien trinh cua WorkMonitor" -f $killed)

# 3) Xoa thu muc cai
Start-Sleep -Milliseconds 300
Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
if (Test-Path $Dir) {
  Write-Host ('  Folder        : CHUA xoa duoc {0} (co the con file dang mo). Chay lai sau vai giay.' -f $Dir) -ForegroundColor Yellow
} else {
  Write-Host ('  Folder        : da xoa {0}' -f $Dir)
}

# 4) Go loai tru Windows Defender (can quyen Admin; khong co quyen thi bo qua)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Remove-MpPreference -ExclusionPath $Dir -ErrorAction SilentlyContinue
  Remove-MpPreference -ExclusionProcess 'node.exe' -ErrorAction SilentlyContinue
  Write-Host '  Defender      : da go loai tru'
} else {
  Write-Host '  Defender      : bo qua go loai tru (can chay bang quyen Administrator)'
}

Write-Host ''
Write-Host '  Hoan tat. May se bao OFFLINE tren dashboard sau khoang 90 giay.' -ForegroundColor Green
Write-Host '============================================================'
Write-Host ''
