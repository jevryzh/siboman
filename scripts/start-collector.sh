#!/bin/zsh
set -e

cd /Users/eason/Documents/OZON
export HOME=/Users/eason
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting ozon collector" >> /Users/eason/Documents/OZON/data/collector-launch.log
exec /opt/homebrew/bin/node /Users/eason/Documents/OZON/collector.js
