import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ----
const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data'); // e.g. /mnt/storage-4t/work-monitor/data
const SHOTS_DIR = path.join(DATA_DIR, 'screenshots');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const REPORTS_DIR = path.join(DATA_DIR, 'reports'); // archived daily reports (kept after raw logs/images are purged)
const DOWNLOAD_DIR = path.join(__dirname, 'public', 'download');
const OFFLINE_AFTER_MS = 90 * 1000; // mark a machine offline if no data within this window

// Security (set via env on a public deploy; empty = open, for LAN use)
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';      // agents must send this to POST data
const DASH_USER = process.env.DASH_USER || '';          // dashboard Basic Auth user
const DASH_PASS = process.env.DASH_PASS || '';          // dashboard Basic Auth password

for (const d of [DATA_DIR, SHOTS_DIR, LOGS_DIR, REPORTS_DIR, DOWNLOAD_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const app = express();
app.set('trust proxy', true); // behind nginx
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '25mb' })); // screenshots arrive as base64 JSON

// ---- Basic Auth for the dashboard (public paths stay open) ----
function checkBasic(req) {
  if (!DASH_USER && !DASH_PASS) return true; // auth disabled
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return u === DASH_USER && p === DASH_PASS;
}
const PUBLIC_PREFIXES = ['/install.ps1', '/download', '/ingest'];
app.use((req, res, next) => {
  if (PUBLIC_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (checkBasic(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Work Monitor"').status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SHOTS_DIR));

// Agents must present the token (when configured) to push data
function checkToken(req, res, next) {
  if (!AGENT_TOKEN) return next();
  if ((req.headers['x-agent-token'] || '') === AGENT_TOKEN) return next();
  res.status(401).json({ ok: false, error: 'bad token' });
}

// Protect the dashboard live channel with the same Basic Auth
io.use((socket, next) => {
  if (!DASH_USER && !DASH_PASS) return next();
  const h = socket.handshake.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (u === DASH_USER && p === DASH_PASS) return next();
  }
  next(new Error('unauthorized'));
});

const clients = new Map(); // id -> { id, name, host, lastSeen, lastShot, lastActivity, online }
const liveWanted = new Map(); // id -> expiry ms; set while a dashboard is watching the live view
function isLiveWanted(id) { const e = liveWanted.get(id); return !!(e && e > Date.now()); }

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function safe(name) {
  return String(name || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
}
function appendLog(clientId, line) {
  const dir = path.join(LOGS_DIR, today());
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFile(path.join(dir, `${safe(clientId)}.txt`), line + '\n', (err) => {
    if (err) console.error('Log write error:', err.message);
  });
}
// Structured event stream (one JSON per line) used by the report screen
function appendEvent(clientId, ev) {
  const dir = path.join(LOGS_DIR, today());
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFile(path.join(dir, `${safe(clientId)}.jsonl`), JSON.stringify(ev) + '\n', () => {});
}

// Extract a domain/host from a browser URL (handles values with or without scheme)
function domainOf(url) {
  if (!url) return '';
  let s = String(url).trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) return '';
  return s.toLowerCase();
}

// Aggregate a day's events for one machine: time per app + idle time
const IDLE_THRESHOLD = 60;   // seconds with no keyboard/mouse input => counted as idle
const MAX_GAP_MS = 20000;    // cap the gap between samples so offline periods don't inflate totals
function buildReport(day, client) {
  const file = path.join(LOGS_DIR, safe(day), `${safe(client)}.jsonl`);
  let events = [];
  try {
    for (const ln of fs.readFileSync(file, 'utf8').split('\n')) {
      if (ln.trim()) { try { events.push(JSON.parse(ln)); } catch {} }
    }
  } catch { return null; }
  if (!events.length) return null;
  events.sort((a, b) => a.t - b.t);

  const byApp = {}, byDomain = {};
  let activeMs = 0, idleMs = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i], next = events[i + 1];
    let dur = next ? Math.min(next.t - e.t, MAX_GAP_MS) : 5000;
    if (dur < 0) dur = 0;
    if ((e.idle || 0) >= IDLE_THRESHOLD) {
      idleMs += dur;
    } else {
      activeMs += dur;
      const app = e.app || '(unknown)';
      byApp[app] = (byApp[app] || 0) + dur;
      const dom = domainOf(e.url);
      if (dom) byDomain[dom] = (byDomain[dom] || 0) + dur;
    }
  }
  const apps = Object.entries(byApp)
    .map(([app, ms]) => ({ app, seconds: Math.round(ms / 1000) }))
    .sort((a, b) => b.seconds - a.seconds);
  const domains = Object.entries(byDomain)
    .map(([domain, ms]) => ({ domain, seconds: Math.round(ms / 1000) }))
    .sort((a, b) => b.seconds - a.seconds);
  return {
    client, day,
    firstSeen: events[0].time,
    lastSeen: events[events.length - 1].time,
    samples: events.length,
    activeSec: Math.round(activeMs / 1000),
    idleSec: Math.round(idleMs / 1000),
    idleThreshold: IDLE_THRESHOLD,
    apps,
    domains,
  };
}

// Get a report: live from today's raw events, or the archived summary for purged past days
function getReport(day, client) {
  const live = buildReport(day, client);
  if (live) return live;
  try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, safe(day), `${safe(client)}.json`), 'utf8')); }
  catch { return null; }
}

// ---- Retention: after a day ends, archive its report then delete raw logs + screenshots ----
function archiveDay(day) {
  const logDir = path.join(LOGS_DIR, day);
  let clients2 = [];
  try { clients2 = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')); } catch {}
  const outDir = path.join(REPORTS_DIR, day);
  fs.mkdirSync(outDir, { recursive: true });
  for (const c of clients2) {
    const r = buildReport(day, c);
    if (r) { try { fs.writeFileSync(path.join(outDir, `${safe(c)}.json`), JSON.stringify(r)); } catch {} }
  }
}
function retentionSweep() {
  const todayStr = today();
  let days = [];
  try { days = fs.readdirSync(LOGS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)); } catch {}
  for (const day of days) {
    if (day >= todayStr) continue; // keep today's raw data
    try {
      archiveDay(day);                                              // 1) save the summary report
      fs.rmSync(path.join(LOGS_DIR, day), { recursive: true, force: true });   // 2) delete raw logs (.txt/.jsonl)
      fs.rmSync(path.join(SHOTS_DIR, day), { recursive: true, force: true });  // 3) delete screenshots
      console.log(`[retention] archived report and purged raw logs + images for ${day}`);
    } catch (e) { console.error('[retention] error for', day, e.message); }
  }
}
retentionSweep();                               // run once at startup
setInterval(retentionSweep, 60 * 60 * 1000);    // and hourly (catches the day rollover)
function touch(id, name, host) {
  const c = clients.get(id) || { id, name, host, lastShot: null, lastActivity: null };
  c.name = name || c.name || id;
  c.host = host || c.host || '';
  c.online = true;
  c.lastSeen = Date.now();
  clients.set(id, c);
  return c;
}

// ---- Ingest endpoints (agent -> server over plain HTTP) ----
app.post('/ingest/activity', checkToken, (req, res) => {
  const b = req.body || {};
  const id = safe(b.id);
  const c = touch(id, b.name, b.host);
  const idleSec = Math.max(0, parseInt(b.idleSec, 10) || 0);
  const url = (b.url || '').slice(0, 2048);
  const a = { time: b.time || nowTime(), app: b.app || '', title: b.title || '', file: b.file || '', pid: b.pid || '', idleSec, url };
  c.lastActivity = a;
  appendLog(id, `[${a.time}] APP="${a.app}" | TITLE="${a.title}" | URL="${url}" | FILE="${a.file}" | PID=${a.pid} | IDLE=${idleSec}s`);
  appendEvent(id, { t: Date.now(), time: a.time, app: a.app, title: a.title, idle: idleSec, url });
  io.emit('activity', { id, ...a });
  io.emit('clients', [...clients.values()]);
  res.json({ ok: true, live: isLiveWanted(id) });
});

// Ephemeral live frame: relay to dashboards, do NOT save to disk
app.post('/ingest/live', checkToken, (req, res) => {
  const b = req.body || {};
  const id = safe(b.id);
  const c = clients.get(id);
  if (c) c.lastSeen = Date.now();
  io.emit('live', { id, data: b.data, time: b.time || nowTime() });
  res.json({ ok: true, live: isLiveWanted(id) });
});

// Dashboard turns live view on/off for a machine (Basic-Auth protected under the global middleware)
app.post('/api/live/start/:client', (req, res) => { liveWanted.set(safe(req.params.client), Date.now() + 12000); res.json({ ok: true }); });
app.post('/api/live/stop/:client', (req, res) => { liveWanted.delete(safe(req.params.client)); res.json({ ok: true }); });

app.post('/ingest/screenshot', checkToken, (req, res) => {
  const b = req.body || {};
  const id = safe(b.id);
  const c = touch(id, b.name, b.host);
  try {
    const dir = path.join(SHOTS_DIR, today(), id);
    fs.mkdirSync(dir, { recursive: true });
    const ts = (b.time || nowTime()).replace(/:/g, '-');
    const buf = Buffer.from(b.data || '', 'base64');
    const rel = `/screenshots/${today()}/${id}/${ts}.jpg`;
    fs.writeFileSync(path.join(dir, `${ts}.jpg`), buf);
    c.lastShot = rel;
    appendLog(id, `[${nowTime()}] SCREENSHOT -> ${rel} (${buf.length} bytes)`);
    io.emit('screenshot', { id, url: rel, time: b.time || nowTime() });
    io.emit('clients', [...clients.values()]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Screenshot save error:', e.message);
    res.status(500).json({ ok: false });
  }
});

// Mark machines offline when they stop sending
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const c of clients.values()) {
    if (c.online && now - c.lastSeen > OFFLINE_AFTER_MS) {
      c.online = false;
      changed = true;
      appendLog(c.id, `===== ${today()} ${nowTime()} | OFFLINE (no data) =====`);
    }
  }
  if (changed) io.emit('clients', [...clients.values()]);
}, 15000);

// ---- Dashboard REST ----
app.get('/api/clients', (req, res) => res.json([...clients.values()]));

app.get('/api/log-days', (req, res) => {
  let days = [];
  try { days = fs.readdirSync(LOGS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)); } catch {}
  res.json(days.sort().reverse());
});
app.get('/api/logs/:day', (req, res) => {
  const dir = path.join(LOGS_DIR, safe(req.params.day));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')); } catch {}
  res.json(files);
});
app.get('/api/logs/:day/:file', (req, res) => {
  const full = path.join(LOGS_DIR, safe(req.params.day), safe(req.params.file));
  if (!full.startsWith(LOGS_DIR) || !fs.existsSync(full)) return res.status(404).send('Not found');
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(full, 'utf8'));
});
app.get('/api/shots/:day/:client', (req, res) => {
  const day = safe(req.params.day), client = safe(req.params.client);
  const dir = path.join(SHOTS_DIR, day, client);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.jpg$/i.test(f)); } catch {}
  res.json(files.sort().map((f) => `/screenshots/${day}/${client}/${f}`));
});

// Days that have a report (today's raw logs, or an archived summary)
app.get('/api/report-days', (req, res) => {
  const set = new Set();
  try { fs.readdirSync(LOGS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)).forEach((d) => set.add(d)); } catch {}
  try { fs.readdirSync(REPORTS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)).forEach((d) => set.add(d)); } catch {}
  res.json([...set].sort().reverse());
});
// Machines that have a report on a day (live events or archived summary)
app.get('/api/report/:day', (req, res) => {
  const day = safe(req.params.day);
  const set = new Set();
  try { fs.readdirSync(path.join(LOGS_DIR, day)).filter((f) => f.endsWith('.jsonl')).forEach((f) => set.add(f.replace(/\.jsonl$/, ''))); } catch {}
  try { fs.readdirSync(path.join(REPORTS_DIR, day)).filter((f) => f.endsWith('.json')).forEach((f) => set.add(f.replace(/\.json$/, ''))); } catch {}
  res.json([...set].sort());
});
app.get('/api/report/:day/:client', (req, res) => {
  const r = getReport(req.params.day, req.params.client);
  if (!r) return res.status(404).json({ error: 'no data' });
  res.json(r);
});

// ---- One-line installer (served with this server's own URL injected) ----
app.get('/install.ps1', (req, res) => {
  // Prefer an explicit PUBLIC_URL (set behind FRP/nginx where forwarded-proto may be lost)
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const tplPath = path.join(__dirname, 'install.ps1');
  let tpl = '';
  try { tpl = fs.readFileSync(tplPath, 'utf8'); } catch { return res.status(500).send('installer missing'); }
  const out = tpl.replace(/__SERVER_URL__/g, origin).replace(/__AGENT_TOKEN__/g, AGENT_TOKEN);
  res.type('text/plain; charset=utf-8').send(out);
});

// ---- Dashboard live channel ----
io.on('connection', (socket) => {
  socket.emit('clients', [...clients.values()]);
});

server.listen(PORT, () => {
  console.log(`\n  Monitoring server: http://localhost:${PORT}`);
  console.log(`  Install one-liner for Windows clients:`);
  console.log(`    powershell -c "irm http://<SERVER-IP>:${PORT}/install.ps1 | iex"`);
  console.log(`  Data stored at: ${DATA_DIR}\n`);
});
