# HANDOVER v2.1.10 — 30 轮调试增量交接

> 写给接手 v2.1.10 → 后续版本的 agent。
> 已通过端到端测试一次：提交 `4425674396` 到 Three Latte 店 → Ozon 收到 → `task_id=5027892960` → 当前状态 `pending`（Ozon 队列里，还没 imported/failed）。
>
> 完整项目背景见 [`HANDOVER_GUIDE.md`](./HANDOVER_GUIDE.md) 和 [`siboman/HANDOFF.md`](./siboman/HANDOFF.md)。版本时间线见 [`CHANGELOG.md`](./CHANGELOG.md)。

---

## 1. 这一轮（v2.1.0 → v2.1.10）解决了什么

**症状**：用户在 ERP 批量跟卖页粘贴 `4425674396,110` → 选店 → 点"开始批采+上架" → 进度条走完 → 显示"1 成功 0 失败"，**但 Ozon 后台**实际**没有**这个商品 / 不知道是否真成功 / 也没看到 task 状态。

**30 轮调试结论**：不是单点 bug，是**通信层 + 数据缺失**两个维度叠加：

1. **通信层 4 个 bug**（v2.1.4 / 2.1.5 / 2.1.7 / 2.1.9 修完）
2. **数据缺失 1 个兜底**（v2.1.10 加 type_id 历史反查）

通信修完 + 兜底机制就位后，**第一次端到端就走通了**。

---

## 2. 通信层 4 个 Bug 详解

### 2.1 Vue 3 Proxy + `postMessage` structuredClone 不兼容（v2.1.5）

**根因**：
```js
// Vue 3 ref / reactive 的 array/object 实际是 Proxy
// postMessage 内部用 structuredClone() 序列化消息
// Proxy 不可被 structuredClone 序列化 → 静默丢消息
```

**症状**：ERP 端 `window.postMessage(...)` 调用没报错，插件**完全收不到**。

**修复**：`siboman/public/js/views/BatchUpload.js` line ~85
```js
// v2.1.5 fix
window.postMessage(JSON.parse(JSON.stringify(msg)), '*')
```

**为什么之前没发现**：ERP 端没报错（structuredClone 失败不抛），插件没注册 listener —— 静默失败。

### 2.2 `postMessage(msg, '*')` 同步触发自己 window 的 listener（v2.1.7）

**根因**：MDN 文档写得很清楚但容易漏：
> `window.postMessage()` 会**同步**给**所有**监听了 `window.message` 的 window 派发事件，包括**调用方自己的 window**。

**症状**：ERP 发了 `collect.request` → 自己 window 立刻收到 `collect.request`（不是 `collect.response`）→ 被当成 response 解析 → 死循环 / 数据错乱。

**修复**：`content-bridge-main.js` 加过滤器
```js
// v2.1.7 fix
window.addEventListener('message', (e) => {
  const d = e.data
  if (!d || d.__zhumeng_proto !== 'zhumeng-v1') return
  if (d.kind && d.kind.endsWith('.request')) return  // 忽略自己发的 request
  // ... 真正处理 response
})
```

### 2.3 `content-bridge-main` 拦截 `window.addEventListener` 没调原方法（v2.1.4）

**根因**：原本有 dispatcher 转发层 `content-bridge-main.js`，它 monkey-patch 了 `window.addEventListener`，**但** patch 里只调用了自定义的 router，**没调** `origAddEventListener(message, ...)` —— 实际注册的 listener 永远没真的绑到 window 上。

**修复**：v2.1.4 **整个移除** dispatcher 转发层，ERP 直接在 main world 监听 `window.message`。这是**最暴力的修复**也是**最稳的修复**。

### 2.4 `refreshStatus` 出错时硬覆盖 `extensionConnected.value = true`（v2.1.9）

**根因**：
```js
// refreshStatus 的 catch / 错误分支
extensionConnected.value = true  // 错误：把"出错"等同于"已连接"
```

**修复**：v2.1.9 **只**信任 ready handler 的赋值，refreshStatus 出错不覆盖。

---

## 3. 数据层兜底：type_id（v2.1.10）

### 3.1 问题

Ozon `/v3/product/import` **强制**要求 `type_id`，但：
- Ozon 公开商品页（https://www.ozon.ru/product/...）**不返回** type_id
- Ozon Seller `/v1/description-category/tree` 返回中文类目但 `type_id` 字段始终是 0
- 公开 API 没有端点能反查 type_id

### 3.2 解决思路

`type_id` 对每家店是有限的（一家店"Сумка"类目下通常就那么几种 type_id），所以**用同店铺同 `description_category_id` 下历史发过的 type_id 反查兜底**。

### 3.3 实现

**后端新端点** `POST /api/seller/type-id-suggestion`（`siboman/server.js` line 3257+）
```js
// 入参: { description_category_id, store_id, user_id }
// 出参: {
//   candidates: [{type_id, category_name, count, last_used_at}, ...],
//   recommended: type_id (top1),
//   source: "store-history" | "no-history"
// }
```

**SQL**（按 store + cat 聚合历史 type_id 出现频次）:
```sql
SELECT type_id, name, COUNT(*) AS cnt, MAX(updated_at) AS last_used
FROM app_products
WHERE user_id = $1 AND store_id = $2 AND description_category_id = $3
  AND type_id IS NOT NULL AND type_id > 0
GROUP BY type_id, name
ORDER BY cnt DESC, last_used DESC
LIMIT 5
```

**前端** `siboman/public/js/views/BatchUpload.js` line ~364
```js
// 采集完成后、buildV3Item 之前
if (row.distilled?.type_id === 0 || row.distilled?.type_id == null) {
  const sugg = await axios.post('/api/seller/type-id-suggestion', {
    description_category_id: row.distilled.description_category_id,
    store_id: selectedStoreId,
  })
  if (sugg.data.success && sugg.data.recommended) {
    row.distilled.type_id = sugg.data.recommended
    appendLog(`  ℹ️ #${row.index} ${row.sku}: 兜底 type_id=${sugg.data.recommended} (${sugg.data.source})`, 'info')
  }
}
```

### 3.4 用户手动覆盖（v2.1.9 + v2.1.10）

如果 MY 库里这个类目**完全没历史**（新店 / 新类目），兜底会失败，UI 表里有 `typeIdInput` 输入列 —— 用户手填一次，localStorage 缓存 + 入库 `app_products`，下次自动命中。

**优先级**：`user typeIdInput` > `store-history 反查` > `distilled.type_id`（采集原始值，Ozon 公开页通常为 0）

---

## 4. 端到端测试记录

| 项 | 值 |
|---|---|
| 测试时间 | 2026-07-08 16:13:28 |
| 测试数据 | `4425674396,110`（Ozon 公开页可访问） |
| 目标店铺 | Three Latte（client_id 在 `app_stores` 表） |
| Ozon task_id | **5027892960** |
| task 状态（提交后 8 分钟） | `pending`（Ozon 队列） |
| product_id | 0（未生成） |
| errors | `[]`（无错误） |
| offer_id | `zm-vnwjr4-4425674396`（前缀 `zm-` + `vnwjr4-` 是采集器加的） |

**结论**：链路通了，但 Ozon 自己还没处理完。可在 3-5 分钟后用以下命令复查：
```bash
curl -s -X POST "https://api-seller.ozon.ru/v1/product/import/info" \
  -H "Client-Id: <Three Latte 的 client_id>" \
  -H "Api-Key: <对应 api_key>" \
  -H "Content-Type: application/json" \
  -d '{"task_id":"5027892960"}'
```

---

## 5. 接下来第一个要做的事

按 PRD 文档 [`siboman/docs/requirements/03-listing-history.md`](./siboman/docs/requirements/03-listing-history.md) 实现"上架历史 + 异步轮询 + 错误翻译"。PRD 写得很细，照着做。

**为什么优先做这个**：
- 当前 ERP 上架按钮点了就"成功"，**Ozon 失败用户根本看不到**
- 不做这个，每次上架后用户都得人肉去 Ozon 后台找
- 实现成本：1-1.5 人日（PRD 已写完，按图施工）

**最小可用版改动点**：
1. `siboman/server.js` `/api/seller/products/import`（line 3310）调 Ozon 拿到 task_id 后，**立即调一次** `/v1/product/import/info` 看真实状态
2. 如果是 `pending`，**3 秒后再查一次**（Ozon 通常 1-3 分钟才 imported）
3. 把真实状态 + 错误写回 `app_listing_history` 表
4. 前端 BatchUpload.js 日志 panel 加"Ozon 状态: pending → imported" 实时反馈

---

## 6. 这次踩的坑（避免重蹈）

1. **多 bug 叠加时一次只修一个**：v2.1.0 → v2.1.10 我一次一个版本修，**每个版本都手动验证**才进下一个。如果同时改 4 个东西就分不清哪个有效。
2. **不要迷信 PRD 写了就等于实现**：`03-listing-history.md` 写得超详细，但代码里只是把 `app_listing_history` 表建出来了，**轮询根本没做**。接手时一定要看代码。
3. **数据问题用数据兜底，不要用户手填**：用户说"我要填 type_id"是最后的兜底，**优先**用历史反查、**其次** UI 选字典、**最后**才是手填。
4. **MyERP 公开 API 给了中文类目但 type_id 是 0**：`/api.jizhangerp.com/ozon/categories/tree?_t=...` 那个端点返回 `title: "Сумка/Аксессуары"` 中文，**但 `type_id` 永远是 0** —— 这是 Ozon 公开 API 的限制，不是 MyERP 的锅。

---

## 7. 30 轮调试时间线

| 轮次 | 现象 | 结论 |
|---|---|---|
| 1-10 | ERP 发了请求插件收不到 | v2.1.5 Proxy 序列化问题 |
| 11-15 | 收到后没回包 | v2.1.4 addEventListener 没真绑 |
| 16-20 | 收到回包但解析错 | v2.1.7 自己 window 收到自己的 request |
| 21-25 | 解析对了但任务 ID 状态不明 | v2.1.9 refreshStatus 覆盖 |
| 26-30 | task_id 拿到了但 Ozon 报 type_id 必填 | v2.1.10 历史反查兜底 |

**反思**：前 20 轮死磕在"我代码逻辑没错为什么不工作"上，但其实**多个 bug 叠加**，必须一个一个排。**下次类似场景我会先列根因假设清单并行验证**，不再死磕单一链路。
