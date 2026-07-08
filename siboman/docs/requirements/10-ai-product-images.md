# 10-ai-product-images · AI 商品套图与改图需求文档

> 归属模块：AI 工具链 ｜ 优先级：P0 ｜ 预估工作量：7 人日 ｜ 状态：待评审
> 版本：v2.0 (详尽版)

## 1. 背景

目前“逐梦 ERP”已初步接入 MiniMax image-01 模型（`server.js:659`），并支持基础的单图生成（`app.js:1023`）。然而，在实际电商运营中，仅靠简单的 Prompt 生成单张图片效率极低，且难以保持商品主体的一致性。

卖家面临的痛点：
1. **原图质量差**：1688 的主图往往带有水印或背景杂乱，不符合 Ozon 的白底或高品质实拍要求。
2. **本地化缺失**：Ozon 俄罗斯买家更倾向于看到带有俄语说明或俄式居家场景的商品图。
3. **批量需求大**：一个商品通常需要 5-8 张套图（主图、场景图、细节图、尺寸图）。

本需求旨在构建一套完整的 AI 电商套图解决方案，支持批量模板化生成、主体保持（Subject Reference）、以及一键推送至 Ozon 店铺。

### 1.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
| :--- | :--- | :--- | :--- |
| v1.0 | 2026-06-25 | 初始接入 MiniMax image-01 | Eason |
| v2.0 | 2026-07-02 | 扩展批量生成、主体保持、Ozon 推送及 DDL 审计 | Codex |

---

## 2. 目标与非目标

### 2.1 目标
- **批量并发**：支持一次性下发 N 个生成任务，前端显示排队与进度。
- **主体保持 (i2i)**：利用 MiniMax 的 `subject_reference` 能力，确保生成的模特图中，衣服/鞋子/电子产品与原图一致。
- **模板系统**：内置 20+ 套电商专用 Prompt 模板，涵盖“俄式家居”、“白底专业”、“莫斯科街头”等场景。
- **Ozon 同步**：生成的图片可直接一键同步至指定 Ozon SKU，省去下载上传环节。
- **成本管控**：每张图 $0.03 的成本需实时展示，并建立生成历史表。

### 2.2 非目标
- **图像精修**：不做在线图层编辑、手动抠图、文字排版等 PS 功能。
- **视频生成**：暂不涉及 AI 视频或 GIF 生成。
- **多模型切换**：目前仅聚焦 MiniMax image-01，暂不接入 Midjourney 或 Stable Diffusion。

---

## 3. 用户故事

| ID | 用户角色 | 需求场景 (Given/When) | 期望结果 (Then) | 关联 AC |
| :--- | :--- | :--- | :--- | :--- |
| US.01 | 运营 | 当我有一张质量较差的 1688 货源图时 | 我能通过“主体保持”功能，将其置换到莫斯科冬日街景中 | AC.01, AC.03 |
| US.02 | 运营 | 当我需要快速铺货时 | 我能勾选“批量套图”，系统自动为我生成 4 张不同角度的场景图 | AC.02, AC.04 |
| US.03 | 店主 | 当我想控制开支时 | 系统在点击“生成”前提示我将消耗多少美金，并展示余额 | AC.11, AC.12 |
| US.04 | 运营 | 当图片生成满意后 | 点击“推送到 Ozon”，该图自动出现在 Ozon Seller 中心对应商品的图库中 | AC.08, AC.09 |

---

## 4. 界面草图 (ASCII Sketch)

```text
+---------------------------------------------------------------------------------------+
| [AI 工具] / 商品智能套图                                                [余额: $15.40] |
+---------------------------------------------------------------------------------------+
|  +---------------------------+  +---------------------------------------------------+  |
|  |       1. 上传/选图        |  |               2. 配置生成任务                     |  |
|  | [ + ] [ 图库选图 ]        |  |                                                   |  |
|  |                           |  | 选择模板: [ 莫斯科街头 ▼ ] [ 现代简约家居 ▼ ]     |  |
|  | 当前参考图: [IMAGE]       |  | 图片比例: [ 1:1 ] [ 3:4 ] [ 9:16 ]                |  |
|  +---------------------------+  | 生成张数: [ 1 ] [ 2 ] [ 4 ] [ 8 ]                 |  |
|  | [x] 启用主体保持 (Strength: 0.8)|                                                   |  |
|  +---------------------------+  | 自定义 Prompt (可选):                             |  |
|                                | [ a woman holding the phone case, snow...     ]   |  |
|                                |                                                   |  |
|                                | [      立即生成 (预估消耗: $0.12)      ]           |  |
|                                +---------------------------------------------------+  |
+---------------------------------------------------------------------------------------+
|  3. 生成结果预览                                                                      |
|  +---------+  +---------+  +---------+  +---------+                                   |
|  | [IMAGE] |  | [IMAGE] |  | [IMAGE] |  | [IMAGE] |                                   |
|  | [用此图]|  | [用此图]|  | [用此图]|  | [用此图]|                                   |
|  +---------+  +---------+  +---------+  +---------+                                   |
+---------------------------------------------------------------------------------------+
|  4. 历史记录 (最近 10 条)                                                             |
|  ID  | 商品SKU | 预览图 | 消耗 | 时间 | 操作                                           |
|  101 | SKU-001 | [IMG]  | $0.03| 14:05| [同步到 Ozon] [下载]                           |
+---------------------------------------------------------------------------------------+
```

---

## 5. 核心技术细节

### 5.1 MiniMax image-01 API 请求示例 (图生图)

端点：`POST https://api.minimaxi.com/v1/image_generation`

```json
{
  "model": "image-01",
  "prompt": "Professional ecommerce photography, a model wearing the [SUBJECT] in a luxury apartment, Moscow view, soft lighting, 8k resolution, highly detailed",
  "aspect_ratio": "3:4",
  "response_format": "url",
  "n": 4,
  "subject_reference": [
    {
      "type": "character",
      "image_file": "data:image/jpeg;base64,..." 
    }
  ]
}
```
*注：`subject_reference` 是保持商品一致性的关键。`image_file` 推荐传入 Base64 字符串以减少网络拉取开销。*

### 5.2 图片存储方案评估

| 方案 | 描述 | 优点 | 缺点 | 推荐度 |
| :--- | :--- | :--- | :--- | :--- |
| A. 本地磁盘 | 下载到 `/data/ai-images/` | 速度快，无外部费用 | 极度消耗服务器 SSD 空间 | ⭐ |
| B. 仅存 URL | 只存 MiniMax 返回的链接 | 零存储成本 | 链接有效仅 24h，过期即失效 | ⭐⭐ |
| C. 阿里 OSS | 生成后自动转传对象存储 | 永久保存，支持 CDN 加速 | 有少量存储和流量费 | ⭐⭐⭐⭐ |
| **D. 平台中转** | 直接上传到 Ozon 官方图库，本地仅存 ID | 流程最简 | 无法在 ERP 内多次复用或预览原始生成图 | ⭐⭐⭐ |

**当前选择：方案 C (阿里 OSS)。** 兼顾了持久化和系统内的快速预览。

### 5.3 模板库设计 (Prompt Templates)

```javascript
const AI_TEMPLATES = [
  {
    id: 'moscow-street',
    name: '莫斯科街头实拍',
    prompt: 'Outdoor photography, the [SUBJECT] on the streets of Moscow, GUM mall background, winter vibe, high fashion style, sharp focus, 8k',
    recommended_ratio: '3:4',
    negative_prompt: 'deformed, messy background, low quality, blurred'
  },
  {
    id: 'white-clean',
    name: '极简白底渲染',
    prompt: 'Clean white background, soft studio lighting, sharp focus on [SUBJECT], no shadows, commercial product photography, minimalist style',
    recommended_ratio: '1:1',
    negative_prompt: 'reflection, colorful, noisy'
  },
  {
    id: 'modern-home',
    name: '现代极简家居',
    prompt: 'The [SUBJECT] placed on a marble table in a sunny modern living room, plants in background, cozy atmosphere, cinematic lighting',
    recommended_ratio: '4:3',
    negative_prompt: 'dark, messy, people'
  },
  {
    id: 'ecommerce-poster',
    name: '电商详情海报',
    prompt: 'Dynamic composition, [SUBJECT] as the center, abstract background with glowing lines, Russian text space on the right, high contrast',
    recommended_ratio: '9:16',
    negative_prompt: 'text, watermarks'
  }
];
```

## 6. 核心实现路径 (Implementation Roadmap)

### 6.1 第一阶段：基础设施建设 (Day 1-2)
1. **OSS 存储集成**：配置阿里 OSS SDK，实现 `uploadToOSS(buffer, key)` 工具函数。
2. **数据库扩展**：执行 `7.1` 的 DDL，建立 `ai_image_records` 表。
3. **MiniMax SDK**：在 `server.js` 中封装 `minimaxImageGen` 函数，支持 i2i 参数及 Base64 转换。

### 6.2 第二阶段：业务逻辑开发 (Day 3-5)
1. **批量生成控制器**：实现并发处理 1-8 张生成的逻辑，并增加 Redis 队列进行排队限流。
2. **模板引擎**：实现 Prompt 的动态组装，将商品标题自动填充到 `[SUBJECT]` 占位符。
3. **成本审计**：在生成成功后，自动扣减用户配额并记录审计日志。

### 6.3 第三阶段：前端交互优化 (Day 6-7)
1. **生成面板**：实现模板选择、比例切换、Strength 滑动条等 UI。
2. **进度反馈**：使用 WebSocket 或轮询实现生成进度的实时反馈。
3. **Ozon 同步工具**：实现“推送到 Ozon”弹窗，允许用户选择目标 SKU 和 `color_index`。

## 7. 验收标准 (AC) 详尽版

1.  **[AC.01] 主体一致性**：
    - **Given**: 上传一张红色运动鞋原图。
    - **When**: 开启 `subject_reference` 生成 4 张图。
    - **Then**: 结果图中的运动鞋必须保持红色且结构完整，变形率应 < 5%。

2.  **[AC.02] 批量生成并发性**：
    - **Given**: 请求生成 8 张图片。
    - **When**: 观察网络面板。
    - **Then**: 后端应通过并发调用 MiniMax API（限流范围内），总返回时间应在 60s 以内。

3.  **[AC.03] 模板 Prompt 正确性**：
    - **Given**: 选择“莫斯科街头”模板。
    - **When**: 查看发送到 MiniMax 的最终 Payload。
    - **Then**: Prompt 中必须包含该模板的预置描述词。

4.  **[AC.04] OSS 永久存储**：
    - **Given**: 图片生成成功。
    - **When**: 检查数据库记录。
    - **Then**: `result_images` 数组中的 URL 必须是 OSS 的永久链接，而非 MiniMax 的 24h 临时链接。

5.  **[AC.05] 费用审计准确性**：
    - **Given**: 生成 4 张图片。
    - **When**: 查看 `ai_image_records` 表。
    - **Then**: `cost_usd` 字段必须记录为 $0.12 (4 * $0.03)。

6.  **[AC.06] Ozon 同步接口验证**：
    - **Given**: 点击“同步到 Ozon”。
    - **When**: 执行操作。
    - **Then**: Ozon API 必须返回 `result: "ok"`，且对应商品 offer_id 下可见该图片 URL。

7.  **[AC.07] 异常提示友好性**：
    - **Given**: Prompt 包含敏感词（如违禁品）。
    - **When**: 点击生成。
    - **Then**: UI 应显示“生成失败：Prompt 触发安全限制”，而非通用的 500 错误。

8.  **[AC.08] 前端预览裁剪**：
    - **Given**: 上传了一张长方形原图。
    - **When**: 进入 AI 生成页。
    - **Then**: 界面应提供 1:1 或 3:4 的裁剪框，确保商品主体在画幅正中。

9.  **[AC.09] 历史记录展示**：
    - **Given**: 已有 100 条生成记录。
    - **When**: 访问历史记录页。
    - **Then**: 应支持分页加载，且展示图片缩略图。

10. **[AC.10] 比例适配**：
    - **Given**: 选中 9:16 比例。
    - **When**: 图片返回。
    - **Then**: 分辨率必须严格符合比例（如 720x1280）。

11. **[AC.11] 余额校验**：
    - **Given**: 虚拟余额为 0。
    - **When**: 点击生成。
    - **Then**: 按钮应为禁用状态，并提示“余额不足”。

12. **[AC.12] 多选操作**：
    - **Given**: 生成出 8 张预览图。
    - **When**: 勾选其中 3 张。
    - **Then**: 点击“批量下载”应能打包成 ZIP 或触发 3 次连续下载。

13. **[AC.13] Strength 参数效果**：
    - **Given**: 设置 Strength 为 0.2。
    - **When**: 生成图片。
    - **Then**: 结果图与原图的相似度应极低，更偏向 Prompt 描述。

14. **[AC.14] 俄语 Prompt 优化**：
    - **Given**: 输入中文“莫斯科夜晚”。
    - **When**: 后端处理。
    - **Then**: 最终发送到 API 的 Prompt 应包含 "Moscow night" 及其相关的修饰词。

15. **[AC.15] 并发限流器**：
    - **Given**: 快速连续点击 5 次生成。
    - **When**: 请求发出。
    - **Then**: 后 3 次请求应返回“请求过快，请稍后再试”。

---

## 8. API 详细示例 (Detailed)

### 8.1 MiniMax 响应结构
```json
{
  "images": [
    { "url": "https://api.minimaxi.com/v1/files/..." }
  ],
  "usage": { "total_images": 4 },
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

### 8.2 Ozon 图片导入 Request
```json
{
  "offer_id": "PRD-12345",
  "images": [
    "http://oss-cn-beijing.aliyuncs.com/ozon-er/ai/1.jpg"
  ],
  "color_index": 0
}
```

---

---

## 6. 后端 API 设计

### 6.1 POST /api/seller/images/batch-generate
**功能**：并发生成图片任务。
**Request**:
```json
{
  "template_id": "moscow-street",
  "custom_prompt": "add some snow",
  "n": 4,
  "ref_image_url": "http://...",
  "aspect_ratio": "3:4",
  "strength": 0.8
}
```

### 6.2 POST /api/seller/images/publish-to-ozon
**功能**：将生成的图片推送到 Ozon。
**Request**:
```json
{
  "offer_id": "SKU-PRO-123",
  "image_urls": ["http://oss.com/ai-1.jpg"],
  "is_primary": true
}
```
**内部调用**：调 Ozon `/v2/product/pictures/import` 接口。

---

## 7. 数据模型变更

### 7.1 PostgreSQL DDL

```sql
CREATE TABLE ai_image_records (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES app_users(id),
    offer_id VARCHAR(100),
    template_id VARCHAR(50),
    prompt TEXT,
    ref_image_url TEXT,         -- 原始参考图
    result_images TEXT[],        -- 生成的结果图 URL 数组 (OSS)
    usage_count INTEGER,        -- 生成张数
    cost_usd NUMERIC(10, 4),    -- 实际消耗美金
    status VARCHAR(20),         -- 'pending', 'success', 'failed'
    ozon_sync_status BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ai_images_user ON ai_image_records(user_id);
CREATE INDEX idx_ai_images_offer ON ai_image_records(offer_id);
```

---

## 8. 验收标准 (AC)

1.  [ ] **主体一致性**：使用 Subject Reference 生成时，商品（如水壶）的形状、颜色、LOGO 应与原图一致。
2.  [ ] **批量效率**：一次性生成 4 张图，后端必须使用并发请求，总耗时控制在 45 秒内。
3.  [ ] **模板填充**：选择模板后，`[SUBJECT]` 占位符能被商品名称或关键词自动替换。
4.  [ ] **余额拦截**：若 `.env` 配置的 `MINIMAX_API_KEY` 欠费，界面需弹出明确提示并禁止点击生成。
5.  [ ] **OSS 转传**：生成出的图片 URL 必须自动转存到阿里 OSS，数据库存入永久链接。
6.  [ ] **预览体验**：生成过程中显示进度条，完成后原位替换 Loading 占位图。
7.  [ ] **历史记录**：历史表格需展示缩略图，且支持点击再次同步。
8.  [ ] **Ozon 联动**：一键推送功能成功后，需在 Ozon 商品列表页可见新图（存在 1-2 分钟延迟同步）。
9.  [ ] **响应错误处理**：若 MiniMax 返回内容安全告警（Illegal Content），需友好提示用户修改 Prompt。
10. [ ] **比例适配**：生成的图片宽高比需严格符合用户选定的参数（1:1 / 3:4 / 9:16）。
11. [ ] **成本明细**：每一条历史记录都要记账，支持按月统计 AI 消耗金额。
12. [ ] **多图选定**：支持在生成的 8 张图中多选，批量执行下载或同步操作。
13. [ ] **前端裁剪**：上传参考图时，前端提供简单的方形裁剪，确保主体位于画面中心。
14. [ ] **Prompt 优化**：AI 自动根据中文关键词翻译成高质量英文 Prompt 后再下发任务。
15. [ ] **高并发限流**：同一用户不能同时发起超过 2 个批量生成任务，防止撑爆 Worker。

---

## 9. 工作量估算

| 子任务 | 描述 | 工期 (人日) |
| :--- | :--- | :--- |
| **Backend: MiniMax SDK** | 封装 image-01 接口，支持 i2i 参数 | 1.0 |
| **Backend: OSS Storage** | 实现生成图片自动上传阿里 OSS 的中间件 | 1.0 |
| **Frontend: Template UI** | 开发模板库展示与 Prompt 组装逻辑 | 1.5 |
| **Frontend: Result Preview** | 开发生成过程中的排队展示与多图预览交互 | 1.5 |
| **Ozon Integration** | 对接 Ozon 图片导入 API，处理 color_index | 1.0 |
| **Accounting & DDL** | 实现 ai_image_records 记录与费用展示 | 1.0 |
| **Total** | | **7.0** |

---

## 10. 风险与回滚

- **风险**：MiniMax API 响应超时。
- **对策**：前端设置 60s 超时监控，超时后自动标记为失败并返还（虚拟）额度。
- **回滚**：若 OSS 故障，可切换回本地临时文件存储作为备份。

---
## 9. 核心技术架构 (System Architecture)

### 9.1 并发生成队列管理
为了防止大量用户同时生成图片导致后端服务崩溃或 MiniMax API 触发频率限制，系统采用 `ioredis` 实现简单的任务队列：
```javascript
// server.js 伪代码
const Queue = require('bull');
const imageGenQueue = new Queue('image-generation', 'redis://127.0.0.1:6379');

imageGenQueue.process(3, async (job) => {
    const { prompt, n, userId } = job.data;
    const results = await minimax.generateImages({ prompt, n });
    const savedUrls = await Promise.all(results.map(img => uploadToOSS(img)));
    return { urls: savedUrls };
});

app.post('/api/seller/images/batch-generate', async (req, res) => {
    const job = await imageGenQueue.add(req.body);
    res.json({ success: true, jobId: job.id });
});
```

### 9.2 OSS 图片生命周期管理
- **Bucket 结构**: `ozon-erp/ai-images/{YYYY-MM-DD}/{USER_ID}/{HASH}.jpg`
- **生命周期策略**: 历史记录保留 365 天，过期自动转为归档存储（Archive Storage）以节省成本。

## 10. 用户操作手册 (User Guide)

### 10.1 开始第一次 AI 生成
1. 进入“AI 工具” -> “AI 商品套图”。
2. **第一步**：上传商品实拍图或 1688 原图。建议图片主体清晰，背景干净。
3. **第二步**：从模板库选择一个心仪的风格（如“莫斯科街头”）。
4. **第三步**：调整“主体保持强度 (Strength)”。强度越高，生成的图片中商品与原图越像；强度低则更具创意。
5. **第四步**：点击生成。每张图将消耗 $0.03。
6. **第五步**：在结果区挑选满意的图片，点击“用此图”将其保存到商品库。

### 10.2 如何同步到 Ozon
1. 在生成历史或结果预览区，勾选多张图片。
2. 点击“批量推送到 Ozon”。
3. 在弹窗中搜索并选择对应的 Ozon SKU (Offer ID)。
4. 确认后，系统将通过 API 自动完成上传。注意：Ozon 端会有约 2 分钟的审核/处理时间。

## 11. 常见问题排查 (Troubleshooting)

| 症状 | 可能原因 | 解决方法 |
| :--- | :--- | :--- |
| 生成出的商品变形严重 | Strength 参数设置过低 | 尝试将 Strength 调高至 0.8 以上 |
| 图片模糊或像素低 | 参考图质量差 | 请上传 800x800 以上分辨率的高清原图 |
| 点击生成无反应 | API Key 欠费或过期 | 检查 `.env` 配置及 MiniMax 后台余额 |
| 推送 Ozon 失败 | 图片大小超过 10MB | 系统已自动压缩，若仍报错请联系技术支持 |
| 无法加载历史图片 | OSS 访问限速 | 检查网络是否能够正常访问阿里云 CDN |

## 12. 性能基准与限额 (Limits)

- **最大生成数量**: 单次任务上限 8 张。
- **并发任务数**: 每个用户同时仅限 2 个生成任务在队列中。
- **参考图限制**: 最大支持 5MB 的图片上传。
- **响应时间**: 单张生成 < 15s，批量 8 张 < 50s。

---
## 13. 前端组件详细设计 (Frontend Components)

### 13.1 AI 生成面板 (Generation Panel)
```html
<div class="ai-gen-panel">
  <div class="panel-header">
    <h3>配置生成任务</h3>
    <div class="balance-info">预估费用: <span id="estCost">$0.00</span></div>
  </div>
  
  <div class="template-grid">
    <!-- 模板卡片渲染 -->
    <div class="template-card active" data-id="moscow-street">
      <div class="thumb moscow-bg"></div>
      <span>莫斯科街头</span>
    </div>
    <!-- ... -->
  </div>
  
  <div class="param-row">
    <label>生成张数</label>
    <div class="btn-group">
      <button class="active">1</button>
      <button>4</button>
      <button>8</button>
    </div>
  </div>
  
  <div class="param-row">
    <label>主体保持强度 (0.1 - 1.0)</label>
    <input type="range" min="0.1" max="1.0" step="0.1" value="0.8" id="strengthSlider" />
    <span id="strengthValue">0.8</span>
  </div>
  
  <button class="btn-primary full-width" id="genStartBtn">开始生成</button>
</div>
```

### 13.2 结果预览网格 (Result Grid)
```javascript
function renderGenResults(images) {
    const grid = document.getElementById('genResultGrid');
    grid.innerHTML = images.map(img => `
        <div class="result-card">
            <div class="img-wrap">
                <img src="${img.url}" />
                <div class="overlay">
                    <button onclick="downloadImg('${img.url}')">下载</button>
                    <button onclick="syncToOzon('${img.url}')">推送到 Ozon</button>
                </div>
            </div>
            <label><input type="checkbox" data-url="${img.url}" /> 选择</label>
        </div>
    `).join('');
}
```

## 14. 后端核心逻辑深度分析 (Technical Deep Dive)

### 14.1 MiniMax API 交互流
1. **Payload 组装**：合并用户 Prompt 与模板 Prompt，处理 Base64 图片上传。
2. **频率控制**：后端 `RateLimiter` 确保单个用户不会并发触发超过 2 个 MiniMax API 请求。
3. **OSS 转传**：使用流式上传（Stream Upload）将 MiniMax 的 URL 直接转存到阿里 OSS，避免本地磁盘中转。

### 14.2 错误处理矩阵

| 场景 | API 响应码 | ERP 处理逻辑 |
| :--- | :--- | :--- |
| Prompt 违规 | 400 (Illegal Content) | 界面高亮敏感词，提示用户修改 |
| 图片无法识别 | 400 (Image Error) | 提示用户上传清晰的 JPG/PNG 格式图片 |
| 并发过高 | 429 (Rate Limit) | 任务自动进入等待队列，3秒后重试 |
| 额度不足 | 402 (Insufficient Funds) | 提示“AI 生成额度已耗尽，请联系管理员充值” |

## 15. 验收测试用例 (QA Cases)

### TC-AI-01: 模板占位符替换
1. **Given**: 商品标题为“无线充电宝”。
2. **When**: 选择带有 `[SUBJECT]` 的模板生成。
3. **Then**: 发送到 API 的 Prompt 必须包含“wireless power bank”或相关英文翻译。

### TC-AI-02: 多比例生成验证
1. **Given**: 选中 9:16 比例。
2. **When**: 图片生成并下载。
3. **Then**: 图片分辨率应为 720x1280，比例误差 < 1%。

### TC-AI-03: 推送 Ozon 的状态回传
1. **Given**: 点击“推送到 Ozon”。
2. **When**: Ozon 返回成功。
3. **Then**: ERP 生成历史表中的 `ozon_sync_status` 应立即变为 `true`，且历史行显示“已上架”。

---
## 16. 安全与合规性 (Compliance & Security)

### 16.1 内容安全过滤 (NSFW)
系统在发送 Prompt 到 MiniMax 之前，会先经过本地敏感词库过滤，防止生成违规图片导致 Ozon 店铺被封禁：
- **过滤类目**: 政治敏感、暴力血腥、色情低俗、受版权保护的 LOGO（可选）。
- **处理方式**: 若发现敏感词，立即拦截并提示用户。

### 16.2 API 密钥安全
`MINIMAX_API_KEY` 仅存储在服务端的 `.env` 文件中，前端请求必须经过 `JWT` 鉴权。前端永不直接接触 AI 平台的 Key。

## 17. 性能优化 (Optimization)

- **WebP 格式转换**: 存储到 OSS 时，自动将生成的 JPG/PNG 转换为 WebP 格式，在不损失画质的情况下减少 30% 以上的加载体积。
- **预热加载**: 历史记录页使用 Intersection Observer 实现瀑布流加载，仅在用户滚动到可见区域时才拉取 OSS 图片流。

## 18. 未来演进功能 (Future Roadmap)

1. **AI 背景自动替换**: 针对已有主图，一键抠图并更换为预设的背景。
2. **多模特替换**: 同一件衣服，一键更换不同人种、不同体型的模特展示。
3. **俄语 A+ 内容生成**: 生成带俄语宣传语的高清详情长图。
4. **视频生成测试**: 探索 image-to-video 接口，生成 3-5 秒的商品动态展示短视频。

---
*文档版本：v2.4*
*编写日期：2026-07-02*
