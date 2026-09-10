#!/usr/bin/env bash
# 把仓库里的采集插件同步到「Chrome 实际加载的已解压扩展目录」。
# 目的：改完插件不用再下载 zip + 解压 + 覆盖，只要在 chrome://extensions 点一次「重新加载」。
# 可用环境变量覆盖目标目录：ZHUMENG_EXT_CHROME_DIR=/path/to/zhumeng-collector
set -u
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../public/extension/zhumeng-collector" && pwd)"
DEST="${ZHUMENG_EXT_CHROME_DIR:-$HOME/Downloads/zhumeng-collector}"

if [ ! -d "$SRC" ]; then echo "[sync-ext] 源目录不存在：${SRC}"; exit 0; fi
if [ ! -d "$DEST" ]; then
  echo "[sync-ext] Chrome 扩展目录不存在：${DEST}"
  echo "[sync-ext] 如果你的插件放在别处，请设置 ZHUMENG_EXT_CHROME_DIR 后重试"
  exit 0
fi

# 完整性保险：仓库里插件目录正在被别人编辑时不至于把好副本覆盖坏
if [ ! -f "$SRC/manifest.json" ]; then echo "[sync-ext] 源 manifest.json 缺失，跳过同步"; exit 0; fi
if [ "$(wc -c < "$SRC/background.js" 2>/dev/null || echo 0)" -lt 10000 ]; then echo "[sync-ext] 源 background.js 异常（过小），跳过同步"; exit 0; fi
python3 -c "import json,sys; json.load(open('$SRC/manifest.json'))" 2>/dev/null || { echo "[sync-ext] 源 manifest.json 不是合法 JSON，跳过同步"; exit 0; }

rsync -a --delete --exclude '.DS_Store' --exclude '*.map' "$SRC/" "$DEST/" || exit 0

# 顺手重建 ERP「下载插件」用的 zip，保持各机器下载到的是同一版
ZIP="$(dirname "$SRC")/zhumeng-collector.zip"
# 只在插件确实比 zip 新时才重建，避免每次提交都把 zip 弄成脏文件
if command -v zip >/dev/null 2>&1 && { [ ! -f "$ZIP" ] || [ "$SRC/manifest.json" -nt "$ZIP" ] || [ "$SRC/background.js" -nt "$ZIP" ]; }; then
  rm -f "$ZIP" && (cd "$SRC" && zip -qr "$ZIP" . -x '.*' >/dev/null 2>&1) && echo "[sync-ext] 已重建 ${ZIP##*/}"
fi
VER="$(python3 -c "import json;print(json.load(open('$DEST/manifest.json'))['version'])" 2>/dev/null || echo '?')"
echo "[sync-ext] 插件已同步到 ${DEST}（v${VER}）→ 到 chrome://extensions 点「重新加载」即生效"
