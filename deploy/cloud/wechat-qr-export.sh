#!/bin/bash
# Return only a base64 PNG over authenticated SSH; login stays alive for confirmation.
set -euo pipefail
if [ "$EUID" -ne 0 ]; then echo 'Run with sudo.' >&2; exit 1; fi
if systemctl is-active --quiet awei-wechat.service || [ -s /var/lib/awei-wechat/token.json ]; then
 echo 'Already paired or message service active; no new login started.' >&2; exit 1
fi
unit=awei-wechat-pairing
if ! systemctl is-active --quiet "$unit.service"; then
 systemd-run --quiet --collect --unit="$unit" --property=RuntimeMaxSec=360 /usr/local/sbin/awei-wechat-login --qr-image-only
fi
for attempt in $(seq 1 30); do
 if [ -s /var/lib/awei-wechat/wechat-login.png ]; then
  base64 -w0 /var/lib/awei-wechat/wechat-login.png
  printf '\n'
  exit 0
 fi
 sleep 1
done
echo 'QR not ready; check awei-wechat-pairing.service.' >&2
exit 1
