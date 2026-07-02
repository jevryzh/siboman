# 逐梦 ERP — 交接给 Codex 的完整文档

> **目的**：让 Codex 接手时无需问任何问题，能直接开始工作。
> **接手人**：Codex（MiniMax M3 / OpenAI Codex / Claude Code 都可）。
> **写这份文档时**：2026-07-02 Asia/Shanghai
> **当前部署**：http://xm.renwz.cn/

---

## 0. 一句话总结

**逐梦 ERP** = 私有跨境电商 ERP（Ozon → 1688 找货 + 选品 + 上架 + 同步库存 + 订单 + AI 套图）。
从你给一个 Ozon 商品链接开始，工具能帮你：抓商品数据 → 去 1688 找货（AI 审核匹配）→ 把候选套图 AI 化 → 上架到你自己的 Ozon 店铺 → 同步库存 → 看订单。

---

## 1. 项目基本信息

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/jevryzh/siboman |
| 本地路径 | `/Users/eason/Documents/OZON` |
| 部署 URL | http://xm.renwz.cn/ |
| 服务器 | `root@47.104.86.62` (Ubuntu, 阿里云) |
| 服务器路径 | `/opt/ozon/app/` |
| 数据库 | PostgreSQL（localhost 5432，库名 `ozon_sourcing`） |
| 运行端口 | 5177（被 systemd 监听，nginx 反代到 80 端口） |
| 渲染模式 | SPA（hash 路由，单页应用，左侧菜单） |
| 系统名称（已上线的）| 逐梦 ERP |
| Node | 23.x（系统自带） |
| 依赖 | express / pg / playwright / fflate |

---

## 2. 仓库结构

```
/Users/eason/Documents/OZON/
├── server.js                  # 服务端入口（5438 行）
├── collector.js               # 本机采集端（拉任务→执行→回传）
├── package.json               # 依赖
├── .env.example               # 环境变量模板
├── .env                       # 真实环境变量（不入 git）
├── .gitignore
│
├── public/                    # 前端
│   ├── index.html             # SPA 主壳
│   ├── app.js                 # 路由 + 17 个 render 函数（1200+ 行）
│   ├── app-shell.css          # 全部样式（671 行）
│   ├── styles.css             # 占位兼容文件
│
├── data/                      # 运行时数据（不入 git）
│   ├── jobs/                  # 每个任务一个子目录：results.json + ozon-xxx-results.xlsx
│   ├── browser-profile/       # Playwright 持久化 profile（保持 1688 登录态）
│   ├── ozon-refresh-profile/  # 补采脚本用的独立 profile
│   ├── templates/logistics-template.xlsx
│   ├── collector.log / collector-error.log
│
├── scripts/                   # 一次性工具脚本
│   ├── merge-ozon-100-2026-06-29.mjs
│   ├── merge-ozon-300.mjs
│   ├── merge-provided-100-2026-06-30.mjs
│   ├── refresh-provided-100-ozon-cny.mjs
│   └── start-collector.sh
│
├── browser-extension/         # 历史参考材料（**当前不依赖**），可删
│
├── PROJECT_CONTEXT.md         # 老版交接文档（保留参考，部分已过时）
├── HANDOFF.md                 # ← 你现在看的这份
├── README.md                  # 老版 README
└── 私有密钥文件见 `/Users/eason/Documents/逐梦 ERP/env/`  # ⚠️ 不入 git
```

---

## 3. 技术栈

- **后端**：Node 23 + Express 4 + pg + Playwright + fflate
- **前端**：原生 JS（无框架），hash 路由
- **打包**：xlsx 是手写 XML + fflate 压缩（不依赖 exceljs）
- **浏览器自动化**：Playwright（持久化 profile 保 1688 登录）
- **AI**：
  - **MiniMax-M3**（默认模型）— 文本理解 / 选品审核 / 估重 / prompt 优化
  - **MiniMax image-01 / image-01-live**（图生图）— 商品套图
  - 在 `/v1/chat/completions`（文本）和 `/v1/image_generation`（图像）

---

## 4. 部署相关

### 4.1 关键部署命令

```bash
# 1) 推前端 + server.js 到 public/
rsync -avz --checksum -e 'ssh -i ~/.ssh/ozon_deploy_ed25519 -o BatchMode=yes' \
  public/index.html public/app.js public/app-shell.css public/styles.css server.js \
  root@47.104.86.62:/opt/ozon/app/public/

# 2) ⚠️ 重要：server.js 必须单独 cp 到 systemd 真正运行的位置
scp -i ~/.ssh/ozon_deploy_ed25519 server.js root@47.104.86.62:/opt/ozon/app/server.js.new
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 '
  mv /opt/ozon/app/server.js.new /opt/ozon/app/server.js
  chown ozon:ozon /opt/ozon/app/server.js'

# 3) 重启
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 '
  pkill -9 -f "node.*server.js" 2>/dev/null
  sleep 1
  systemctl restart ozon-app
  sleep 3
  systemctl is-active ozon-app --no-pager'
```

**为什么必须 scp 一份到 `/opt/ozon/app/server.js`？**
- systemd 跑的是 `/opt/ozon/app/server.js`（不在 public/）
- express.static 只把 `public/` 当静态文件服务，**不会**运行 public/server.js
- 之前犯过这个错导致部署失败好几次，**接手时一定注意**

### 4.2 烟测 5 个核心端点

```bash
rm -f /tmp/c
curl -sS -c /tmp/c -H 'Content-Type: application/json' \
  -d "{\"username\":\"${COLLECTOR_USERNAME:-eason}\",\"password\":\"$COLLECTOR_PASSWORD\"}" \
  http://xm.renwz.cn/api/auth/login > /dev/null

# 1. 仪表盘
curl -sS -b /tmp/c http://xm.renwz.cn/api/seller/dashboard
# 2. 类目分析
curl -sS -b /tmp/c -X POST http://xm.renwz.cn/api/seller/analytics/categories \
  -H "Content-Type: application/json" -d '{"range":"30"}'
# 3. 订单
curl -sS -b /tmp/c -X POST 'http://xm.renwz.cn/api/seller/orders?limit=1'
# 4. 商品
curl -sS -b /tmp/c -X POST 'http://xm.renwz.cn/api/seller/products?limit=1'
# 5. 图生图
curl -sS -b /tmp/c -X POST http://xm.renwz.cn/api/seller/images/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red phone case on white","aspectRatio":"3:4","n":1}'
```

---

## 5. 真实端点（**这些是当前能用的**）

### 5.1 Ozon Seller API（用 Client-Id + Api-Key 鉴权）

| 用途 | 端点 | 备注 |
|---|---|---|
| 仪表盘聚合 | 内部 `/api/seller/dashboard` | 调 Ozon 多端点组合 |
| 商品列表 | 内部 `/api/seller/products?limit=N` | 调 `/v3/product/list` |
| 单商品 | 内部 `/api/seller/products/:id` | 调 `/v3/product/info` |
| **上架** | 内部 `/api/seller/products/import` | 调 `/v3/products/import` |
| **同步库存** | 内部 `/api/seller/products/stocks` | 调 `/v2/products/stocks` |
| **仓库** | 内部 `/api/seller/warehouses` | 从 `/v3/posting/fbs/list` 提取（cluster/list 端点对 Seller 不可用） |
| 类目树 | 内部 `/api/seller/categories/tree` | 调 `/v1/description-category/tree` |
| **类目分析** | 内部 `/api/seller/analytics/categories` | 调 `/v1/analytics/data` |
| **订单** | 内部 `/api/seller/orders` | 调 `/v3/posting/fbs/list` |

### 5.2 MiniMax API（用 Bearer Token 鉴权）

| 用途 | 端点 | 模型 |
|---|---|---|
| 文本/审核/估重 | `/v1/chat/completions` | `MiniMax-M3` |
| **图生图** | `/v1/image_generation` | `image-01`（标准）/ `image-01-live`（快） |

⚠️ **MiniMax 图生图模型名**：
- ❌ `MiniMax-Image` / `MiniMax-M3`（不支持图生）
- ✅ `image-01` / `image-01-live`（这两个能图生）
- 端点 `/v1/images/generations` 返回 404，必须用 `/v1/image_generation`（无 s）

### 5.3 内部 API（不接外部）

| 用途 | 端点 |
|---|---|
| 登录 / 登出 / 状态 | `/api/auth/{login,logout,status}` |
| 抓取任务 | `/api/jobs`, `/api/batch-ozon/jobs` |
| 抓取端进度 | `/api/worker/jobs/{next,:id/progress,:id/complete}` |
| 1688 浏览器 | `/api/1688/open`, `/api/browser/close` |
| 历史记录 | `/api/history` |
| 任务日志 | `/api/jobs/:id` |

---

## 6. 环境变量（.env）

真实值已迁移到本机私有目录：

- `/Users/eason/Documents/逐梦 ERP/env/local.env`
- `/Users/eason/Documents/逐梦 ERP/env/server.env`

**不要把真实密码、数据库连接串、MiniMax Key、Ozon Seller Key 写进 Git。**

```ini
# Web
PORT=5177
HOST=127.0.0.1
APP_PASSWORD=<see local private env>
AUTH_SECRET=<see local private env>
DISABLE_SERVER_SCRAPER=true          # 服务器端禁用浏览器（让 Mac 采集端跑）

# PostgreSQL
DATABASE_URL=<see local private env>
INITIAL_USERS=<see local private env>

# MiniMax（AI）
MINIMAX_API_KEY=<see local private env>
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
MINIMAX_THINKING_TYPE=disabled
AI_CONFIDENCE_THRESHOLD=0.78
MINIMAX_INPUT_USD_PER_M=0.30
MINIMAX_OUTPUT_USD_PER_M=1.20

# MiniMax 图生
MINIMAX_IMAGE_MODEL=image-01
MINIMAX_IMAGE_PER_IMAGE_USD=0.03

# Ozon Seller API
OZON_SELLER_CLIENT_ID=<see local private env>
OZON_SELLER_API_KEY=<see local private env>
OZON_SELLER_BASE_URL=https://api-seller.ozon.ru

# 抓取节奏
LOW_PRICE_THRESHOLD_RMB=1
DEFAULT_DELAY_MIN_MS=8000
DEFAULT_DELAY_MAX_MS=20000
DETAIL_DELAY_MIN_MS=2500
DETAIL_DELAY_MAX_MS=6500
DETAIL_BROWSE_MODE=balanced
DEFAULT_MAX_CONSECUTIVE_FAILURES=3

# 本机采集端
COLLECTOR_SERVER_URL=http://xm.renwz.cn
COLLECTOR_USERNAME=<see local private env>
COLLECTOR_PASSWORD=<see local private env>
COLLECTOR_WORKER_NAME=eason-mac
COLLECTOR_POLL_SECONDS=5
COLLECTOR_PROGRESS_SECONDS=4
```

⚠️ **不要把任何真实密钥写进 .env.example 或 git**，**仅放本机私有 env 文件**。

---

## 7. 前端架构（13 个页面 + hash 路由）

URL 格式：`http://xm.renwz.cn/#/<route>`

| Route | 渲染函数 | 数据来源 |
|---|---|---|
| `#/dashboard` | renderDashboard | /api/seller/dashboard |
| `#/sourcing` | renderSourcingLanding | 静态 |
| `#/sourcing/category` | renderCategoryAnalysis | /api/seller/analytics/categories |
| `#/sourcing/bestsellers` | renderBestsellers | （Ozon 不开放） |
| `#/sourcing/single` | renderSingleSourcing | /api/jobs |
| `#/sourcing/batch` | renderBatchSourcing | /api/batch-ozon/jobs |
| `#/products` | renderProductsLanding | /api/seller/dashboard |
| `#/products/list` | renderProductList | /api/seller/products |
| `#/products/upload` | renderProductUpload | /api/seller/products/import |
| `#/products/stock` | renderProductStock | /api/seller/products + /stocks |
| `#/products/images` | renderProductImages | /api/seller/images/generate |
| `#/orders` | renderOrdersLanding | /api/seller/dashboard |
| `#/orders/list` | renderOrderList | /api/seller/orders |
| `#/tools` | renderToolsLanding | 静态 |
| `#/tools/browser` | renderToolsBrowser | /api/1688/open |
| `#/tools/history` | renderToolsHistory | /api/history |
| `#/tools/logs` | renderToolsLogs | /api/jobs/:id |

### 7.1 关键全局逻辑

```js
// 路由 → 渲染
function applyRoute() {
  const route = getCurrentRoute();
  const def = ROUTES[route] || ROUTES.dashboard;
  // ... 设置 topbar / active nav / 调用 def.render(elContent, route)
}

// 顶级栏目点 → 自动跳到第一个子项
$$(".nav-item, .nav-subitem").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    const route = el.getAttribute("data-route");
    if (el.classList.contains("nav-item")) {
      const firstSub = document.querySelector(`.nav-subitem[data-parent="${route}"]`);
      if (firstSub) { navigate(firstSub.getAttribute("data-route")); return; }
    }
    navigate(route);
  });
});
```

### 7.2 关键状态

- `state.currentJobId` — 当前跑的任务
- `state._imgDataUrl` — AI 套图上传的图（FileReader 转 dataURL）
- `state._selectedGeneratedImage` — 用户"用此图"选中的图
- `state._pendingUploadImage` — 上架页等待自动填入的图
- `state._orders` — 订单列表（用于详情弹窗）

---

## 8. 添加新功能的标准流程（给未来的 Codex 看的）

假设要加一个"批量改价"功能：

1. **后端**：在 `server.js` 加端点
   ```js
   app.post("/api/seller/products/prices", async (req, res, next) => {
     // 调 Ozon /v1/product/import/prices
   });
   ```
2. **前端**：在 `app.js` 的 `ROUTES` 加条目，写 `renderXxx(root)` 函数
3. **菜单**：在 `index.html` 的对应 nav-subitem 加 `<a data-route="products/prices">`
4. **测试**：`node --check server.js` + `node --check public/app.js` + 部署
5. **部署**：见 4.1，关键别忘了 scp server.js 到根目录

---

## 9. 关键设计决策（避免推翻）

1. **服务器/采集端分离**：Ozon 反爬严，server 永远不开浏览器，scrape 全在 Mac 的 collector.js 跑
2. **xlsx 手写**：不依赖 exceljs（太大），直接 XML + fflate 打包
3. **AI 双层兜底**：审核失败 → AI 单独估重 → 失败再用本地品类规则
4. **Mtop 签名直调 1688**：不走页面爬，token 失效自动刷新
5. **Ozon 多策略取价**：JSON-LD / meta / DOM 黑标 / 低价推荐 / 跟卖页展开，取最低
6. **网络监听抓重量**：拦截隐藏 API 响应，从 JSON 里抽 weight
7. **Sidebar 200px**：MacBook 14 寸（~1440px 逻辑宽）刚好不挤
8. **AI 商品套图走 MiniMax image-01**：不是 MiniMax-M3（M3 是纯文本）

---

## 10. 已知的坑 / TODO

### 10.1 已解决但要记住

- ✅ server.js 部署要 scp 到 `/opt/ozon/app/server.js`，不能只推 public/
- ✅ MiniMax 图生模型名是 `image-01`（不是 `MiniMax-Image`）
- ✅ MiniMax 图生端点是 `/v1/image_generation`（不是 `/v1/images/generations`）
- ✅ Ozon orders 端点是 `/v3/posting/fbs/list`（单数 + fbs）
- ✅ Ozon warehouses 用 `/v1/cluster/list` 对这个账号 404（"invalid cluster type"），改从 posting 提取

### 10.2 还没做的

- **榜单选品**：Ozon 不开放 top 1000 API，UI 留了但没有数据源。可能的方案：
  1. Playwright 抓 https://www.ozon.ru/highlight/（容易被反爬）
  2. 买第三方数据（如 mysku.mobi）
  3. 用店铺内已有商品按更新时间倒序代替（目前已实现的退化方案）
- **AI 商品套图自动推 Ozon**：现在要用户手动"用此图 → 填到上架页图片"，可以做成"一键上架为新商品"
- **多店聚合**：MYerp 支持多店铺对比，目前只看到 1 个店铺的数据
- **HTTPS**：xm.renwz.cn 还是 HTTP，浏览器会标"不安全"
- **账号管理 UI**：现在只能改 .env 里的 INITIAL_USERS 创建账号
- **任务失败恢复**：如果 collector.js 崩溃，已跑的 50 条不会自动从断点继续（要手填 startRow）

### 10.3 待优化

- 同步库存页面在商品多时（>200）会一次性加载所有行，可以加分页或虚拟滚动
- 仪表盘没有"今日 GMV" / "7 日 GMV"，因为 Ozon analytics 需要按时间分组
- 类目分析 subtab（全部/增长机会/高退货率/品牌集中/FBS机会）目前数据一样，没差异化筛选

---

## 11. 重要"勿动"区

接手 Codex 看到这些代码，**先想清楚再改**：

1. **server.js 第 921-1140 行的 `runBatchOzonJob()`**：Ozon 店铺页自动发现商品用 Playwright 抓 + 模拟鼠标滚动，复杂且脆弱
2. **server.js 第 1141-1450 行的 `scrapeOzonProduct()`**：抓取 Ozon 单品页所有信息（标题/图片/价格/重量/JSON-LD），逻辑密集
3. **server.js 第 1916-2100 行的 1688 mtop 签名逻辑**：MD5 签名 + token 刷新机制
4. **server.js 第 2895-3100 行的 `reviewCandidatesWithMiniMax()`**：AI 审核 + 估重的 prompt 调优过的，改坏会让审核质量下降
5. **server.js 第 3851-3990 行的 `writeJobArtifacts()` 和 xlsx XML 生成**：手写 xlsx 格式，改坏 Excel 打不开

---

## 12. 验证清单（你接手后第一次跑通）

按顺序跑：

```bash
# 1. 装依赖
cd /Users/eason/Documents/OZON
npm install

# 2. 语法检查
node --check server.js
node --check public/app.js
node --check public/app-shell.css  # 这个只检查文件存在，不会报错

# 3. 启动本地测试
PORT=5188 node server.js &
sleep 3
# 登录
APP_PWD=$(grep "^APP_PASSWORD=" .env | cut -d= -f2)
curl -sS -c /tmp/c -H "Content-Type: application/json" \
  -d "{\"password\":\"$APP_PWD\"}" http://127.0.0.1:5188/api/auth/login
# 测试
curl -sS -b /tmp/c http://127.0.0.1:5188/api/seller/dashboard
# 清理
kill %1
rm -f /tmp/c

# 4. 部署
# 用 4.1 的命令

# 5. 服务器烟测
# 用 4.2 的命令

# 6. 浏览器验证
# 打开 http://xm.renwz.cn/，强刷（Cmd+Shift+R）
# 标题应是"逐梦 ERP"
# 点每个 tab，看是否渲染
```

---

## 13. 联系上下文

- **Ozon Seller API 文档**：https://api-seller.ozon.ru/，新版端点路径（`/v3/posting/fbs/list` 这种）有迁移文档
- **MiniMax API 文档**：https://api.minimaxi.com/，图生图在 `/v1/image_generation` 端点
- **登录账号**（PostgreSQL 模式）：账号和密码见本机私有 env 文件，不写入 Git。
- **SSH**：`~/.ssh/ozon_deploy_ed25519`（部署用），`~/.ssh/github_jevryzh_ed25519`（GitHub 用）
- **ngrok 之类的不需要**：本机采集端直接连 `http://xm.renwz.cn`

---

## 14. 与老文档的关系

- `README.md` 保留，但内容老（描述的是"单机模式 + 服务器队列模式"两套），现在只用服务器模式
- `PROJECT_CONTEXT.md` 保留作为历史快照，但**部分信息已过时**（"上架"是新手写的，Ozon 端点路径是新的，等等），**以本文件为准**
- 私有密钥备份见 `/Users/eason/Documents/逐梦 ERP/env/`，**不入 git**

---

## 15. 当前未完成的明确任务（给接手 Codex 的 todo）

按优先级排：

1. **【高】** 类目分析 subtab 差异化筛选（全部/增长/退货/品牌/FBS）现在都显示同样数据
2. **【高】** 上架成功后支持"批量上传多张图"（现在只能一次传一张主图）
3. **【中】** AI 商品套图 → 一键上架到 Ozon（用户当前要手动填图 URL）
4. **【中】** 同步库存的"bulk 模式"（一次拉所有库存 → 表格编辑 → 批量提交，目前是手勾）
5. **【低】** HTTPS（`xm.renwz.cn` 现在是 HTTP）
6. **【低】** 账号管理 UI
7. **【低】** 任务断点续传

---

## 16. 故障排查指南

| 症状 | 看什么 | 怎么修 |
|---|---|---|
| 部署后 API 502 | 服务器 systemd 状态 | `systemctl restart ozon-app` |
| 部署后代码没生效 | `stat -c %y /opt/ozon/app/server.js` 看时间戳 | scp server.js 到根目录（不是 public/） |
| MiniMax 调用 401/403 | `.env` 里 `MINIMAX_API_KEY` 是否对 | 重新生成 key |
| Ozon 调用 404 | 当前端点是否仍有效 | 探一下新的端点（`/v3/posting/fbs/list` 不是 `/v2/postings/list`） |
| Ozon "invalid cluster type" | `/v1/cluster/list` 端点 | **改用 posting 提取 warehouse**（已实现） |
| 浏览器看不到新功能 | 浏览器缓存 | **Cmd+Shift+R 强刷** |
| 浏览器看到旧 title | 浏览器缓存 | 强刷 |
| 采集端连不上 | Mac collector.log 日志 | `tail -50 /Users/eason/Documents/OZON/data/collector-error.log` |
| Postgres 错误 | `journalctl -u ozon-app` 看日志 | 检查 `DATABASE_URL` |
| 验证码弹窗不消失 | 后台浏览器模式 + 验证码 | 取消"后台浏览器模式" + 重启 collector |

---

## 17. 一行命令速查

```bash
# 看服务端日志（最近 100 行）
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'journalctl -u ozon-app -n 100 --no-pager | tail -30'

# 重启服务
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 'systemctl restart ozon-app'

# 看 collector 日志
tail -50 /Users/eason/Documents/OZON/data/collector.log

# 看 DB
ssh -i ~/.ssh/ozon_deploy_ed25519 root@47.104.86.62 \
  'sudo -u postgres psql -d ozon_sourcing -c "SELECT id, kind, status, phase, total, processed FROM app_jobs ORDER BY updated_at DESC LIMIT 10;"'

# 跑端到端烟测
bash -c '
rm -f /tmp/c
curl -sS -c /tmp/c -H "Content-Type: application/json" \
  -d "{\"username\":\"${COLLECTOR_USERNAME:-eason}\",\"password\":\"$COLLECTOR_PASSWORD\"}" \
  http://xm.renwz.cn/api/auth/login > /dev/null
for ep in "/api/seller/dashboard" "/api/seller/categories/tree" "/api/seller/warehouses"; do
  echo "--- $ep ---"
  curl -sS -b /tmp/c -X POST "http://xm.renwz.cn$ep" | head -c 200
  echo ""
done'
```

---

**写完了。** 接手时按第 12 节的"验证清单"跑一遍就 OK。遇到问题查第 16 节"故障排查"。要加新功能按第 8 节"标准流程"。

祝顺利。
