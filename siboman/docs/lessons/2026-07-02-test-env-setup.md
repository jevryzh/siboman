# 测试环境搭建经验教训

> 日期：2026-07-02 | 作者：Accio

## 环境架构

| | 生产 | 测试 |
|---|---|---|
| 域名 | xm.renwz.cn | test.renwz.cn |
| nginx port | 80 → 127.0.0.1:5177 | 80 → 127.0.0.1:5178 |
| systemd | ozon-app | ozon-app-test |
| 目录 | /opt/ozon/app/ | /opt/ozon/app-test/ |
| 数据库 | ozon_sourcing | ozon_sourcing_test |
| Ozon Client-Id | 原店铺 | 3065624 |

## 关键教训

### 1. 同一台服务器两个实例必须独立
- ✅ 独立数据库（CREATE DATABASE ... OWNER ozon_app）
- ✅ 独立 .env（端口、DB 连接串、Ozon 凭据）
- ✅ 独立 systemd 服务
- ✅ nginx 通过 server_name 区分（不是端口区分）

### 2. 采集器不能并行跑两个
**原因**：`collector.js` import `server.js`，Playwright 使用同一个 `data/browser-profile` 目录。
两个采集器同时跑会互相锁死 Chromium profile，导致 `Target page has been closed` 崩溃。

**临时方案**：用时启停，不同时跑。
**长期方案**：让 `PROFILE_DIR` 可通过环境变量配置，两个采集器各用各的 profile。

### 3. 服务端直接采集需要完整环境
开启 `DISABLE_SERVER_SCRAPER=false` 时，服务器需要：
- `npx playwright install chromium`
- `npx playwright install-deps chromium`（系统依赖库）
- `apt install xvfb` + `Xvfb :99`（虚拟显示）
- systemd 中 `Environment=DISPLAY=:99`
- 默认 `headless: true`（`server.js` 中 `getBrowserContext` 默认值必须为 `true`）

### 4. 1688 验证码必须在有 GUI 的环境处理
服务端 xvfb 无法弹出验证码窗口，必须用本机 collector（有真实显示器）。

### 5. `GET /api/jobs/:id` 查询顺序
```js
// ✅ 正确顺序
1. 内存 Map    // DISABLE_SERVER_SCRAPER=false 时用
2. DB 查询     // DISABLE_SERVER_SCRAPER=true 时用（collector 模式）
3. 本地文件    // 兜底
```
**踩坑**：之前 DB 在内存之前，导致 collector=false 时创建的 in-memory job 查不到，返回"任务不存在"。

### 6. 非标端口问题
浏览器在非 80 端口可能出现 `classList.remove` 等诡异的 JS DOM 异常，原因不明。
**解决方案**：测试环境走 80 端口 + 独立域名（`test.renwz.cn`），通过 nginx `server_name` 区分。

### 7. 域名 DNS 配置
`renwz.cn` 使用阿里云 CDN（全站加速），所有子域名解析到 198.18.0.x（CDN 边缘节点）。
如需新增子域名：
1. 阿里云 DNS 控制台添加 A 记录
2. 同时确保 CDN 配置中包含该子域名
3. 主 nginx 配置中 `server_name` 包含该域名

## 采集器启停

```bash
# 停止所有采集器
pkill -f collector.js

# 启动生产采集器
cd /Users/eason/Documents/OZON
screen -dmS ozon-collector /Users/eason/Library/Accio/external-tools/va8fc21487f16/node/bin/node collector.js

# 启动测试采集器
bash /Users/eason/Documents/OZON/collector-test-start.sh
```

⚠️ **不能同时跑两个！**
