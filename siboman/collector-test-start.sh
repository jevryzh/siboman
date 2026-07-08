#!/bin/bash
NODE=/Users/eason/Library/Accio/external-tools/va8fc21487f16/node/bin/node
cd /Users/eason/Documents/OZON
pkill -f "47.104.86.62:8080" 2>/dev/null
sleep 1
COLLECTOR_SERVER_URL=http://47.104.86.62:8080 \
COLLECTOR_USERNAME=eason \
COLLECTOR_PASSWORD=mTJbluVZXrmODQ \
COLLECTOR_WORKER_NAME=eason-mac-test \
BROWSER_PROFILE_DIR=/Users/eason/Documents/OZON/data/browser-profile-test \
COLLECTOR_POLL_SECONDS=5 \
$NODE collector.js > /tmp/test-collector.log 2>&1 &
echo "测试采集器已启动 (PID: $!)"
