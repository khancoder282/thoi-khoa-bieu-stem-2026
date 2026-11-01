#!/usr/bin/env bash
# ============================================================
#  Bỏ rate-limit (chống DDoS) RIÊNG cho vhost monitor.tponegroup.net
#  trên vps-tpone. Agent giám sát POST liên tục (activity 5s, screenshot 30s,
#  live tới 8 khung/s — mỗi khung 1 POST) nên hay bị lớp anon 10r/s trả 429.
#
#  Chạy TRÊN vps-tpone, quyền root:
#     sudo bash vps-tpone-monitor-no-ratelimit.sh            # tắt rate-limit
#     sudo bash vps-tpone-monitor-no-ratelimit.sh --revert   # bật lại
#
#  An toàn: backup trước, nginx -t trước khi reload, lỗi thì tự khôi phục.
#  Chỉ sửa đúng file vhost monitor, KHÔNG đụng snippet dùng chung của vhost khác.
# ============================================================
set -euo pipefail

CONF=/etc/nginx/conf.d/20-monitor.tponegroup.net.conf
TS=$(date +%Y%m%d-%H%M%S)
MODE=${1:-off}

[ -f "$CONF" ] || { echo "KHÔNG thấy $CONF"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Cần chạy bằng root (sudo)."; exit 1; }

cp -a "$CONF" "$CONF.bak-$TS"
echo "Backup: $CONF.bak-$TS"

if [ "$MODE" = "--revert" ]; then
  # Bỏ comment để bật lại include ratelimit
  sed -i -E 's|^( *)#+ *(include /etc/nginx/snippets/tponegroup-ratelimit(-bulk)?\.conf;).*|\1\2|' "$CONF"
  echo "Đã BẬT LẠI rate-limit cho monitor."
else
  # Comment dòng include ratelimit (chỉ dòng chưa bị comment)
  sed -i -E 's|^( *)(include /etc/nginx/snippets/tponegroup-ratelimit(-bulk)?\.conf;)|\1# \2  # tat rate-limit cho monitor (agent goi lien tuc)|' "$CONF"
  echo "Đã TẮT rate-limit cho monitor."
fi

if nginx -t; then
  systemctl reload nginx
  echo "nginx -t OK, đã reload."
else
  echo "nginx -t LỖI -> khôi phục backup, KHÔNG reload."
  cp -a "$CONF.bak-$TS" "$CONF"
  exit 1
fi

echo "--- Dòng ratelimit hiện tại trong vhost monitor:"
grep -n 'tponegroup-ratelimit' "$CONF" || echo "(không còn include ratelimit nào)"

cat <<'NOTE'

LƯU Ý:
- File vhost này do script hạ tầng sinh ra (frp-subdomain-tls.sh) và rate-limit
  được quản lý ở ~/tponegroup-setup (ratelimit-vhosts.sh + apply.sh). Nếu sau này
  chạy apply.sh, include có thể bị thêm lại. Để giữ vĩnh viễn: loại monitor khỏi
  danh sách gắn snippet trong ratelimit-vhosts.sh của repo đó.
- Sau khi tắt, endpoint monitor KHÔNG còn giới hạn request ở nginx. Server vẫn có
  Basic Auth (dashboard) + x-agent-token (ingest). Nếu muốn vẫn chặn flood thô mà
  không ảnh hưởng agent, có thể thay bằng 1 limit chỉ theo IP, nới rộng (ví dụ
  150 r/s) — nhắn tôi sẽ viết biến thể đó.
NOTE
