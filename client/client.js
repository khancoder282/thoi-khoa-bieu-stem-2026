import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import net from 'net';
import crypto from 'crypto';
import { URL } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Directory of the running script / node.exe (works both as ESM source and as an esbuild CJS bundle)
const SELF_DIR = path.dirname(process.argv[1] || process.execPath);
const SELF_FILE = process.argv[1] || '';

// ---- Load config (prefer file next to node.exe / the script) ----
function loadConfig() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'config.json'), // next to node.exe (install dir)
    path.join(SELF_DIR, 'config.json'),                       // next to agent.cjs
    path.join(process.cwd(), 'config.json'),
  ];
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch {}
  }
  return {};
}
const cfg = loadConfig();
const SERVER = (process.env.SERVER || cfg.server || 'http://localhost:4000').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN || cfg.token || '';
const HOST = os.hostname();
const NAME = cfg.name || `${os.userInfo().username}@${HOST}`;
const ID = HOST;
const SHOT_SEC = Number(cfg.screenshotIntervalSec || 30);
const ACT_SEC = Number(cfg.activityIntervalSec || 5);
const QUALITY = Number(cfg.jpegQuality || 40);
const SHOT_MAX_W = Number(cfg.screenshotMaxWidth || 1920); // wider screens (2K/4K, multi-monitor) are downscaled to this width
const IDLE_SKIP_SEC = Number(cfg.idleSkipSec || 60);       // no input for this long => stop taking periodic screenshots
const LIVE_FPS = Number(cfg.liveFps || 8);
const LIVE_QUALITY = Number(cfg.liveJpegQuality || 50);
const LIVE_W = Number(cfg.liveMaxWidth || 1280); // live frames are downscaled to fit LIVE_W x LIVE_H (720p)
const LIVE_H = Number(cfg.liveMaxHeight || 720);
const PS_EXE = process.env.WM_PS || 'powershell'; // overridable for tests

// ---- Run with low CPU priority so the employee's own apps always win ----
const BELOW_NORMAL = (os.constants.priority || {}).PRIORITY_BELOW_NORMAL;
function lowPriority(pid) { try { if (BELOW_NORMAL !== undefined) os.setPriority(pid, BELOW_NORMAL); } catch {} }
lowPriority(process.pid);

// ---- Visible notice for the employee (runs in the open, not hidden) ----
console.log('==================================================');
console.log(' WORK MONITORING AGENT (deployed by your company)');
console.log(` Machine: ${NAME}`);
console.log(` Server:  ${SERVER}`);
console.log(` Token:   ${TOKEN ? TOKEN.length + ' chars' : 'MISSING (config not loaded!)'}`);
console.log(` Screenshot every ${SHOT_SEC}s, activity every ${ACT_SEC}s`);
console.log('==================================================\n');

// ---- Prepare PowerShell helper scripts (kept in the app folder alongside the agent) ----
const TMP = path.join(SELF_DIR, 'work');
try { fs.mkdirSync(TMP, { recursive: true }); } catch { /* fall back below */ }
if (!fs.existsSync(TMP)) { try { fs.mkdirSync(os.tmpdir(), { recursive: true }); } catch {} }
const PS_HOST = path.join(TMP, 'mon_host.ps1');
const PS_LIVE = path.join(TMP, 'mon_live.ps1');

// Native helpers, compiled ONCE into a cached DLL (C# 3 syntax so PowerShell 2.0 / Win7 can compile it)
const CS_SRC = `using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
public static class WmNative {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  static ImageCodecInfo jpeg;
  public static void Init() { try { SetProcessDPIAware(); } catch {} }
  public static IntPtr Fg() { return GetForegroundWindow(); }
  public static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static uint IdleMs() {
    LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l);
    if (!GetLastInputInfo(ref l)) return 0;
    return GetTickCount() - l.dwTime;
  }
  // Capture the whole virtual screen (all monitors), downscale to maxW, save as JPEG
  public static void Shot(string path, long quality, int maxW) {
    int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
    if (w <= 0 || h <= 0) throw new Exception("no screen");
    if (jpeg == null) foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
    EncoderParameters ep = new EncoderParameters(1);
    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
    using (Bitmap full = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
      if (maxW > 0 && w > maxW) {
        int nh = (int)((long)h * maxW / w);
        using (Bitmap sm = new Bitmap(maxW, nh, PixelFormat.Format24bppRgb)) {
          using (Graphics g2 = Graphics.FromImage(sm)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(full, 0, 0, maxW, nh); }
          sm.Save(path, jpeg, ep);
        }
      } else {
        full.Save(path, jpeg, ep);
      }
    }
  }
}
`;
const CS_VER = crypto.createHash('md5').update(CS_SRC).digest('hex').slice(0, 10);
// Drop DLLs compiled from older versions of the helper
try { for (const f of fs.readdirSync(TMP)) if (/^wm-[0-9a-f]+\.dll$/.test(f) && f !== `wm-${CS_VER}.dll`) fs.unlink(path.join(TMP, f), () => {}); } catch {}

// ONE long-running PowerShell host: compiles/loads the helpers once, then answers commands read from stdin
// (one per line, fields separated by TAB). Each reply ends with [char]4. Exits when stdin closes (agent died).
// Replaces the old "spawn powershell.exe + Add-Type compile" on every sample.
fs.writeFileSync(PS_HOST, `$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Net.ServicePointManager]::Expect100Continue = $false } catch {}
$Src = @"
${CS_SRC}"@
$Dll = Join-Path $Dir 'wm-${CS_VER}.dll'
$loaded = $false
if (Test-Path $Dll) { try { Add-Type -Path $Dll; $loaded = $true } catch {} }
if (-not $loaded) {
  try {
    Add-Type -TypeDefinition $Src -ReferencedAssemblies System.Drawing -OutputAssembly $Dll -OutputType Library
    Add-Type -Path $Dll; $loaded = $true
  } catch { try { Remove-Item $Dll -Force -ErrorAction SilentlyContinue } catch {} }
}
if (-not $loaded) { Add-Type -TypeDefinition $Src -ReferencedAssemblies System.Drawing }
[WmNative]::Init()
$uia = $true
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch { $uia = $false }

$S = [string][char]1
$EOT = [string][char]4
$TAB = [char]9
$procCache = @{}
$lastH = [IntPtr]::Zero; $lastTitle = $null; $lastUrl = ''

# For browsers, read the address-bar URL via UI Automation (Chrome/Edge/Firefox/Brave/Opera/Vivaldi)
function Get-BrowserUrl($h) {
  if (-not $uia) { return '' }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if (-not $el) { return '' }
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edits = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($e in $edits) {
      $vp = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $val = $vp.Current.Value
        if ($val -and $val -match '[A-Za-z0-9]\\.[A-Za-z]') { return $val }
      }
    }
  } catch {}
  return ''
}

function Do-Act {
  $h = [WmNative]::Fg()
  $title = ([WmNative]::Title($h)) -replace '[\\r\\n\\x01\\x04]', ' '
  $ownerPid = [WmNative]::Pid($h)
  $key = [string]$ownerPid
  if (-not $procCache.ContainsKey($key)) {
    if ($procCache.Count -gt 300) { $procCache.Clear() }
    $name = ''; $fpath = ''
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($proc) { $name = $proc.ProcessName; try { $fpath = $proc.MainModule.FileName } catch {} }
    $procCache[$key] = @($name, $fpath)
  }
  $name = $procCache[$key][0]; $fpath = $procCache[$key][1]
  # The URL only changes when the window or its title (= active tab) changes, so only then ask UI Automation
  $url = ''
  if ($name -match '^(chrome|msedge|firefox|brave|opera|vivaldi|chromium|iexplore)$') {
    if ($h -ne $script:lastH -or $title -ne $script:lastTitle) { $script:lastUrl = Get-BrowserUrl $h }
    $url = $script:lastUrl
  }
  $script:lastH = $h; $script:lastTitle = $title
  return $title + $S + $name + $S + $fpath + $S + $ownerPid + $S + [WmNative]::IdleMs() + $S + $url
}

# POST via WebClient: uses the Windows system proxy + certificate store (works where Node's direct connect is blocked)
function Do-Post($url, $token, $file, $ctype) {
  $p = Join-Path $Dir $file
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers.Add('Content-Type', $ctype)
    if ($token) { $wc.Headers.Add('x-agent-token', $token) }
    $resp = $wc.UploadData($url, 'POST', [System.IO.File]::ReadAllBytes($p))
    return '200' + $S + [System.Text.Encoding]::UTF8.GetString($resp)
  } catch [System.Net.WebException] {
    if ($_.Exception.Response) { return [string][int]$_.Exception.Response.StatusCode + $S }
    return '0' + $S
  } catch { return '0' + $S }
}

function Do-Get($url, $file) {
  try { (New-Object System.Net.WebClient).DownloadFile($url, (Join-Path $Dir $file)); return 'OK' }
  catch { return 'ERR ' + $_.Exception.Message }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = [Console]::Out
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $a = $line.Split($TAB)
  $r = ''
  try {
    switch ($a[0]) {
      'ACT'  { $r = Do-Act }
      'SHOT' { [WmNative]::Shot((Join-Path $Dir $a[1]), [long]$a[2], [int]$a[3]); $r = 'OK' }
      'POST' { $r = Do-Post $a[1] $a[2] $a[3] $a[4] }
      'GET'  { $r = Do-Get $a[1] $a[2] }
      'PING' { $r = 'PONG' }
      default { $r = 'ERR unknown' }
    }
  } catch { $r = 'ERR ' + ($_.Exception.Message -replace '[\\r\\n]', ' ') }
  $out.Write([string]$r + $EOT)
  $out.Flush()
}
`);

// Live view: ONE long-running PowerShell that loops capture -> downscale -> JPEG in memory -> POST raw bytes.
// Avoids a powershell.exe spawn + Add-Type compile per frame (the old ~1 fps bottleneck). Uploads via WebClient
// (system proxy + keep-alive). Exits on its own when the server answers live:false or keeps failing.
fs.writeFileSync(PS_LIVE, `param([string]$Url,[string]$Token,[int]$Fps=8,[int]$Quality=50,[int]$MaxW=1280,[int]$MaxH=720)
try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
  [void][Dpi]::SetProcessDPIAware()
} catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
[Net.ServicePointManager]::Expect100Continue = $false
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$md5 = $null
try { $md5 = [System.Security.Cryptography.MD5]::Create() } catch {} # may be blocked by FIPS policy -> just send every frame
$wc = New-Object System.Net.WebClient
$frameMs = [int](1000 / [Math]::Max(1, $Fps))
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$full = $null; $small = $null; $gFull = $null; $gSmall = $null
$lastHash = ''; $lastSent = -100000; $fails = 0
while ($true) {
  $t0 = $clock.ElapsedMilliseconds
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if (-not $full -or $full.Width -ne $b.Width -or $full.Height -ne $b.Height) {
    if ($gFull) { $gFull.Dispose(); $full.Dispose(); $gSmall.Dispose(); $small.Dispose() }
    $s = [Math]::Min(1.0, [Math]::Min($MaxW / $b.Width, $MaxH / $b.Height))
    $full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $gFull = [System.Drawing.Graphics]::FromImage($full)
    $small = New-Object System.Drawing.Bitmap([Math]::Max(1, [int]($b.Width * $s)), [Math]::Max(1, [int]($b.Height * $s)))
    $gSmall = [System.Drawing.Graphics]::FromImage($small)
    $gSmall.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
  }
  $ok = $true
  try { $gFull.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size) } catch { $ok = $false } # fails while the screen is locked
  if ($ok) {
    $gSmall.DrawImage($full, 0, 0, $small.Width, $small.Height)
    $ms = New-Object System.IO.MemoryStream
    $small.Save($ms, $enc, $ep)
    $bytes = $ms.ToArray(); $ms.Dispose()
    $hash = [string]$t0
    if ($md5) { $hash = [BitConverter]::ToString($md5.ComputeHash($bytes)) }
    # Skip unchanged frames, but still send one every 2s so the live:false answer arrives
    if ($hash -ne $lastHash -or ($t0 - $lastSent) -ge 2000) {
      try {
        $wc.Headers['Content-Type'] = 'image/jpeg'
        if ($Token) { $wc.Headers['x-agent-token'] = $Token }
        $resp = [System.Text.Encoding]::UTF8.GetString($wc.UploadData($Url, 'POST', $bytes))
        $lastHash = $hash; $lastSent = $t0; $fails = 0
        if ($resp -like '*"live":false*') { break }
      } catch {
        $fails++
        if ($fails -ge 10) { break }
        Start-Sleep -Milliseconds 1000
      }
    }
  } else {
    $fails++
    if ($fails -ge 60) { break }
    Start-Sleep -Milliseconds 1000
  }
  $wait = $frameMs - ($clock.ElapsedMilliseconds - $t0)
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
`);

// ---- Client for the long-running PowerShell host: one command at a time, restarted if it dies or hangs ----
const host = {
  proc: null,
  buf: Buffer.alloc(0),
  queue: [],   // [{ line, timeoutMs, resolve }]
  cur: null,   // command waiting for its reply
  backoffMs: 2000,
  nextStart: 0,
  start() {
    if (this.proc || Date.now() < this.nextStart) return !!this.proc;
    let p;
    try {
      p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_HOST], { windowsHide: true });
    } catch (e) { this.died(`spawn failed: ${e.message}`); return false; }
    this.proc = p;
    this.buf = Buffer.alloc(0);
    lowPriority(p.pid);
    let err = '';
    p.stdout.on('data', (d) => this.onData(d));
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
    p.stdin.on('error', () => {});
    const gone = () => { if (this.proc === p) { this.proc = null; this.died(err.split('\n')[0].trim()); } };
    p.on('exit', gone);
    p.on('error', gone);
    return true;
  },
  died(reason) {
    console.log(`[${nowTime()}] PowerShell helper stopped${reason ? ': ' + reason : ''} (restarting in ${Math.round(this.backoffMs / 1000)}s).`);
    this.nextStart = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    if (this.cur) { clearTimeout(this.cur.timer); this.cur.resolve(null); this.cur = null; }
    const q = this.queue; this.queue = [];
    for (const c of q) c.resolve(null);
  },
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let i;
    while ((i = this.buf.indexOf(4)) >= 0) { // 0x04 never occurs inside a UTF-8 multi-byte sequence
      const reply = this.buf.slice(0, i).toString('utf8');
      this.buf = this.buf.slice(i + 1);
      const c = this.cur;
      this.cur = null;
      if (c) { clearTimeout(c.timer); this.backoffMs = 2000; c.resolve(reply); }
      this.pump();
    }
  },
  // Resolves with the reply text, or null if the helper is unavailable / timed out
  call(line, timeoutMs = 20000) {
    return new Promise((resolve) => { this.queue.push({ line, timeoutMs, resolve }); this.pump(); });
  },
  pump() {
    if (this.cur || !this.queue.length) return;
    if (!this.start()) { const q = this.queue; this.queue = []; for (const c of q) c.resolve(null); return; }
    const c = this.queue.shift();
    this.cur = c;
    c.timer = setTimeout(() => { // hung (e.g. UI Automation stuck on a frozen app): kill and restart
      if (this.cur !== c) return;
      const p = this.proc;
      this.proc = null;
      try { p.kill(); } catch {}
      this.died('timeout');
    }, c.timeoutMs);
    try { this.proc.stdin.write(c.line + '\n'); } catch { /* exit handler resolves it */ }
  },
  stop() { const p = this.proc; this.proc = null; if (p) { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} } },
};

function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function tmpName(prefix, ext) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`; }

// ---- POST: try Node's direct HTTP(S) first; fall back to PowerShell WebClient ----
// Many corporate/home networks force an HTTP proxy: PowerShell/WebClient uses the system
// proxy + Windows cert store (so downloads work), while Node's direct connect is blocked.
let usePS = false; // once direct connect fails, stick to the proxy-aware PowerShell path

function postNode(pathname, body, ctype) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(SERVER + pathname); } catch { return resolve({ status: 0, body: '' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': ctype,
          'Content-Length': body.length,
          ...(TOKEN ? { 'x-agent-token': TOKEN } : {}),
        },
      },
      (res) => { let buf = ''; res.setEncoding('utf8'); res.on('data', (d) => { if (buf.length < 65536) buf += d; }); res.on('end', () => resolve({ status: res.statusCode, body: buf })); }
    );
    req.on('error', (e) => { lastErr = e.code || e.message || 'error'; resolve({ status: 0, body: '' }); });
    req.setTimeout(15000, () => { lastErr = 'timeout'; req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(body);
    req.end();
  });
}

async function postPS(pathname, body, ctype) {
  const name = tmpName('wmpost', 'bin');
  const tmp = path.join(TMP, name);
  try {
    fs.writeFileSync(tmp, body);
    const s = await host.call(['POST', SERVER + pathname, TOKEN, name, ctype].join('\t'), 30000);
    if (s == null) return { status: 0, body: '' };
    const sep = s.indexOf('\u0001');
    const code = parseInt((sep >= 0 ? s.slice(0, sep) : s).trim(), 10);
    return { status: Number.isNaN(code) ? 0 : code, body: sep >= 0 ? s.slice(sep + 1) : '' };
  } catch { return { status: 0, body: '' }; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Returns { status, body }
async function postBody(pathname, body, ctype) {
  if (!usePS) {
    const r = await postNode(pathname, body, ctype);
    if (r.status !== 0 && r.status !== 403 && r.status !== 407) return r; // got a real answer from our server
    usePS = true; // direct connect blocked -> switch to proxy-aware PowerShell POST
    if (!everLogged) console.log(`[${nowTime()}] Direct connect failed [${lastErr}] -> using system proxy (PowerShell).`);
  }
  return postPS(pathname, body, ctype);
}
function postJson(pathname, obj) { return postBody(pathname, Buffer.from(JSON.stringify(obj), 'utf8'), 'application/json'); }

let online = false;
let everLogged = false;
let lastErr = '';
function report(status) {
  const ok = status >= 200 && status < 300;
  if (ok !== online || !everLogged) {
    everLogged = true;
    online = ok;
    if (ok) console.log(`[${nowTime()}] Connected to server.`);
    else if (status === 401) console.log(`[${nowTime()}] REJECTED: HTTP 401 - wrong/missing token (check config.json).`);
    else if (status === 0) console.log(`[${nowTime()}] Server unreachable [${lastErr}], retrying...`);
    else console.log(`[${nowTime()}] Server error: HTTP ${status}, retrying...`);
  }
}

// ---- Collect activity ----
let lastIdleSec = 0;
let actBusy = false;
async function collectActivity() {
  if (actBusy) return; // previous sample still running (slow machine) -> skip, don't pile up
  actBusy = true;
  try {
    const s = (await host.call('ACT', 15000)) || '';
    const parts = s.startsWith('ERR') ? [] : s.split('\u0001');
    const idleMs = parseInt((parts[4] || '0').trim(), 10);
    lastIdleSec = Number.isNaN(idleMs) ? 0 : Math.round(idleMs / 1000);
    const res = await postJson('/ingest/activity', {
      id: ID, name: NAME, host: HOST,
      time: nowTime(),
      title: (parts[0] || '').trim(),
      app: (parts[1] || '').trim(),
      file: (parts[2] || '').trim(),
      pid: (parts[3] || '').trim(),
      idleSec: lastIdleSec,
      url: (parts[5] || '').trim(),
    });
    report(res.status);
    handleLive(res.body);
    checkUpdate(res.body);
  } catch (e) {
    console.log('Activity error:', e.message);
  } finally { actBusy = false; }
}

// ---- Capture screenshot ----
let idleShotTaken = false; // one screenshot when the machine goes idle, then none until input resumes
let shotBusy = false;
async function captureScreenshot() {
  if (shotBusy) return;
  if (lastIdleSec >= IDLE_SKIP_SEC) {
    if (idleShotTaken) return;
    idleShotTaken = true;
  } else idleShotTaken = false;
  shotBusy = true;
  try { await takeScreenshot(); } finally { shotBusy = false; }
}
async function takeScreenshot() {
  const name = tmpName('mon', 'jpg');
  const tmpImg = path.join(TMP, name);
  try {
    const r0 = await host.call(['SHOT', name, QUALITY, SHOT_MAX_W].join('\t'), 30000);
    if (r0 === 'OK' && fs.existsSync(tmpImg)) {
      const data = fs.readFileSync(tmpImg);
      fs.unlink(tmpImg, () => {});
      const t = nowTime();
      const q = `id=${encodeURIComponent(ID)}&name=${encodeURIComponent(NAME)}&host=${encodeURIComponent(HOST)}&time=${encodeURIComponent(t)}`;
      const r = await postBody(`/ingest/screenshot?${q}`, data, 'image/jpeg'); // raw JPEG, no base64
      if (r.status >= 200 && r.status < 300) console.log(`[${t}] Screenshot sent (${Math.round(data.length / 1024)} KB).`);
      else console.log(`[${t}] Screenshot POST failed [${r.status === 0 ? lastErr : 'HTTP ' + r.status}].`);
    } else {
      console.log(`[${nowTime()}] Screenshot capture failed${r0 ? ': ' + r0.split('\n')[0] : ' (helper unavailable)'}.`);
      try { fs.unlinkSync(tmpImg); } catch {}
    }
  } catch (e) {
    console.log('Screenshot error:', e.message);
  }
}

// ---- On-demand live view: when someone is watching, stream 720p JPEG to /ingest/live (NOT saved on server) ----
let liveProc = null;
function handleLive(body) {
  let want = false;
  try { want = !!JSON.parse(body || '{}').live; } catch {}
  if (want && !liveProc) startLive();
  else if (!want && liveProc) { try { liveProc.kill(); } catch {} }
}
function startLive() {
  const url = `${SERVER}/ingest/live?id=${encodeURIComponent(ID)}`;
  let p;
  try {
    p = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_LIVE,
      '-Url', url, '-Token', TOKEN, '-Fps', String(LIVE_FPS), '-Quality', String(LIVE_QUALITY),
      '-MaxW', String(LIVE_W), '-MaxH', String(LIVE_H)], { windowsHide: true, stdio: 'ignore' });
  } catch (e) { console.log('Live view error:', e.message); return; }
  liveProc = p;
  lowPriority(p.pid);
  console.log(`[${nowTime()}] Live view started (${LIVE_FPS} fps, max ${LIVE_W}x${LIVE_H}).`);
  const done = () => { if (liveProc === p) { liveProc = null; console.log(`[${nowTime()}] Live view stopped.`); } };
  p.on('exit', done);
  p.on('error', done);
}
process.on('exit', () => { if (liveProc) try { liveProc.kill(); } catch {} host.stop(); });

// ---- Self-update: the server announces the md5 of its agent.cjs; if ours differs, fetch it and restart ----
// (so a machine only needs the installer once; later agent versions roll out by themselves)
let SELF_HASH = '';
try { SELF_HASH = crypto.createHash('md5').update(fs.readFileSync(SELF_FILE)).digest('hex'); } catch {}
let updateTriedAt = 0;
let updating = false;

function getNode(url, dest) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(true)));
      ws.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(30000, () => { req.destroy(); resolve(false); });
  });
}

async function checkUpdate(body) {
  let want = '';
  try { want = JSON.parse(body || '{}').agent || ''; } catch {}
  if (!want || !SELF_HASH || want === SELF_HASH || updating || !SELF_FILE.endsWith('.cjs')) return;
  if (Date.now() - updateTriedAt < 60 * 60 * 1000) return; // at most one attempt per hour
  updating = true;
  updateTriedAt = Date.now();
  const name = tmpName('agent', 'new');
  const tmp = path.join(TMP, name);
  try {
    const url = `${SERVER}/download/agent.cjs`;
    let ok = !usePS && await getNode(url, tmp);
    if (!ok) ok = (await host.call(['GET', url, name].join('\t'), 120000)) === 'OK';
    const got = ok && fs.existsSync(tmp) ? crypto.createHash('md5').update(fs.readFileSync(tmp)).digest('hex') : '';
    if (got !== want) { console.log(`[${nowTime()}] Update download failed, will retry later.`); return; }
    fs.renameSync(tmp, SELF_FILE);
    console.log(`[${nowTime()}] Agent updated (${SELF_HASH.slice(0, 8)} -> ${want.slice(0, 8)}), restarting...`);
    restart();
  } catch (e) {
    console.log(`[${nowTime()}] Update error: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    updating = false;
  }
}

// Under the launcher loop (agent-hidden.vbs) exit code 3 means "start me again"; otherwise relaunch ourselves
function restart() {
  if (liveProc) try { liveProc.kill(); } catch {}
  host.stop();
  if (lock) lock.close();
  if (!process.env.WM_SUPERVISED) {
    try {
      spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd: SELF_DIR }).unref();
    } catch {}
  }
  setTimeout(() => process.exit(3), 300);
}

// ---- Single instance per user: hold a localhost port as a lock (a second copy waits, then quits) ----
const LOCK_PORT = 47000 + (parseInt(crypto.createHash('md5').update(os.userInfo().username).digest('hex').slice(0, 4), 16) % 900);
let lock = null;
function acquireLock(triesLeft) {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.destroy());
    s.once('error', () => {
      if (triesLeft <= 0) return resolve(false);
      setTimeout(() => acquireLock(triesLeft - 1).then(resolve), 2000); // e.g. the old copy is still exiting after an update
    });
    s.listen(LOCK_PORT, '127.0.0.1', () => { lock = s; resolve(true); });
  });
}

function main() {
  // ---- Immediate registration heartbeat (independent of PowerShell) ----
  (async () => {
    const res = await postJson('/ingest/activity', {
      id: ID, name: NAME, host: HOST, time: nowTime(),
      app: '', title: '(agent started)', file: '', pid: '',
    });
    report(res.status);
  })();

  // ---- Schedule ----
  collectActivity();
  captureScreenshot();
  setInterval(collectActivity, ACT_SEC * 1000);
  setInterval(captureScreenshot, SHOT_SEC * 1000);
}

acquireLock(10).then((ok) => {
  if (!ok) { console.log('Another copy of the agent is already running - exiting.'); process.exit(0); }
  main();
});

process.on('SIGINT', () => { console.log('\nAgent stopped.'); process.exit(0); });
