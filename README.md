# Công cụ giám sát công việc nhân viên (Windows 7/10 · 32/64-bit · Node.js)

Hệ thống gồm 2 phần:

- **server/** — dashboard web theo dõi trực tiếp, nhận ảnh màn hình, ghi log hoạt động thành file `.txt` theo ngày.
- **client/** — *agent* cài trên máy nhân viên: **30s chụp 1 ảnh màn hình**, liên tục gửi **log hoạt động** (cửa sổ đang mở, phần mềm đang dùng, đường dẫn file/tiến trình) lên server.

> ⚠️ **Pháp lý & đạo đức.** Chỉ dùng để giám sát năng suất trên **máy do công ty sở hữu**, và **phải thông báo cho nhân viên**. Agent chạy **công khai** (có cửa sổ console + dòng thông báo), không ẩn/giấu.

## Công nghệ

- Server: Node.js + Express + Socket.IO. Không DB — log ghi thẳng ra `.txt`, ảnh lưu `.jpg`. Dashboard có HTTP Basic Auth; agent phải gửi token mới push được dữ liệu.
- Client: **Node.js không phụ thuộc npm nào** (dùng `http` built-in + PowerShell sẵn có của Windows để chụp màn hình và lấy cửa sổ/tiến trình active). Không cần biên dịch native → chạy Win7/10, 32 & 64-bit.

---

## 🚀 Triển khai thực tế đang chạy

```
Máy nhân viên (Windows)                 trixco-main (server nhà)
  agent (node.exe + agent.cjs)   ─┐        ├─ work-monitor.service (systemd)
                                  │        │    Node server, 127.0.0.1:4300
   HTTPS/HTTP monitor.tponegroup  │        │    DATA_DIR = /mnt/storage-4t/work-monitor/data
        .net                      │        └─ frpc  ──┐
                                  │                    │ FRP tunnel (subdomain=monitor)
                                  ▼                    ▼
                         vps-tpone (103.72.98.150): nginx 443 → frps :8080 → trixco:4300
```

- **Server** chạy trên `trixco` (`trixco-main`) qua systemd unit `work-monitor.service`, cổng nội bộ `127.0.0.1:4300`.
- **Dữ liệu** (ảnh + log) lưu ở **ổ 4TB**: `/mnt/storage-4t/work-monitor/data`.
- **Ra Internet** qua FRP: frpc trên trixco (`/opt/frp/frpc.toml`, proxy `work-monitor`, `subdomain=monitor`) → frps trên `vps-tpone` (`:8080`) → nginx vps (`*.tponegroup.net`).
- **Secrets** nằm ở `/etc/work-monitor.env` trên trixco (token agent, user/pass dashboard). Xem/đổi:
  ```bash
  ssh trixco 'cat /etc/work-monitor.env'
  systemctl restart work-monitor   # sau khi đổi
  ```

### Cài lên máy nhân viên (một dòng)

Mở PowerShell trên máy Windows của nhân viên và chạy:

```powershell
powershell -c "irm https://monitor.tponegroup.net/install.ps1 | iex"
```

Script tự: nhận diện Windows (32/64-bit, phiên bản) → tải `node.exe` (Node 12, hỗ trợ Win7 SP1) + `agent.cjs` + ghi `config.json` (đã trỏ đúng server và nhúng token) vào `%LOCALAPPDATA%\WorkMonitor` → đăng ký tự chạy lúc đăng nhập (HKCU Run, **không cần quyền admin**) → chạy ngay. Mọi thông báo bằng **tiếng Anh**.

Agent chạy **ẩn, không hiện cửa sổ console** (qua `agent-hidden.vbs` + `wscript`, window style hidden). Nó vẫn hiện là tiến trình `node.exe` trong Task Manager. Muốn gỡ: xem mục cuối README.

> Nhắc lại: dù chạy ẩn cửa sổ, bạn vẫn nên **thông báo cho nhân viên** là máy công ty được giám sát — nhiều nơi luật yêu cầu, và tránh rủi ro pháp lý.

### Mở dashboard

`https://monitor.tponegroup.net` → đăng nhập bằng user/pass trong `/etc/work-monitor.env` (mặc định user `admin`).

### HTTPS

Hạ tầng tponegroup **tự cấp cert Let's Encrypt** cho subdomain mới đăng ký qua frpc (vhost `/etc/nginx/conf.d/20-monitor.tponegroup.net.conf` + cert được tạo tự động ngay sau khi thêm proxy). Không cần thao tác thủ công.

Vì frps làm rớt header `X-Forwarded-Proto`, server dùng biến env **`PUBLIC_URL=https://monitor.tponegroup.net`** (trong `/etc/work-monitor.env`) để `install.ps1` luôn nhúng đúng URL `https://`.

---

## Dữ liệu lưu trên server

```
/mnt/storage-4t/work-monitor/data/
  logs/2026-11-01/PC-NHANVIEN-01.txt       # log hoạt động theo ngày, mỗi máy 1 file
  screenshots/2026-11-01/PC-NHANVIEN-01/    # ảnh .jpg theo giờ-phút-giây
```

Mỗi dòng log:
```
[14:03:21] APP="WINWORD" | TITLE="Báo cáo.docx - Word" | FILE="C:\...\WINWORD.EXE" | PID=4821
```

## Build lại agent (khi sửa client)

Agent được bundle bằng esbuild thành 1 file `agent.cjs` (không node_modules) rồi server phát cho máy nhân viên tải kèm `node.exe`:

```bash
ssh trixco 'cd /opt/work-monitor/client && npm run build'   # tạo ../server/public/download/agent.cjs
```

## Chạy thử cục bộ (dev, không qua VPS)

```bash
cd server && npm install && npm start     # http://localhost:4000
cd client && npm start                     # (trên Windows) đọc config.json cạnh file
```

## Gỡ agent khỏi máy nhân viên

```powershell
taskkill /IM node.exe /F
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name WorkMonitorAgent
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\WorkMonitor"
```

## Giới hạn & hướng mở rộng

- Ảnh chụp toàn bộ màn hình ảo (hỗ trợ nhiều màn hình). Chưa che vùng nhạy cảm.
- Log file phẳng; muốn tìm kiếm/thống kê nâng cao có thể chuyển sang SQLite sau.
- Agent chạy ở tầng user; nhân viên có quyền admin vẫn có thể tắt (`taskkill`). Muốn bền hơn: cài dạng Windows Service.
