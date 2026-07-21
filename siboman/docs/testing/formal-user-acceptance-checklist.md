# 正式用户验收清单与本地 Guard

范围：`v2.2.9.53-test-p1-product-ux` 后的 ERP 用户验收。  
可执行 guard：`docs/testing/formal-user-acceptance-checklist.json` + `tests/test_erp_acceptance_matrix.cjs`。  
本地 guard 只读代码和清单，不部署，不调用 Ozon，不调用 AI provider。

## 当前测试审计

现有 `npm run test:erp` 的价值主要是防回归，但大多仍是结构测试：

| 覆盖面 | 已覆盖 | 不覆盖的真实体验 |
|---|---|---|
| 路由/模块 | 菜单、路由、视图文件、接口字符串存在 | 用户能否按正式工作流完成操作 |
| UI 可见性 | 关键 label、函数名、错误字段没有被删 | 点击后弹窗是否真的可读、布局是否遮挡 |
| 危险链路 | 确认框、状态字段、错误字段代码存在 | Ozon/AI/库存/订单外部链路是否真实成功 |
| Fixture 契约 | 重复采集、AI JSON 清洗等局部契约 | 授权店铺、真实插件、真实 provider 的端到端表现 |

因此正式验收必须把“页面能开”降为前置条件，只作为 smoke，不作为通过标准。

## 执行规则

1. 本地 guard：运行 `node tests/test_erp_acceptance_matrix.cjs` 或 `npm run test:erp`。
2. 手工验收：只在授权测试店铺执行，记录店铺、账号、截图或录屏。
3. 禁止事项：本地 guard 不触发 Ozon 发布、库存提交、订单发货、AI 生成、部署。
4. 失败记录：每个失败项必须记录页面、操作、可见错误、期望表现、实际表现。

## 验收项

| ID | 模块 | 路由 | 用户验收标准 | 本地 guard 证据 |
|---|---|---|---|---|
| FA-001-product-image-zoom | product-management | `#/products` | 商品列表和编辑抽屉里的主图/图册点击后能放大查看 | `ProductList.js` 保留 `preview-teleported`、`productPreviewList(row)`、`allPreviewList()`、`cursor:zoom-in` |
| FA-002-product-status-chinese | product-management | `#/products` | 商品状态 Tab 和行状态显示中文，原始 Ozon 状态仍可诊断 | `statusCn`、`productStatusLabel(row)`、`Ozon 原始状态`、`失败/处理原因` |
| FA-003-product-category-prefill | product-management | `#/products` | 打开商品编辑抽屉后，当前类目能在 cascader 中回填，类目 id/type id 不丢 | `syncCategoryPathFromForm`、`category_key`、`description_category_id`、`type_id` |
| FA-004-product-stock-readonly | product-management | `#/products` | 商品编辑页只显示库存上下文，不提供商品页改库存入口 | `当前总库存`、`库存和仓库请到库存管理修改`，且没有 `drawer.form.stock` 输入 |
| FA-005-collection-errors-visible | collection-box | `#/collection` | 采集失败行和编辑抽屉都能看到失败原因，并能从失败项重试 | `rowFailureReason`、`row.note`、`采集任务`、`重新采集`、失败 alert |
| FA-006-listing-task-error-visible | listing-history | `#/listing-history` | 上架记录显示 task id、状态、原始 Ozon 错误、中文错误，详情中仍可查看 | `detailDialog.row.task_id`、`errors_json`、`message_zh`、`Ozon 返回错误` |
| FA-007-dangerous-stock-order-confirmation | inventory-and-orders | `#/inventory,#/orders` | 库存批量提交、库存冲突覆盖、订单批量发货都必须先确认；取消单不可发货 | `库存草稿提交到 Ozon`、`发现 Ozon 实时库存冲突`、`不可逆的发货操作`、`row.status !== 'cancelled'` |
| FA-008-ai-provider-failure-reason | ai-product-images | `#/ai-generator` | AI 默认 provider、回退顺序、失败原因、provider attempts、历史 provider 都可见 | `generationFailure`、`generationAttempts`、`generationDescription`、`providerAttempts` |

## 手工记录模板

| 字段 | 记录 |
|---|---|
| 验收 ID |  |
| 测试环境版本 |  |
| 店铺/账号 |  |
| 操作步骤 |  |
| 截图/录屏 |  |
| 实际结果 |  |
| 结论 | Pass / Fail / Blocked |
| 失败原因 |  |

## 通过标准

正式用户验收通过需要同时满足：

- `npm run test:erp` 通过。
- `formal-user-acceptance-checklist.json` 的 8 项 guard 通过。
- 手工验收截图或录屏证明用户能看懂状态、错误、确认和下一步操作。
- 外部写影响项只在授权测试店铺执行，且失败时页面必须展示可操作原因。
