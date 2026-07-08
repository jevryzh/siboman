# CHANGELOG — 逐梦 ERP

> 单文件 Node.js 后端 + Vanilla JS 前端 + 中继采集插件的跨境电商 ERP。
> 完整架构详见根目录 [`HANDOVER_GUIDE.md`](./HANDOVER_GUIDE.md) 与 [`siboman/HANDOFF.md`](./siboman/HANDOFF.md)。

## 版本时间线

| 版本 | 日期 | 主要变化 |
|---|---|---|
| v0.1.0 | 2026-06 | 项目初版：单文件 server.js + Vanilla JS 前端 + 1688 找货流程 |
| v0.3.0 | 2026-07-02 | 全闭环 PRD：仪表盘 / 商品 / 订单 / 库存 / 套图 / 采集插件基线 |
| v0.5.x | 2026-07-03 | Dashboard KPI + 多店对比 + Session 探测 + CNY 纠偏 |
| v0.7.5 | 2026-07-05 | 店铺管理 + 插件下载（v1.0.3） |
| **v0.8.0-final** | 2026-07-08 | **首次正式移交**：批量跟卖（BatchUpload v0.8.3）+ 11 字段商品编辑 + V3 payload + 多店扇出 + 中继采集协议 `__zhumeng_proto`。本 commit `28af7a7` |
| v0.8.0-final + 排除 `handover-config-private/` | 2026-07-08 | chore：敏感目录不进库。Commit `8f13ef2` |
| **v2.1.0** | 2026-07-08 | 修复 BatchUpload 采集链路：移除 setup 期 `<style>` 警告（IIFE 注入） |
| **v2.1.1** | 2026-07-08 | 修复：Ozon `/v3/product/import` 接收 `string[]`（URL 数组），不是对象数组；调插件重试机制 |
| **v2.1.2** | 2026-07-08 | 去掉 `extensionConnected` 卡点：避免用户点"解析"时 ping 还没 resolve |
| **v2.1.3** | 2026-07-08 | `ready` 改走 `document.addEventListener('__zhumeng_reply__')` 早绑，原链路留 stub 兼容 |
| **v2.1.4** | 2026-07-08 | 移除 `content-bridge-main` 的 `window.addEventListener` dispatcher 转发层，ERP 直接监听 `window.message` |
| **v2.1.5** | 2026-07-08 | 修 Vue 3 reactive Proxy 不可被 `window.postMessage` 结构化克隆 — 加 `JSON.parse(JSON.stringify(...))` 剥 Proxy |
| **v2.1.6** | 2026-07-08 | debug：在 ERP 端 `window.message` listener 加日志定位消息自循环 |
| **v2.1.7** | 2026-07-08 | 修 `window.postMessage(msg, '*')` 同步触发调用方自己的 `window.message` listener — 在 main 加 `if (d.kind.endsWith('.request')) return` 过滤 |
| **v2.1.8** | 2026-07-08 | SW 加 Ozon 公开页直查兜底（采集拿不到时 SW 自己 fetch） |
| **v2.1.9** | 2026-07-08 | 修 `refreshStatus` 错误硬覆盖 `extensionConnected.value = true` — 信任 ready handler；表新增 `typeIdInput` 输入列 + localStorage 缓存 |
| **v2.1.10** | 2026-07-08 | **新端点** `POST /api/seller/type-id-suggestion`：按 `description_category_id + store_id` 反查同店铺同 cat 历史 type_id；采集器自动调，结果回填 `type_id=0` 行；**自动兜底通过第一次端到端测试**（task_id=5027892960 → status=pending） |

## v2.1.0 → v2.1.10 5 个根因 Bug 速查

| # | 根因 | 修复版本 | 现象 |
|---|---|---|---|
| 1 | Vue 3 reactive Proxy 不能被 `window.postMessage` structuredClone 序列化 | v2.1.5 | 采集请求发了但插件收不到 |
| 2 | `window.postMessage(msg, '*')` 会同步触发**调用方自己** window 的 `message` listener | v2.1.7 | ERP 自己给自己回了 `collect.response` → 死循环 |
| 3 | `content-bridge-main` 的 `window.addEventListener` 拦截了 `addEventListener` 但没调 `origAddEventListener` | v2.1.4 | ERP 永远收不到任何 `message` |
| 4 | `refreshStatus` 出错时 `extensionConnected.value = ok`（脏数据） | v2.1.9 | 插件实际没 ready 但 UI 显示绿点 |
| 5 | Vue 模板内嵌 `<style>` 触发 setup 静态 warn | v2.1.0 | 不致命但污染日志 |

## 待办（移交状态 2026-07-08 16:25）

1. ⏳ **上架历史异步轮询**（P1 / 0.5-1 人日）— PRD 在 [`siboman/docs/requirements/03-listing-history.md`](./siboman/docs/requirements/03-listing-history.md) 写得很细，但代码没实现。当前 ERP 上架按钮点了就返回成功，**Ozon 任务真实状态（imported/failed）完全没查**。Ozon 通常 1-3 分钟变 `imported`，本会话实测 task 5027892960 在 8 分钟后仍是 `pending`。
2. ⏳ **使用说明抽屉**（P3）— BatchUpload 右侧"使用说明"按钮文案未写
3. ⏳ **变体合并**（P3）— BatchUpload 的 `attr 9048` 型号名合并逻辑未实装
4. ⏳ **UI 最终验收**（P3）— Dashboard 排版微调
5. ⏳ **AI 套图**（P3）— 万相 2.7 俄文标注质量不稳定

## 关键文件位置

| 类别 | 路径 | 说明 |
|---|---|---|
| 后端入口 | `siboman/server.js`（8718 行） | 单文件 Express + pg |
| 前端核心 | `siboman/public/js/views/BatchUpload.js` | 批量跟卖（v2.1.10 已改） |
| 需求文档 | `siboman/docs/requirements/01-11` | 11 个模块 PRD |
| 部署脚本 | `deploy-test.sh`（**不入库**） | rsync + scp + systemctl restart |
| 配置文件 | `env/local.env` + `env/server.env` + `handover-config-private/.env` | **不入库**，单独交付 |
| 真实端点 | `siboman/HANDOFF.md` §5 | Ozon Seller API + MiniMax + 内部 API 完整列表 |
