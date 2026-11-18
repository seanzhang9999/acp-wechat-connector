#!/bin/bash
set -euo pipefail
if systemctl is-active --quiet awei-wechat.service; then
  echo '云端微信服务正在运行，未覆盖登录态。'; exit 1
fi
exec sudo -H -u awei-wechat /usr/bin/flock -n /var/lib/awei-wechat/poll.lock /opt/awei-antigravity/node-v22.23.5-linux-x64/bin/node /opt/awei-antigravity/cloud-current/dist/bin/awei-cloud.js --login "$@"
