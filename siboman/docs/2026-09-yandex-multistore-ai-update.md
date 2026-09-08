# 2026-09 Yandex 多店铺 + AI 优化 + 库存管理 变更说明

> 覆盖 2026-09-05 ~ 2026-09-08 对测试服（`test.renwz.cn`，服务 `ozon-app-test`）交付的 Yandex 模块改造。

## 一、多店铺体系（Ozon / Yandex 并存）

### 数据模型
- `app_stores` 增加 `platform`（默认 `ozon`）、`campaign_id`、`api_secret` 列；唯一键改为 `(user_id, platform, client_id)`，Ozon 与 Yandex 店铺可同名共存。
- `yandex_price_candidates` / `yandex_price_records` 增加 `store_id`；候选唯一键改 `(store_id, offer_id)`（部分索引）。
- `yandex_ozon_matches` 增加 `yandex_store_id`（原 `store_id` 更名 `ozon_store_id` 保留 Ozon 来源），主图匹配按 Yandex 店铺归属；1211 条已回填 Three Latte。

### 后端
- `getYandexMarketContext({ storeId })`：按店从 `app_stores` 解析 `api_secret / businessId / campaign_id`（未配 campaign 时经 `/v2/campaigns` 自动发现），上下文缓存按店（`yandexMarketContextByStore`）。
- `callYandexMarketAPI` 支持按店 `apiSecret`（7 处调用点全量透传）。
- Yandex 商品全量缓存与状态计数缓存 **Map 化**（按 storeId），后台循环逐店刷新；改价/编辑成功后按店失效。
- Yandex 路由（商品/订单/编辑 PATCH/调价/候选/反推）均解析并校验 `store_id`，业务读写带 `store_id`。
- 环境变量店铺自动迁移：启动时若 env 有 `YANDEX_MARKET_API_SECRET` 且库中无 yandex 店，自动建店（Three Latte）并回填候选/记录 `store_id`。
- 仪表盘业绩对比、商品全量同步限定 `platform='ozon'`（Yandex 店不再混入 Ozon 聚合）。
- 店铺管理 `POST /api/seller/shops` 支持 `platform=yandex`（`validateYandexCredentials` 探测）+ `GET /api/yandex/campaigns-probe`；列表支持 `?platform=` 过滤。

### 前端
- `ShopSwitcher` 增加 `platform` 属性；`main.js` 按路由自动对齐平台与当前店铺（`#/yandex-*` → yandex 店）。
- 店铺管理页：列表平台 Tab、Yandex 授权弹窗（探测 campaign 下拉）。
- Yandex 商品/订单/库存页跟随顶栏切换店铺；订单页内置店铺下拉（参照 Ozon 订单页）。

## 二、Yandex 卡片质量评分（本地估算 0-100）

- `computeYandexCardScore(item)`：标题规范/图片数/描述长度/属性数/类目/价格/平台状态扣分；≥80 绿、60-79 橙、<60 红。
- 商品列表展示「卡片质量」列与「质量」筛选（全部/优秀/一般/待优化）。
- 说明：Yandex 平台后台的"卡片质量"为低/中/高档位且**无公开 API**，本分数为透明估算模型，供优化前后对比与筛选（以 Yandex 后台档位人工验证为准）。

## 三、AI 优化（对标"熊猫上架"补全模式）

### 数据与 LLM
- `app_settings` 表按用户存 AI 文本模型（provider：dashscope / minimax / custom）；`getLlmSettings` 回退读环境变量（`MINIMAX_API_KEY`，测试服 drop-in `ai.conf`）。
- MiniMax-M3 需 `thinking: {type:"disabled"}` + `response_format: {type:"json_object"}`（思考块会吞 token 且污染输出）；`parseJsonFromLLM` 增加 `<think>` 剥离。

### 类目属性模板
- `GET /api/yandex/category/:catId/parameters`（代理 `POST /v2/category/{id}/parameters?language=RU`，内存缓存 1h；直连 `requestJsonOverHttps`，因 `callYandexMarketAPI` POST body 不稳定）。
- `collectPendingAttributes(template, currentAttrs)`：筛出空着的必填/推荐属性；**测量类数值属性（长度/宽度/高度/重量/直径等）禁止 AI 猜测**（防虚构规格），提示卖家实测手填。

### 功能入口
- 列表行内 / 勾选批量「AI 优化」（`POST /api/yandex/ai-optimize-preview` / `-apply`）：标题 + 描述 + 空缺属性一并返回/提交（属性写回 `offer.params`，只提交新增项不覆盖已有）。
- 编辑抽屉「AI 智能填充」（`POST /api/yandex/ai-fill`）：就地补标题/描述/空属性，核对后「保存并更新到 Yandex」（带 `ai_filled` 标记入库）。
- 属性名中文化：`data/yandex_attr_zh.json`（169 条俄→中），缺失清单/已填列表/AI 结果均显示中文 + 俄文原名对照。

### AI 优化记录（`yandex_ai_records`）
- 记录每次真实提交：时间 / 方式（optimize=列表优化、fill=抽屉填充）/ 改动维度（标题/描述/属性数）/ 状态。
- 商品列表「AI 优化」列显示次数徽标（点击查看明细弹窗）+「已优化/未优化」筛选；`GET /api/yandex/ai-records` 查询明细。

## 四、Yandex 库存管理（`#/yandex-inventory`）

- 接口：`GET /api/yandex/warehouses`、`GET /api/yandex/stocks`（分页/搜索/按店）、`POST /api/yandex/stocks/update`（批量，`warehouseId + offerId + FIT`）。
- Yandex stocks API 两个坑及对策：**pageToken 会重复导致死循环** → 页数上限 + 无新数据终止；**同一 offer+warehouse 重复返回** → 聚合去重。
- 首次全量拉取约 2-4 分钟：后台异步预取 + 60s 缓存 + 单飞（`inflight`），接口返回 `warming:true`，前端轮询并显示等待秒数/重试，页面框架即时渲染不被遮罩。
- 前端：搜索/分页/低库存阈值统计/分仓修改弹窗/批量设值/缺货与低库存标签。

## 五、修复的回归问题

- 加 AI 弹窗时误删「批量应用候选调价」预览弹窗模板 → 重建（JS 逻辑完好仅模板缺失，按钮"点了没反应"）。
- 「核价」弹窗与「核价详情」抽屉模板同批误删 → 重建（1688 候选选择/编辑/保存/调价历史）。
- `main.js` 路由渲染分支缺失导致 `#/yandex-inventory` 空白 → 补 `<yandex-inventory-view />` 渲染块。
- index.html 增加 `no-cache` 头避免旧版缓存。

## 六、部署要点

- 密钥只走 systemd drop-in（`/etc/systemd/system/ozon-app-test.service.d/`，含 `database.conf` 与 `ai.conf`=MiniMax Token Plan key），代码不读 `.env`。
- 每次部署：scp `server.js` + 前端文件 → `systemctl restart ozon-app-test`；前端版本号统一 `v=232xx`。
- MiniMax 使用 Token Plan 积分（`sk-cp-` 前缀），账户余额不足会返回 `402 insufficient_balance`。
