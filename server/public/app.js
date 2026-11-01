const socket = io({ auth: { role: 'dashboard' } });
const statusEl = document.getElementById('status');
const grid = document.getElementById('clientGrid');
const empty = document.getElementById('empty');

const state = new Map(); // id -> client info

socket.on('connect', () => { statusEl.textContent = '● Đã kết nối server'; statusEl.className = 'status on'; });
socket.on('disconnect', () => { statusEl.textContent = '● Mất kết nối server'; statusEl.className = 'status off'; });

socket.on('clients', (list) => {
  state.clear();
  list.forEach((c) => state.set(c.id, c));
  render();
});

socket.on('activity', (a) => {
  const c = state.get(a.id) || { id: a.id, name: a.id };
  c.lastActivity = a;
  c.online = true;
  state.set(a.id, c);
  render();
  if (typeof reportOnActivity === 'function') reportOnActivity(a);
});

socket.on('screenshot', (s) => {
  const c = state.get(s.id) || { id: s.id, name: s.id };
  c.lastShot = s.url;
  c.lastShotTime = s.time;
  c.online = true;
  state.set(s.id, c);
  render();
  if (typeof reportOnShot === 'function') reportOnShot(s);
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function render() {
  const list = [...state.values()];
  empty.style.display = list.length ? 'none' : 'block';
  grid.innerHTML = list.map((c) => {
    const a = c.lastActivity || {};
    const g = gridFrames.get(c.id);
    const shot = g && g.at > Date.now() - 15000
      ? `<img class="shot" src="${g.url}" alt="live" /><span class="gridlive">● LIVE</span>`
      : c.lastShot
      ? `<img class="shot" src="${c.lastShot}?t=${encodeURIComponent(c.lastShotTime || '0')}" alt="screenshot" />`
      : `<div class="noshot">Chưa có ảnh</div>`;
    return `<div class="card clickable" data-card-client="${esc(c.id)}" title="Bấm để xem trực tiếp (720p)">
      ${shot}
      <div class="meta">
        <div class="name"><span class="dot ${c.online ? 'on' : 'off'}"></span>${esc(c.name)} <small style="color:#6b7280">${esc(c.host || '')}</small></div>
        <div class="act">
          <div><b>Phần mềm:</b> ${esc(a.app) || '—'}</div>
          <div><b>Cửa sổ:</b> ${esc(a.title) || '—'}</div>
          ${a.url ? `<div><b>Trang web:</b> ${esc(a.url)}</div>` : ''}
          <div><b>File/đường dẫn:</b> ${esc(a.file) || '—'}</div>
        </div>
        <div class="time">Cập nhật: ${esc(a.time || c.lastShotTime || '')}
          <span class="cardlinks"><span class="goreport" data-report-client="${esc(c.id)}">Báo cáo →</span></span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Tabs
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === name));
  if (name === 'report') loadReportDays();
  if (typeof refreshLiveSub === 'function') refreshLiveSub(); // start/stop inline live for the report tab
  if (typeof refreshGridSub === 'function') refreshGridSub(); // live grid only while the Truc tiep tab is shown
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => activateTab(t.dataset.tab));
});

// Modal xem anh lon
const modal = document.getElementById('modal');
const modalImg = document.getElementById('modalImg');
document.body.addEventListener('click', (e) => {
  const img = e.target.closest('[data-full]');
  if (img) { modalImg.src = img.dataset.full || img.src; modal.classList.remove('hidden'); return; }
  const repEl = e.target.closest('[data-report-client]');
  if (repEl) { e.stopPropagation(); openReportFor(repEl.dataset.reportClient); return; }
  const card = e.target.closest('.card[data-card-client]');
  if (card) { openLiveView(card.dataset.cardClient); return; }
  if (e.target === modal) modal.classList.add('hidden');
  if (e.target === liveModal) closeLiveView();
});

// ---- Xem truc tiep 720p ~8 fps (khong luu): dung chung cho modal va khung trai Bao cao ----
const liveModal = document.getElementById('liveModal');
let liveModalClient = null;
let liveSub = null; // { client, target: 'modal' | 'report', keepalive }

function desiredLive() {
  if (!liveModal.classList.contains('hidden') && liveModalClient) return { client: liveModalClient, target: 'modal' };
  if (document.getElementById('report').classList.contains('active') && viewer.realtime && viewer.client && rDay.value === todayStr())
    return { client: viewer.client, target: 'report' };
  return null;
}
function refreshLiveSub() {
  const d = desiredLive();
  if (!d) return stopLive();
  if (liveSub && liveSub.client === d.client && liveSub.target === d.target) return;
  stopLive();
  const ping = () => fetch(`/api/live/start/${encodeURIComponent(d.client)}`, { method: 'POST' }).catch(() => {});
  ping();
  liveSub = { client: d.client, target: d.target, keepalive: setInterval(ping, 4000) };
  socket.emit('live-sub', d.client);
}
function stopLive() {
  if (!liveSub) return;
  clearInterval(liveSub.keepalive);
  const cl = liveSub.client;
  liveSub = null;
  liveTimes = [];
  if (liveUrl) { URL.revokeObjectURL(liveUrl); liveUrl = null; } // free the last frame's blob
  document.getElementById('liveFps').textContent = '● LIVE · không lưu';
  socket.emit('live-sub', null);
  fetch(`/api/live/stop/${encodeURIComponent(cl)}`, { method: 'POST' }).catch(() => {});
}
function openLiveView(clientId) {
  liveModalClient = clientId;
  document.getElementById('liveTitle').textContent = 'Xem trực tiếp: ' + ((state.get(clientId) || {}).name || clientId);
  const img = document.getElementById('liveImg'), st = document.getElementById('liveStatus');
  img.style.display = 'none'; st.style.display = 'block'; st.textContent = 'Đang kết nối tới máy… (tối đa ~5s)';
  liveModal.classList.remove('hidden');
  refreshLiveSub();
}
function closeLiveView() {
  liveModal.classList.add('hidden');
  liveModalClient = null;
  document.getElementById('liveImg').src = '';
  refreshLiveSub(); // resume report-inline live if applicable
}
document.getElementById('liveClose').addEventListener('click', closeLiveView);

// ---- Luoi truc tiep: khi tab Truc tiep dang mo, moi may gui anh nho ~1 fps len the cua no ----
const gridFrames = new Map(); // id -> { url, at }
let gridTimer = null;
function refreshGridSub() {
  const want = document.getElementById('live').classList.contains('active') && !document.hidden;
  if (want === !!gridTimer) return;
  if (want) {
    const ping = () => fetch('/api/live/grid', { method: 'POST' }).catch(() => {});
    ping();
    gridTimer = setInterval(ping, 4000);
  } else {
    clearInterval(gridTimer); gridTimer = null;
    for (const f of gridFrames.values()) URL.revokeObjectURL(f.url); // free the last frame of every tile
    gridFrames.clear();
  }
  socket.emit('grid-sub', want);
}
document.addEventListener('visibilitychange', refreshGridSub);
function gridFrame(f) {
  const old = gridFrames.get(f.id);
  const url = URL.createObjectURL(new Blob([f.data], { type: 'image/jpeg' }));
  gridFrames.set(f.id, { url, at: Date.now() });
  if (old) setTimeout(() => URL.revokeObjectURL(old.url), 1000);
  const img = grid.querySelector(`.card[data-card-client="${CSS.escape(f.id)}"] img.shot`);
  if (img && img.alt === 'live') img.src = url;
  else render(); // first frame: swap the saved screenshot for the live one
}

socket.on('connect', () => { // rejoin the rooms after a reconnect
  if (liveSub) socket.emit('live-sub', liveSub.client);
  if (gridTimer) socket.emit('grid-sub', true);
});

// Frames arrive as binary JPEG (ArrayBuffer) -> show via a Blob URL, freeing the previous one
let liveUrl = null;
let liveTimes = []; // arrival times of recent frames, for the fps label
function liveSrc(data) {
  const old = liveUrl;
  liveUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  return liveUrl;
}
socket.on('live', (f) => {
  if (gridTimer) gridFrame(f);
  if (!liveSub || f.id !== liveSub.client) return;
  const now = Date.now();
  liveTimes = liveTimes.filter((t) => t > now - 2000).concat(now);
  document.getElementById('liveFps').textContent = `● LIVE ${(liveTimes.length / 2).toFixed(1)} fps · không lưu`;
  if (liveSub.target === 'modal') {
    const img = document.getElementById('liveImg'), st = document.getElementById('liveStatus');
    img.src = liveSrc(f.data); img.style.display = 'block'; st.style.display = 'none';
  } else {
    const img = document.getElementById('rImg'), no = document.getElementById('rNoshot'), t = document.getElementById('rShotTime');
    if (img) { img.src = liveSrc(f.data); img.removeAttribute('data-full'); img.style.display = 'block'; if (no) no.style.display = 'none'; if (t) t.textContent = (f.time || '') + ' (trực tiếp)'; }
  }
});

// ---- Bao cao (thoi gian dung app + idle) ----
const rDay = document.getElementById('rDay');
const rClient = document.getElementById('rClient');

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

let reportLoaded = false;
let curReportKey = '';
const viewer = { client: '', day: '', shots: [], realtime: true };

function todayStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shotTimeFromUrl(u) { const m = String(u).match(/(\d{2})-(\d{2})-(\d{2})\.jpg$/); return m ? `${m[1]}:${m[2]}:${m[3]}` : ''; }

async function loadReportDays() {
  const days = await (await fetch('/api/report-days')).json();
  rDay.innerHTML = days.map((d) => `<option>${d}</option>`).join('');
  if (days.length) await loadReportClients();
}
async function loadReportClients() {
  if (!rDay.value) return;
  const list = await (await fetch(`/api/report/${rDay.value}`)).json();
  rClient.innerHTML = list.map((c) => `<option>${c}</option>`).join('');
}
rDay.addEventListener('change', loadReportClients);

// ---- Viewer anh + timeline ----
function ensureSkeleton() {
  if (document.getElementById('rStats')) return;
  document.getElementById('reportBody').innerHTML = `
    <div class="rlayout">
      <div class="rleft">
        <div class="rshotwrap"><img id="rImg" class="rimg" alt="screenshot" style="display:none"/><div id="rNoshot" class="rnoshot">Chưa có ảnh</div></div>
        <div class="rtl">
          <input type="range" id="rSlider" min="0" max="0" value="0" step="1"/>
          <div class="rtlbar">
            <span id="rShotTime" class="rshottime">—</span>
            <button id="rLive" class="rlivebtn on">● Trực tiếp</button>
          </div>
        </div>
        <div class="rloghead">Nhật ký hoạt động <span>(bấm 1 dòng để nhảy tới ảnh)</span></div>
        <div id="rLog" class="rlog"></div>
      </div>
      <div class="rright" id="rStats"></div>
    </div>`;
  document.getElementById('rSlider').addEventListener('input', (e) => { viewer.realtime = false; showShot(+e.target.value); updateLiveBtn(); refreshLiveSub(); });
  document.getElementById('rLive').addEventListener('click', () => {
    viewer.realtime = true;
    const n = viewer.shots.length;
    const sl = document.getElementById('rSlider');
    if (sl && n) sl.value = n - 1;
    if (n) showShot(n - 1); // placeholder ảnh mới nhất trong lúc chờ khung live
    else setLogCur(logView.lines.length - 1);
    updateLiveBtn(); refreshLiveSub();
  });
  document.getElementById('rLog').addEventListener('click', (e) => {
    const el = e.target.closest('.rlogline');
    if (!el) return;
    const i = +el.dataset.i, l = logView.lines[i];
    if (!l || !l.time) return;
    viewer.realtime = false;
    if (viewer.shots.length) { // ảnh gần nhất chụp trước (hoặc đúng) thời điểm của dòng
      let j = viewer.shots.length - 1;
      while (j > 0 && viewer.shots[j].time > l.time) j--;
      document.getElementById('rSlider').value = j;
      showShot(j);
    }
    setLogCur(i, false); // giữ đúng dòng vừa bấm, không cuộn
    updateLiveBtn(); refreshLiveSub();
  });
}

// ---- Nhat ky tung dong: to dam dong khop voi vi tri timeline ----
const logView = { lines: [], cur: -1 }; // lines: [{ time: 'HH:MM:SS', text }]
function logLineHtml(l, i) { return `<div class="rlogline" data-i="${i}" title="${esc(l.text)}">${esc(l.text)}</div>`; }
function logLine(text) { const m = String(text).match(/(\d{2}:\d{2}:\d{2})/); return { time: m ? m[1] : '', text }; }
async function loadLog(day, client) {
  let txt = '';
  try { const res = await fetch(`/api/logs/${day}/${encodeURIComponent(client)}.txt`); if (res.ok) txt = await res.text(); } catch {}
  logView.lines = txt.split('\n').filter((s) => s.trim()).map(logLine);
  logView.cur = -1;
  // Hien moi nhat tren cung; data-i van la chi so theo thu tu thoi gian
  document.getElementById('rLog').innerHTML = logView.lines.map(logLineHtml).reverse().join('')
    || '<p class="empty">Không có nhật ký (ngày cũ chỉ giữ báo cáo tổng hợp).</p>';
}
// time = giờ của ảnh đang xem; null = trực tiếp (dòng mới nhất)
function markLog(time) {
  let i = logView.lines.length - 1;
  if (time != null) while (i >= 0 && !(logView.lines[i].time && logView.lines[i].time <= time)) i--;
  setLogCur(i);
}
function setLogCur(i, scroll = true) {
  const box = document.getElementById('rLog');
  if (!box || i === logView.cur) return;
  const old = box.querySelector('.rlogline.cur');
  if (old) old.classList.remove('cur');
  logView.cur = i;
  const el = i >= 0 ? box.querySelector(`.rlogline[data-i="${i}"]`) : null;
  if (!el) return;
  el.classList.add('cur');
  if (scroll) box.scrollTop = el.offsetTop - (box.clientHeight - el.offsetHeight) / 2; // chi cuon khung log, khong cuon trang
}
// Dong log moi qua socket (cung dinh dang voi server.js) -> them len dau, dang truc tiep thi to dam dong do
function reportOnActivity(a) {
  const box = document.getElementById('rLog');
  if (!box || a.id !== viewer.client || viewer.day !== todayStr()) return;
  if (!logView.lines.length) box.innerHTML = '';
  const l = logLine(`[${a.time}] APP="${a.app}" | TITLE="${a.title}" | URL="${a.url || ''}" | FILE="${a.file}" | PID=${a.pid} | IDLE=${a.idleSec}s`);
  logView.lines.push(l);
  box.insertAdjacentHTML('afterbegin', logLineHtml(l, logView.lines.length - 1));
  if (viewer.realtime) setLogCur(logView.lines.length - 1);
}
function updateLiveBtn() { const b = document.getElementById('rLive'); if (b) b.classList.toggle('on', viewer.realtime); }
function showShot(i) {
  const img = document.getElementById('rImg'), no = document.getElementById('rNoshot'), t = document.getElementById('rShotTime');
  if (!img) return;
  if (i < 0 || i >= viewer.shots.length) { img.style.display = 'none'; no.style.display = 'flex'; if (t) t.textContent = '—'; markLog(viewer.realtime ? null : ''); return; }
  const s = viewer.shots[i];
  img.src = s.url; img.dataset.full = s.url; img.style.display = 'block'; no.style.display = 'none';
  if (t) t.textContent = s.time + (viewer.realtime ? ' (mới nhất)' : '');
  markLog(viewer.realtime ? null : s.time);
}
async function loadShots(day, client) {
  const urls = await (await fetch(`/api/shots/${day}/${client}`)).json();
  viewer.shots = urls.map((u) => ({ url: u, time: shotTimeFromUrl(u) }));
  const sl = document.getElementById('rSlider');
  sl.max = Math.max(0, viewer.shots.length - 1);
  sl.value = Math.max(0, viewer.shots.length - 1);
  sl.disabled = viewer.shots.length === 0;
  viewer.realtime = true;
  showShot(viewer.shots.length - 1); // placeholder ngay; khung live se thay the
  updateLiveBtn();
  refreshLiveSub(); // bat stream truc tiep vao khung trai
}
// Goi tu socket khi co anh LUU moi (30s). Khi dang realtime thi khung live tu lo anh, chi cap nhat timeline.
function reportOnShot(s) {
  if (!document.getElementById('report').classList.contains('active')) return;
  if (s.id !== viewer.client || rDay.value !== todayStr()) return;
  viewer.shots.push({ url: s.url, time: s.time || shotTimeFromUrl(s.url) });
  const sl = document.getElementById('rSlider');
  if (sl) { sl.max = viewer.shots.length - 1; sl.disabled = false; if (viewer.realtime) sl.value = viewer.shots.length - 1; }
}

async function loadReport(showEmpty) {
  if (!rDay.value || !rClient.value) { if (showEmpty) document.getElementById('reportBody').innerHTML = '<p class="empty">Chưa có dữ liệu.</p>'; return; }
  const res = await fetch(`/api/report/${rDay.value}/${rClient.value}`);
  if (!res.ok) { if (showEmpty) document.getElementById('reportBody').innerHTML = '<p class="empty">Máy này chưa có dữ liệu báo cáo trong ngày đã chọn.</p>'; return; }
  const r = await res.json();
  const key = rDay.value + '|' + rClient.value;
  ensureSkeleton();
  renderStats(document.getElementById('rStats'), r);
  if (key !== curReportKey) {
    curReportKey = key;
    viewer.client = rClient.value; viewer.day = rDay.value;
    await loadLog(rDay.value, rClient.value); // truoc loadShots de showShot to dam dung dong
    await loadShots(rDay.value, rClient.value);
  }
  reportLoaded = true;
}
document.getElementById('rLoad').addEventListener('click', () => loadReport(true));

async function openReportFor(clientId) {
  activateTab('report');
  await loadReportDays();
  const today = todayStr();
  if ([...rDay.options].some((o) => o.value === today)) { rDay.value = today; await loadReportClients(); }
  if ([...rClient.options].some((o) => o.value === clientId)) rClient.value = clientId;
  loadReport(true);
}

// Tu dong cap nhat so lieu moi 20s khi dang o tab Bao cao (khong dong cham timeline)
setInterval(() => {
  if (reportLoaded && document.getElementById('report').classList.contains('active') && rDay.value && rClient.value) {
    fetch(`/api/report/${rDay.value}/${rClient.value}`).then((res) => res.ok ? res.json() : null).then((r) => {
      if (r && document.getElementById('rStats')) renderStats(document.getElementById('rStats'), r);
    }).catch(() => {});
  }
}, 20000);

function renderStats(el, r) {
  const total = r.activeSec + r.idleSec || 1;
  const activePct = Math.round((r.activeSec / total) * 100);
  const idlePct = 100 - activePct;
  const maxApp = r.apps.length ? r.apps[0].seconds : 1;

  const appRows = r.apps.map((a) => `
    <div class="rrow">
      <div class="rname" title="${esc(a.app)}">${esc(a.app)}</div>
      <div class="rbar"><div class="rfill" style="width:${Math.max(2, Math.round((a.seconds / maxApp) * 100))}%"></div></div>
      <div class="rtime">${fmtDur(a.seconds)}</div>
    </div>`).join('') || '<p class="empty">Không có ứng dụng nào được ghi nhận.</p>';

  el.innerHTML = `
    <div class="rsum">
      <div class="rcard"><div class="rlabel">Tổng thời gian theo dõi</div><div class="rbig">${fmtDur(total)}</div></div>
      <div class="rcard"><div class="rlabel">Đang làm việc</div><div class="rbig" style="color:#4ade80">${fmtDur(r.activeSec)} <small>(${activePct}%)</small></div></div>
      <div class="rcard"><div class="rlabel">Rảnh/không thao tác</div><div class="rbig" style="color:#fbbf24">${fmtDur(r.idleSec)} <small>(${idlePct}%)</small></div></div>
    </div>
    <div class="rsplit"><div class="rsplit-a" style="width:${activePct}%"></div><div class="rsplit-i" style="width:${idlePct}%"></div></div>
    <p class="rmeta">Từ ${esc(r.firstSeen)} đến ${esc(r.lastSeen)} · ${r.samples} mẫu · ngưỡng idle ${r.idleThreshold}s</p>
    <h3 class="rh">Thời gian dùng theo ứng dụng</h3>
    <div class="rlist">${appRows}</div>
    ${renderDomains(r)}`;
}

function renderDomains(r) {
  const doms = r.domains || [];
  if (!doms.length) return '';
  const maxD = doms[0].seconds || 1;
  const rows = doms.map((d) => `
    <div class="rrow">
      <div class="rname" title="${esc(d.domain)}">${esc(d.domain)}</div>
      <div class="rbar"><div class="rfill rfill-web" style="width:${Math.max(2, Math.round((d.seconds / maxD) * 100))}%"></div></div>
      <div class="rtime">${fmtDur(d.seconds)}</div>
    </div>`).join('');
  return `<h3 class="rh" style="margin-top:22px">Thời gian theo trang web (endpoint)</h3><div class="rlist">${rows}</div>`;
}

refreshGridSub(); // tab Truc tiep la tab mac dinh
