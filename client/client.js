import { spawn } from 'child_process';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Directory of the running script / node.exe (works both as ESM source and as an esbuild CJS bundle)
const SELF_DIR = path.dirname(process.argv[1] || process.execPath);

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
const PS_SHOT = path.join(TMP, 'mon_shot.ps1');
const PS_ACT = path.join(TMP, 'mon_act.ps1');
const PS_POST = path.join(TMP, 'mon_post.ps1');

fs.writeFileSync(PS_SHOT, `param([string]$Path,[int]$Quality=40)
# Make the process DPI-aware so CopyFromScreen captures the full physical resolution (not the scaled/logical one)
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
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
$bmp.Save($Path, $enc, $ps)
$g.Dispose(); $bmp.Dispose()
`);

// Use [char]1 as a separator so it also works on PowerShell 2.0 (Win7) without ConvertTo-Json
fs.writeFileSync(PS_ACT, `Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public static uint IdleMs() { LII l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return GetTickCount() - l.dwTime; }
}
"@
$h = [W]::GetForegroundWindow()
$len = [W]::GetWindowTextLength($h)
$sb = New-Object System.Text.StringBuilder($len + 1)
[void][W]::GetWindowText($h, $sb, $sb.Capacity)
$ownerPid = 0
[void][W]::GetWindowThreadProcessId($h, [ref]$ownerPid)
$proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
$name = ''
$fpath = ''
if ($proc) { $name = $proc.ProcessName; try { $fpath = $proc.MainModule.FileName } catch {} }

# For browsers, read the address-bar URL via UI Automation (Chrome/Edge/Firefox/Brave/Opera/Vivaldi)
$url = ''
if ($name -match '^(chrome|msedge|firefox|brave|opera|vivaldi|chromium|iexplore)$') {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($el) {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $edits = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($e in $edits) {
        $vp = $null
        if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
          $val = $vp.Current.Value
          if ($val -and $val -match '[A-Za-z0-9]\.[A-Za-z]') { $url = $val; break }
        }
      }
    }
  } catch {}
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write($sb.ToString() + [char]1 + $name + [char]1 + $fpath + [char]1 + $ownerPid + [char]1 + [W]::IdleMs() + [char]1 + $url)
`);

// POST via WebClient: uses the Windows system proxy + certificate store (works where Node's direct connect is blocked)
fs.writeFileSync(PS_POST, `param([string]$Url,[string]$Token,[string]$Payload)
try {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('Content-Type','application/json')
  if ($Token) { $wc.Headers.Add('x-agent-token', $Token) }
  $resp = $wc.UploadData($Url, 'POST', [System.IO.File]::ReadAllBytes($Payload))
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write('200' + [char]1 + [System.Text.Encoding]::UTF8.GetString($resp))
} catch [System.Net.WebException] {
  if ($_.Exception.Response) { [Console]::Out.Write([string][int]$_.Exception.Response.StatusCode + [char]1) } else { [Console]::Out.Write('0' + [char]1) }
} catch { [Console]::Out.Write('0' + [char]1) }
`);

function runPS(args) {
  return new Promise((resolve) => {
    let ps;
    try {
      ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], { windowsHide: true });
    } catch (e) { return resolve({ out: Buffer.alloc(0), err: e.message }); }
    let out = Buffer.alloc(0);
    let err = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch {} resolve({ out, err: 'timeout' }); }, 20000);
    ps.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => { clearTimeout(timer); resolve({ out, err: e.message }); });
    ps.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  });
}

function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- POST (JSON): try Node's direct HTTP(S) first; fall back to PowerShell WebClient ----
// Many corporate/home networks force an HTTP proxy: PowerShell/WebClient uses the system
// proxy + Windows cert store (so downloads work), while Node's direct connect is blocked.
let usePS = false; // once direct connect fails, stick to the proxy-aware PowerShell path

function postNode(pathname, obj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(SERVER + pathname); } catch { return resolve({ status: 0, body: '' }); }
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...(TOKEN ? { 'x-agent-token': TOKEN } : {}),
        },
      },
      (res) => { let buf = ''; res.setEncoding('utf8'); res.on('data', (d) => { if (buf.length < 65536) buf += d; }); res.on('end', () => resolve({ status: res.statusCode, body: buf })); }
    );
    req.on('error', (e) => { lastErr = e.code || e.message || 'error'; resolve({ status: 0, body: '' }); });
    req.setTimeout(8000, () => { lastErr = 'timeout'; req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(body);
    req.end();
  });
}

async function postPS(pathname, obj) {
  const tmp = path.join(TMP, `wmpost_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    const { out } = await runPS([PS_POST, '-Url', SERVER + pathname, '-Token', TOKEN, '-Payload', tmp]);
    const s = out.toString('utf8');
    const sep = s.indexOf('\u0001');
    const code = parseInt((sep >= 0 ? s.slice(0, sep) : s).trim(), 10);
    return { status: Number.isNaN(code) ? 0 : code, body: sep >= 0 ? s.slice(sep + 1) : '' };
  } catch { return { status: 0, body: '' }; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Returns { status, body }
async function postJson(pathname, obj) {
  if (!usePS) {
    const r = await postNode(pathname, obj);
    if ((r.status >= 200 && r.status < 300) || r.status === 401) return r;
    usePS = true; // direct connect blocked -> switch to proxy-aware PowerShell POST
    if (!everLogged) console.log(`[${nowTime()}] Direct connect failed [${lastErr}] -> using system proxy (PowerShell).`);
  }
  return postPS(pathname, obj);
}

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
async function collectActivity() {
  try {
    const { out } = await runPS([PS_ACT]);
    const parts = out.toString('utf8').split('\u0001');
    const idleMs = parseInt((parts[4] || '0').trim(), 10);
    const res = await postJson('/ingest/activity', {
      id: ID, name: NAME, host: HOST,
      time: nowTime(),
      title: (parts[0] || '').trim(),
      app: (parts[1] || '').trim(),
      file: (parts[2] || '').trim(),
      pid: (parts[3] || '').trim(),
      idleSec: Number.isNaN(idleMs) ? 0 : Math.round(idleMs / 1000),
      url: (parts[5] || '').trim(),
    });
    report(res.status);
    handleLive(res.body);
  } catch (e) {
    console.log('Activity error:', e.message);
  }
}

// ---- Capture screenshot ----
async function captureScreenshot() {
  const tmpImg = path.join(TMP, `mon_${Date.now()}.jpg`);
  try {
    const { err } = await runPS([PS_SHOT, '-Path', tmpImg, '-Quality', String(QUALITY)]);
    if (fs.existsSync(tmpImg)) {
      const data = fs.readFileSync(tmpImg).toString('base64');
      const r = await postJson('/ingest/screenshot', { id: ID, name: NAME, host: HOST, time: nowTime(), data });
      if (r.status >= 200 && r.status < 300) console.log(`[${nowTime()}] Screenshot sent (${Math.round(data.length / 1365)} KB).`);
      else console.log(`[${nowTime()}] Screenshot POST failed [${r.status === 0 ? lastErr : 'HTTP ' + r.status}].`);
      fs.unlink(tmpImg, () => {});
    } else {
      console.log(`[${nowTime()}] Screenshot capture failed${err ? ': ' + String(err).split('\n')[0] : ' (no image produced)'}.`);
    }
  } catch (e) {
    console.log('Screenshot error:', e.message);
  }
}

// ---- On-demand live view: when someone is watching, stream ~1 fps to /ingest/live (NOT saved on server) ----
let liveTimer = null;
let liveBusy = false;
function handleLive(body) {
  let want = false;
  try { want = !!JSON.parse(body || '{}').live; } catch {}
  if (want && !liveTimer) {
    console.log(`[${nowTime()}] Live view started (1 fps).`);
    liveTimer = setInterval(liveFrame, 1000);
  } else if (!want && liveTimer) {
    clearInterval(liveTimer); liveTimer = null;
    console.log(`[${nowTime()}] Live view stopped.`);
  }
}
async function liveFrame() {
  if (liveBusy) return; // skip if the previous frame is still capturing/sending
  liveBusy = true;
  const tmpImg = path.join(TMP, `live_${Date.now()}.jpg`);
  try {
    await runPS([PS_SHOT, '-Path', tmpImg, '-Quality', String(QUALITY)]);
    if (fs.existsSync(tmpImg)) {
      const data = fs.readFileSync(tmpImg).toString('base64');
      const r = await postJson('/ingest/live', { id: ID, time: nowTime(), data });
      fs.unlink(tmpImg, () => {});
      handleLive(r.body); // stop quickly (within ~1s) once the viewer closes
    }
  } catch {} finally { liveBusy = false; }
}

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

process.on('SIGINT', () => { console.log('\nAgent stopped.'); process.exit(0); });
