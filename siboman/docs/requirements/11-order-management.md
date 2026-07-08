# 11-order-management · 订单管理增强需求文档

> 归属模块：订单中心 ｜ 优先级：P1 ｜ 预估工作量：7 人日 ｜ 状态：待评审
> 版本：v2.0 (详尽版)

## 1. 背景

目前“逐梦 ERP”已实现了基础的订单列表拉取（调 Ozon `/v3/posting/fbs/list`，见 `server.js:582`），但缺乏核心的状态流转作业能力。随着订单量的提升，卖家对于“打面单”、“标记包装”、“货源溯源”以及“批量发货”的需求日益迫切。

对标 MyERP（`docs/myerp-reference/15-order-list.png`），本需求旨在构建一个支持全流程发货作业的订单中心，实现从“有订单”到“发走货”的闭环，并打通与 1688 采购链路的“最后一公里”。

### 1.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
| :--- | :--- | :--- | :--- |
| v1.0 | 2026-06-25 | 初始订单列表拉取 | Eason |
| v2.0 | 2026-07-02 | 扩展发货作业流、面单打印、货源回溯及 DB 备注 | Codex |

---

## 2. 目标与非目标

### 2.1 目标
- **全状态 Tab 切换**：覆盖 Ozon 全部 6+ 种业务状态（待处理、待发货、运输中、已送达等）。
- **批量作业流**：支持批量生成面单、批量标记已包装（ship-package）、批量获取发货单。
- **PDF 合并打印**：前端自动合并多个订单的 PDF 面单，实现一键连续打印。
- **本地增强**：支持订单级备注、1688 采购源链接自动回显。
- **库存联动**：标记发货后自动扣减本地 ERP 库存。
- **高危防护**：对标记发货等不可逆操作进行二次弹窗确认。

### 2.2 非目标
- **退货自动化**：暂不支持退货请求的自动处理，仅做状态展示。
- **纠纷仲裁**：争议订单需在 Ozon Seller 中心手动处理。
- **多仓智能分单**：目前仅支持按 Ozon 原始订单分拆。

---

## 3. 用户故事

| ID | 用户角色 | 需求场景 (Given/When) | 期望结果 (Then) | 关联 AC |
| :--- | :--- | :--- | :--- | :--- |
| US.01 | 运营 | 当我有 20 个“待包装”订单时 | 我能一键勾选，批量生成并打印面单，然后标记为“已包装” | AC.01, AC.04 |
| US.02 | 采购 | 当我想知道某订单去哪拿货时 | 订单列表直接显示 1688 采购链接，点击即跳转 | AC.03, AC.07 |
| US.03 | 运营 | 当某个订单有特殊要求（如加固包装）时 | 我能在订单行录入本地备注，且该备注能持久化保存 | AC.08, AC.09 |
| US.04 | 仓库 | 当我标记发货完成后 | 系统自动从“同步库存”模块中减去对应商品的数量 | AC.10 |
| US.05 | 店主 | 当我想分析物流效率时 | 我能导出包含“发货截止时间”和“实际发货时间”的明细表 | AC.12 |

---

## 4. 核心业务映射 (Status Mapping)

Ozon API 返回的状态与 ERP 前端 Tab 的映射关系如下：

| ERP Tab | Ozon Status (API) | 业务含义 | 颜色标识 |
| :--- | :--- | :--- | :--- |
| **待处理** | `awaiting_packaging` | 新订单，需标记已包装以产生面单 | 橙色 (Warning) |
| **待发货** | `awaiting_deliver` | 已包装完成，等待物流商取件/送往代收点 | 蓝色 (Primary) |
| **运输中** | `delivering`, `driver_pickup` | 包裹已在路上 | 紫色 (Info) |
| **已送达** | `delivered` | 买家已妥投 | 绿色 (Success) |
| **已取消** | `cancelled` | 订单已关闭 | 灰色 (Muted) |
| **争议中** | `arbitration`, `dispute` | 买家投诉或仲裁 | 红色 (Danger) |

---

## 5. 发货作业专项逻辑

### 5.1 获取面单 (Labels)

- **API 端点**：`/v2/posting/fbs/package-label`
- **请求频率限制**：每分钟不超过 10 次。
- **关键参数**：`posting_number` 数组。
- **处理方式**：后端接收多单请求，并发调取 Ozon 接口获取 PDF Buffer，返回给前端。

### 5.2 标记已包装 (Ship Package) - **高危操作**

- **API 端点**：`/v3/posting/fbs/ship-package`
- **影响**：一旦调用，Ozon 会认为该包裹已准备好发货。如果实际未准备好，会导致“逾期发货”罚款。
- **交互规范**：必须在点击后弹出 `Modal` 确认框，列出本次发货的所有 `Offer ID`。

### 5.3 PDF 合并逻辑 (Front-end)

使用 `pdf-lib` 库（轻量级）在前端进行 PDF 合并：
```javascript
import { PDFDocument } from 'pdf-lib';

async function mergeLabels(pdfUrls) {
  const mergedPdf = await PDFDocument.create();
  for (const url of pdfUrls) {
    const bytes = await fetch(url).then(res => res.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    const copiedPages = await mergedPdf.copyPages(doc, doc.getPageIndices());
    copiedPages.forEach(page => mergedPdf.addPage(page));
  }
  const mergedPdfFile = await mergedPdf.save();
  // 弹出打印预览...
}
```

---

## 6. 后端 API 设计

### 6.1 POST /api/seller/orders (升级版)
**功能**：支持全状态筛选与搜索。
**Request Body**:
```json
{
  "filter": {
    "status": "awaiting_packaging",
    "query": "7654321",
    "date_since": "2026-06-01T00:00:00Z"
  },
  "limit": 100
}
```

### 6.2 POST /api/seller/orders/notes
**功能**：保存/更新本地订单备注。
**Request**: `{ "order_id": "765432101", "note": "需要加厚气泡膜" }`

### 6.3 GET /api/seller/orders/source-link
**功能**：获取对应订单的 1688 货源链接。
**Logic**：通过 `offer_id` 在 `app_jobs` 表中反查最初的 `payload` 数据。

---

## 7. 数据模型变更

### 7.1 PostgreSQL DDL

```sql
-- 1. 订单备注表
CREATE TABLE app_order_notes (
    order_id VARCHAR(50) PRIMARY KEY, -- Ozon posting_number
    user_id UUID REFERENCES app_users(id),
    note TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. 货源链路关联表
CREATE TABLE app_order_source_links (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(50),
    offer_id VARCHAR(100),
    sku_name TEXT,
    alibaba_url TEXT,       -- 1688 货源链接
    purchase_price_cny NUMERIC(12, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_source_order ON app_order_source_links(order_id);
CREATE INDEX idx_source_offer ON app_order_source_links(offer_id);
```

---

## 8. 验收标准 (AC) 详尽版

1.  **[AC.01] Tab 状态实时切换**：
    - **Given**: 当前处于“全部”Tab。
    - **When**: 点击“待包装”Tab。
    - **Then**: 列表应仅展示 `awaiting_packaging` 状态订单，且 Tab 下方的红色指示条平滑移动。

2.  **[AC.02] 批量操作栏触发**：
    - **Given**: 勾选了列表中的 5 个订单。
    - **When**: 观察页面底部。
    - **Then**: 自动弹出悬浮的操作面板，包含“打印面单”、“标记包装”、“导出”按钮。

3.  **[AC.03] 面单生成准确性**：
    - **Given**: 选中 3 个不同 SKU 的订单。
    - **When**: 点击“批量打印面单”。
    - **Then**: 系统应生成一个合并后的 PDF，内含 3 页标准 100x150mm 的 Ozon 面单。

4.  **[AC.04] 发货截止预警**：
    - **Given**: 订单 A 的发货截止时间还有 2 小时。
    - **When**: 渲染列表行。
    - **Then**: 倒计时文字应显示为红色闪烁，并提示“即将过期”。

5.  **[AC.05] 货源回显功能**：
    - **Given**: 该 SKU 是通过采集箱上架的。
    - **When**: 打开订单详情抽屉。
    - **Then**: 必须显示“1688 货源链接”及采集时的参考采购价（CNY）。

6.  **[AC.06] 本地备注持久化**：
    - **Given**: 在备注框输入“赠送贴纸”。
    - **When**: 点击保存并手动刷新页面。
    - **Then**: 该备注必须被正确读取并显示在订单行内。

7.  **[AC.07] 发货联动库存**：
    - **Given**: SKU-A 本地库存 100 件。
    - **When**: 完成“标记包装”操作（1 件）。
    - **Then**: 本地库存表中的该 SKU 数量应自动变为 99。

8.  **[AC.08] 高危操作二次确认**：
    - **Given**: 点击“标记包装”或“标记已发货”。
    - **When**: 接口调用前。
    - **Then**: 必须弹出强制性的确认对话框，防止误触。

9.  **[AC.09] 订单导出 Excel**：
    - **Given**: 点击“导出全部订单”。
    - **When**: 查看导出的文件。
    - **Then**: 文件名应包含日期，且必须包含买家地址、手机号、商品名称、金额等明细。

10. **[AC.10] 状态变更即时刷新**：
    - **Given**: 完成了一个发货单的生成。
    - **When**: 关闭弹窗。
    - **Then**: 订单列表对应行的状态标签应立即从“待处理”变为“待发货”。

11. **[AC.11] 异常状态处理**：
    - **Given**: 订单已被买家取消（cancelled）。
    - **When**: 尝试点击“打印面单”。
    - **Then**: 按钮应为禁用状态，或提示“已取消订单无法打印”。

12. **[AC.12] 批量发货单获取**：
    - **Given**: 选中 50 个已包装订单。
    - **When**: 点击“生成发货单”。
    - **Then**: 应成功调用 Ozon 接口获取总的发货明细 PDF，不应出现 504 超时。

13. **[AC.13] 配送方式显示**：
    - **Given**: 订单来自不同仓库或配送渠道。
    - **When**: 渲染列表。
    - **Then**: “配送方式”列应显示具体的仓库名称（如 Warehouse_Main）。

14. **[AC.14] 响应式表格测试**：
    - **Given**: 在 1440px 屏幕下查看。
    - **When**: 表格列较多时。
    - **Then**: “操作”列应始终保持可见，且不遮挡订单号。

15. **[AC.15] 操作日志审计**：
    - **Given**: 执行了批量发货操作。
    - **When**: 查看系统日志。
    - **Then**: 应能看到具体的 posting_number 被哪个用户、在什么时间标记了什么状态。

---

## 9. 核心实现路径 (Implementation Roadmap)

### 9.1 第一阶段：订单模型升级 (Day 1-2)
1. **数据库迁移**：建立 `app_order_notes` 和 `app_order_source_links`。
2. **数据同步器**：升级 `server.js` 中的同步逻辑，在拉取订单的同时，尝试通过 SKU 关联 1688 货源记录。

### 9.2 第二阶段：发货功能集成 (Day 3-5)
1. **API 封装**：在 `ozon-api-helper.js` 中封装发货作业全家桶（Label, Act, Ship-Package）。
2. **PDF 处理**：在前端引入 `pdf-lib`，实现多 PDF 流合并。
3. **库存钩子**：编写 `onOrderPackaged` 数据库钩子，自动触发库存扣减。

### 9.3 第三阶段：前端作业大改版 (Day 6-7)
1. **订单主表**：重构 `renderOrderList`，实现多 Tab 筛选及底部批量操作栏。
2. **详情抽屉**：开发订单详情 Drawer，集成采购链路展示与备注编辑。
3. **异常处理**：处理 Ozon 接口返回的常见错误码（如限额、非法状态），并给出中文提示。

## 10. 订单状态流转 Edge Cases 处理

### 场景 01：订单被中途取消
- **现象**：运营正在打包时，买家在 Ozon 端点击取消。
- **处理**：ERP 在执行 `ship-package` 前会再次调用 `v3/product/info` 校验状态，若已取消则中止操作并报错。

### 场景 02：多件商品缺货
- **现象**：一个订单有 3 件衣服，其中 1 件缺货。
- **处理**：支持分拆发货（调用 Ozon 分包接口），或在 ERP 界面选择“标记部分缺货”。

### 场景 03：面单打印失败
- **现象**：Ozon 接口返回 500。
- **处理**：提供“单单重试”按钮，并在界面显示具体的 API 错误报文。

---

## 11. 工作量估算 (详细拆解)

| 阶段 | 任务 | 工期 (人日) |
| :--- | :--- | :--- |
| **P1: Database** | 订单备注与货源链路表设计及迁移 | 0.5 |
| **P2: Ozon API** | Label/Act/Ship-Package 接口封装与联调 | 1.5 |
| **P3: Frontend UI** | 订单主表改版 (Tab/Action Bar) | 1.5 |
| **P4: PDF Engine** | 前端 PDF 合并与打印引擎实现 | 1.0 |
| **P5: Order Drawer** | 详情抽屉开发与备注/货源集成 | 1.0 |
| **P6: Stock Hook** | 发货联动库存扣减后端逻辑 | 0.5 |
| **P7: Test & QA** | 异常流程模拟与并发发货测试 | 1.0 |
| **Total** | | **7.0** |

---

## 12. 风险与回滚

- **风险**：错误调用 `ship-package` 导致 Ozon 罚款。
- **对策**：增加“发货锁定”模式，必须管理员授权后方可执行批量标记。
- **回滚**：如果新版发货流故障，后端提供 `reset_order_cache` 强制从 Ozon 重新拉取状态。

---
## 13. 系统架构与技术细节 (System Architecture)

### 13.1 订单流水线作业模型
系统内部采用“作业锁”机制，防止多名员工同时操作同一个订单的发货逻辑：
- **Locking**: 当某个订单被点击“标记包装”时，Redis 中记录 `order_lock:{order_id}`，有效期 3 分钟。
- **Atomic Update**: 使用数据库事务，确保“订单状态更新”与“库存扣减”在同一个原子操作内完成。

### 13.2 Ozon API 调用控制器
```javascript
// server.js 伪代码
async function processOrderLabel(postingNumbers) {
    try {
        const response = await callOzonSellerAPI('/v2/posting/fbs/package-label', {
            posting_number: postingNumbers
        });
        // 接口返回的是 PDF 文件的 Base64 或流
        return response;
    } catch (err) {
        logger.error(`Failed to get labels for ${postingNumbers}: ${err.message}`);
        throw err;
    }
}
```

## 14. 安全审计与权限 (Security)

| 角色 | 查看订单 | 修改备注 | 执行发货 (Ship) | 导出报表 |
| :--- | :--- | :--- | :--- | :--- |
| 管理员 | √ | √ | √ | √ |
| 仓库主管 | √ | √ | √ | √ |
| 打单员 | √ | √ | √ | x |
| 财务人员 | √ | x | x | √ |

## 15. 用户操作手册 (User Guide)

### 15.1 批量发货标准化流程
1. **筛选**：进入“订单管理” -> “待处理”Tab。
2. **打面单**：勾选所有需要发货的订单，点击“批量面单”。系统弹出 PDF 预览，点击“打印”。
3. **打包**：根据面单上的 SKU 信息进行实物配货打包。
4. **标记包装**：实物打包完成后，扫描面单条码或在系统中点击“标记已包装”。
5. **获取发货单**：点击“生成发货单 (Act)”，将打印出的汇总单随货交给 Ozon 取货司机或代收点。

### 15.2 如何处理异常订单
- **缺货**：若发现某商品缺货，请勿点击“标记包装”，应点击“更多操作” -> “标记缺货”，通知客服联系买家。
- **改地址**：Ozon 订单不支持在 ERP 修改地址，需引导买家在 Ozon 客户端操作。

## 16. 接口性能基准 (Performance)

| 场景 | 负载规模 | 期望耗时 |
| :--- | :--- | :--- |
| 同步 100 笔订单状态 | 100 posts | < 3s |
| 合并并生成 50 张 PDF 面单 | 50 pages | < 8s |
| 导出 5000 条订单 Excel | 5000 rows | < 10s |
| 搜索指定订单号 | 全库 | < 200ms |

---
## 17. 详细前端逻辑与状态机 (Frontend State Machine)

### 17.1 订单行状态机设计
为了管理复杂的发货动作，前端采用状态机模式控制按钮的显隐与禁用：
```javascript
const OrderActionMachine = {
    'awaiting_packaging': ['print_label', 'ship_package', 'add_note'],
    'awaiting_deliver':   ['get_act', 'cancel_package', 'add_note'],
    'delivering':         ['track_logistics', 'add_note'],
    'delivered':          ['archive', 'add_note'],
    'cancelled':          ['view_details']
};

function renderOrderActions(status) {
    const allowedActions = OrderActionMachine[status] || [];
    // 渲染对应的按钮...
}
```

### 17.2 批量面单 PDF 合并算法 (Implementation)
```javascript
/**
 * 核心：合并多个 Ozon 面单 PDF 并弹出打印
 */
async function handleBatchPrint(postings) {
  showLoading('正在获取面单数据...');
  const labelUrls = await fetch('/api/seller/shipping/batch-labels', {
    method: 'POST',
    body: JSON.stringify({ postings })
  }).then(res => res.json());

  const mergedPdf = await PDFDocument.create();
  for (const url of labelUrls) {
    const pdfBytes = await fetch(url).then(r => r.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
    pages.forEach(p => mergedPdf.addPage(p));
  }
  
  const mergedPdfBytes = await mergedPdf.save();
  const blob = new Blob([mergedPdfBytes], { type: 'application/pdf' });
  const downloadUrl = URL.createObjectURL(blob);
  window.open(downloadUrl, '_blank');
}
```

## 18. 数据库触发器与业务集成 (DB Integration)

### 18.1 库存自动扣减触发器 (Pseudo-SQL)
```sql
CREATE OR REPLACE FUNCTION fn_on_order_packaged()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'awaiting_deliver' AND OLD.status = 'awaiting_packaging' THEN
        -- 获取订单中的 SKU 和数量
        -- 更新 app_product_stocks
        UPDATE app_product_stocks 
        SET present = present - 1 -- 简化逻辑
        WHERE offer_id = (SELECT offer_id FROM order_items WHERE order_id = NEW.order_id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

## 19. 接口性能基准与限额 (Limits)

- **批量处理上限**: 单次最多勾选 50 个订单进行批量发货/打印，防止 API 超时。
- **面单生成速度**: 50 个面单合并时间应控制在 10 秒内（前端渲染+网络拉取）。
- **备注长度限制**: 每个订单备注最大支持 2000 个中文字符。
- **同步频率**: 订单状态每 15 分钟自动增量同步一次。

## 20. 验收测试用例 (Detailed QA Cases)

### TC-ORDER-01: 状态流转闭环测试
1. **Given**: 一个处于 `awaiting_packaging` 状态的订单。
2. **When**: 点击“标记包装”并确认。
3. **Then**: 订单状态变为 `awaiting_deliver`，且 Ozon 后台同步成功。

### TC-ORDER-02: 货源回溯准确性
1. **Given**: 订单包含 SKU-B，该 SKU 在采集箱记录中的 1688 链接为 `https://1688.com/a`。
2. **When**: 打开订单 102 详情。
3. **Then**: 必须准确跳转到 `https://1688.com/a`。

### TC-ORDER-03: PDF 打印页码检查
1. **Given**: 选中 10 个订单批量打单。
2. **When**: 打开合并后的 PDF。
3. **Then**: PDF 必须刚好有 10 页，每页一个面单，无空白页或内容缺失。

---
*文档版本：v2.3*
*编写日期：2026-07-02*
