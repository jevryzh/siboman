# 双环境部署与版本号经验教训

> 日期：2026-07-03 | 作者：Codex

## 本次背景

本次把同一套代码同时部署到：

| | 生产 | 测试 |
|---|---|---|
| 域名 | xm.renwz.cn | test.renwz.cn |
| 端口 | 127.0.0.1:5177 | 127.0.0.1:5178 |
| systemd | ozon-app | ozon-app-test |
| 目录 | /opt/ozon/app/ | /opt/ozon/app-test/ |
| 版本号 | v1.1.0 | v1.1.0-test |

目标是让生产和测试运行同一份代码，但显示各自正确版本号，并避免敏感配置误提交。

## 关键教训

### 1. 部署不能只推 public/

本项目很多功能在 `server.js` 里：

- 登录鉴权
- Ozon Seller API 代理
- MiniMax / 万相 AI 接口
- 上架接口
- 历史记录和数据库写入

因此部署必须同步：

```bash
server.js
public/app.js
public/app-shell.css
```

只同步 `public/` 会导致前端看起来更新了，但后端接口还是旧逻辑。

### 2. `server.js` 不要硬编码生产/测试版本号

踩坑：本地 `server.js` 一度写死 `v1.1.0-test`。如果直接覆盖生产，生产也会显示测试版本。

正确做法：代码读取环境变量。

```js
function detectBuildVersion() {
  return process.env.BUILD_VERSION || "v1.1.0-test";
}
```

然后不同环境分别设置：

```bash
# 生产
/opt/ozon/app/.env.build
BUILD_VERSION=v1.1.0

# 测试
/opt/ozon/app-test/.env.build
BUILD_VERSION=v1.1.0-test
```

### 3. 本项目里 `BUILD_VERSION` 优先写 `.env.build`

`server.js` 的 `loadLocalEnv()` 对 `.env.build` 有特殊逻辑：

```js
if (name === ".env.build" && key === "BUILD_VERSION") process.env[key] = value;
else if (!process.env[key]) process.env[key] = value;
```

这意味着：

- `.env.build` 里的 `BUILD_VERSION` 可以覆盖已有值
- 普通 `.env` 只有在进程环境没有该 key 时才会写入
- 如果发现 `/api/version` 显示旧值，优先检查 `.env.build`

排查命令：

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'grep -n "^BUILD_VERSION=" /opt/ozon/app/.env.build /opt/ozon/app-test/.env.build 2>/dev/null || true'
```

### 4. 同一份代码可以部署到两个环境

如果版本号和环境配置都放在远程环境文件中，本地代码不用维护两份。

推荐部署顺序：

1. 本地先跑语法检查
2. 先部署测试环境
3. 验证 `test.renwz.cn/api/version`
4. 再部署生产环境
5. 验证 `xm.renwz.cn/api/version`
6. 最后推 GitHub，保证远程代码和部署代码一致

### 5. 部署前要备份远程文件

部署前给远程核心文件做时间戳备份，方便快速回滚。

```bash
TS=$(date +%Y%m%d-%H%M%S)
cp /opt/ozon/app/server.js /opt/ozon/app/server.js.bak-$TS
cp /opt/ozon/app/public/app.js /opt/ozon/app/public/app.js.bak-$TS
cp /opt/ozon/app/public/app-shell.css /opt/ozon/app/public/app-shell.css.bak-$TS
```

测试环境同理，把路径换成 `/opt/ozon/app-test/`。

### 6. 重启后必须验证实际 HTTP 返回

`systemctl is-active` 只能说明进程活着，不代表代码版本正确。

必须验证：

```bash
curl -fsS http://test.renwz.cn/api/version
curl -fsS http://xm.renwz.cn/api/version
```

期望结果：

```text
test.renwz.cn -> v1.1.0-test
xm.renwz.cn   -> v1.1.0
```

### 7. 部署后经常看到的不是最新版本

这个问题要拆开排查，不要只靠刷新页面判断。

#### 情况 A：`/api/version` 不是最新

说明后端进程没有拿到正确版本号，优先查：

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'grep -n "^BUILD_VERSION=" /opt/ozon/app/.env.build /opt/ozon/app-test/.env.build 2>/dev/null || true'
```

修复：

```bash
# 生产
printf '%s\n' 'BUILD_VERSION=v1.1.0' > /opt/ozon/app/.env.build

# 测试
printf '%s\n' 'BUILD_VERSION=v1.1.0-test' > /opt/ozon/app-test/.env.build
```

然后重启对应服务。

#### 情况 B：`/api/version` 是最新，但页面还是旧的

优先怀疑浏览器缓存或静态文件没有同步。

排查静态文件时间：

```bash
curl -fsSI http://xm.renwz.cn/app.js | grep -Ei 'last-modified|etag|cache-control|content-length'
curl -fsSI http://test.renwz.cn/app.js | grep -Ei 'last-modified|etag|cache-control|content-length'
```

也可以直接看远程文件时间：

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'stat -c "%n %y %s" /opt/ozon/app/public/app.js /opt/ozon/app-test/public/app.js'
```

如果时间没变，说明部署漏了 `public/app.js`，重新 rsync。

#### 情况 C：静态文件已更新，但浏览器还是旧的

浏览器强制刷新：

- Mac Chrome：`Cmd + Shift + R`
- 或点击侧栏版本号后，使用 Shift + 点击版本号触发强制刷新（如果当前前端版本支持）
- 或打开无痕窗口确认

如果只是普通刷新，浏览器可能继续使用旧 JS。

#### 情况 D：首页 HTML 没更新

`server.js` 对 `/` 和 `/index.html` 做了 `no-store` 处理，并注入 `BUILD_VERSION`。
如果 HTML 仍旧，检查是不是 nginx/CDN 层缓存。

```bash
curl -fsSI http://xm.renwz.cn/ | grep -Ei 'cache-control|location|server'
curl -fsSI http://test.renwz.cn/ | grep -Ei 'cache-control|location|server'
```

当前登录保护下未登录访问 `/` 会 302 到 `/login?next=%2F`，这是正常现象。

#### 最可靠的判断顺序

```bash
curl -fsS http://test.renwz.cn/api/version
curl -fsS http://xm.renwz.cn/api/version
curl -fsSI http://test.renwz.cn/app.js | grep -Ei 'last-modified|content-length'
curl -fsSI http://xm.renwz.cn/app.js | grep -Ei 'last-modified|content-length'
```

只有 API 版本和静态文件时间都正确，再去判断浏览器界面。

同时看服务日志：

```bash
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'systemctl is-active ozon-app; systemctl is-active ozon-app-test'

ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'journalctl -u ozon-app -n 30 --no-pager; journalctl -u ozon-app-test -n 30 --no-pager'
```

### 8. 敏感文件必须 ignore

本次发现这些文件如果没有 ignore，很容易被 `git add .` 误提交：

- `.env.prod`
- `.env.test`
- `docs/handoff/`

已加入 `.gitignore`：

```gitignore
.env.*
docs/handoff/
```

注意：`.env.example` 不受影响，仍然可以提交。

## 推荐部署命令

### 测试环境

```bash
REMOTE=root@47.104.86.62
APP=/opt/ozon/app-test
TS=$(date +%Y%m%d-%H%M%S)

ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes $REMOTE \
  "set -e; cp $APP/server.js $APP/server.js.bak-$TS; cp $APP/public/app.js $APP/public/app.js.bak-$TS; cp $APP/public/app-shell.css $APP/public/app-shell.css.bak-$TS"

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  server.js $REMOTE:$APP/server.js.new

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  public/app.js public/app-shell.css $REMOTE:$APP/public/

ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes $REMOTE \
  "set -e; mv $APP/server.js.new $APP/server.js; printf '%s\n' 'BUILD_VERSION=v1.1.0-test' > $APP/.env.build; chown ozon:ozon $APP/server.js $APP/public/app.js $APP/public/app-shell.css $APP/.env.build; systemctl restart ozon-app-test; sleep 2; systemctl is-active ozon-app-test"

curl -fsS http://test.renwz.cn/api/version
```

### 生产环境

```bash
REMOTE=root@47.104.86.62
APP=/opt/ozon/app
TS=$(date +%Y%m%d-%H%M%S)

ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes $REMOTE \
  "set -e; cp $APP/server.js $APP/server.js.bak-$TS; cp $APP/public/app.js $APP/public/app.js.bak-$TS; cp $APP/public/app-shell.css $APP/public/app-shell.css.bak-$TS"

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  server.js $REMOTE:$APP/server.js.new

rsync -az -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  public/app.js public/app-shell.css $REMOTE:$APP/public/

ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes $REMOTE \
  "set -e; mv $APP/server.js.new $APP/server.js; printf '%s\n' 'BUILD_VERSION=v1.1.0' > $APP/.env.build; chown ozon:ozon $APP/server.js $APP/public/app.js $APP/public/app-shell.css $APP/.env.build; systemctl restart ozon-app; sleep 2; systemctl is-active ozon-app"

curl -fsS http://xm.renwz.cn/api/version
```

## 本次代码 Review 补充

### 1. 上架页 V3 优先看新命名空间

`public/app.js` 里存在历史旧逻辑。排查上架功能时优先找：

- `renderProductUpload`
- `bindUploadHandlers`
- `normalizeUploadPrefill`
- `products/upload`
- `products/images`
- `countV2` / `countV3` 这一类新控件

不要先在旧函数上消耗时间。

### 2. 前端语法检查很重要

本次发现过 `public/app.js` 断尾导致：

```text
SyntaxError: Unexpected end of input
```

上线前至少执行：

```bash
node --check public/app.js
node --check server.js
git diff --check
```

### 3. AI 分析接口要明确错误

`/api/seller/products/analyze` 必须：

- 检查 `MINIMAX_API_KEY`
- 处理 MiniMax 非 200 响应
- 使用 `MINIMAX_MODEL` 环境变量
- 同时返回 `selling_points_ru` 和 `selling_points`

否则前端只会显示很泛的 JS 错误，不利于排查。

## 快速确认清单

```bash
# 本地
node --check public/app.js
node --check server.js
git diff --check
git status --branch --short

# 远程服务
curl -fsS http://test.renwz.cn/api/version
curl -fsS http://xm.renwz.cn/api/version

ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'systemctl is-active ozon-app; systemctl is-active ozon-app-test'
```
