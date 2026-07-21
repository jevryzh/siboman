# ERP P1 全功能只读验收矩阵

任务：P1-3  
范围：店铺管理、商品管理、采集箱、批量上架保护、上架记录、库存、订单、AI 套图、经营分析、数据大屏、市场榜单。  
本地可执行源：`docs/testing/erp-p1-acceptance-matrix.json` + `tests/test_erp_acceptance_matrix.cjs`。

## 分级口径

| 分级 | 含义 | 本地 smoke 允许做什么 |
|---|---|---|
| read_only | 只读本地代码/fixture 或授权后的 ERP 查询，不产生外部写影响 | 静态结构、菜单、降级、只读接口信号 |
| requires_authorization | 需要登录态、店铺权限或角色权限才能验收真实链路 | 只校验鉴权/店铺隔离信号，不执行真实请求 |
| external_write_impact | 可能写 Ozon、写库存/订单、触发 AI 计费任务、发布插件或持久化关键业务数据 | 只校验护栏、确认、错误可见和跳转，不真实执行 |

## 矩阵

| 模块 | 路由 | 分级 | 不能只验页面打开，必须验的业务证据 |
|---|---|---|---|
| 店铺管理 | `#/stores` | requires_authorization | 店铺列表按用户权限返回；Client ID 脱敏；API Key 不渲染；manifest/zip/已安装插件版本可刷新并提示不一致 |
| 商品管理 | `#/products` | requires_authorization | 商品状态 Tab、搜索/分页/导出、1688 链接、体检问题、批量 100 上限、字段编辑 ownership 过滤、Ozon 同步结果可见 |
| 采集箱 | `#/collection` | requires_authorization | 按店铺/状态/搜索分页；失败原因、忽略/恢复、重试、CSV、多图、成本与利润风险可见；导入/删除只影响授权店铺 |
| 批量上架 | `#/upload` | external_write_impact | 发布前插件版本、单店约束、Seller category/type_id、多图、rich content、仓库/库存/价格完整；提交慢显示处理中，不能当完成 |
| 上架记录 | `#/listing-history` | requires_authorization | task_id、canonical status、原始错误、中文错误、部分成功说明、同步/重试/删除/CSV、筛选分页与店铺隔离 |
| 库存管理 | `#/inventory` | external_write_impact | 草稿持久化、低库存阈值、分仓、Excel 导入、冲突确认、负数阻断、批量提交结果、库存变更日志、店铺仓库隔离 |
| 订单管理 | `#/orders` | external_write_impact | 状态 Tab、日期筛选、详情、1688 货源、备注、面单、批量发货确认、取消单禁操作、Ozon 成功但本地库存失败可见 |
| AI 套图 | `#/ai-generator` | external_write_impact | 默认 Agnes，按 TokenDun、万相、MiniMax 回退；provider 状态、失败原因、历史可见；本地 smoke 不触发计费生成 |
| 经营分析 | `#/analytics` | read_only | dashboard/category/bestseller/profit/cost/exchange-rate 数据源可见；成本缺失不猜利润；失败有降级提示 |
| 数据大屏 | `#/data-screen` | read_only | 实时指标、订单流、库存告警、状态分布、全屏、零数据、断网降级，不写订单/库存/商品 |
| 市场榜单 | `#/market-discovery` | requires_authorization | 独立公共数据源、source/capture/confidence、不可用降级、加入采集箱显式触发；不得恢复单品找货入口 |

## 本地 Smoke

运行：

```bash
npm run test:p1-smoke
```

该测试读取 JSON 矩阵并校验：

- 菜单路由和组件注册存在。
- 每个模块至少有业务链路级验收点，不接受只有 route/menu 的条目。
- `external_write_impact` 模块必须声明外部写验收点和本地禁止真实执行的约束。
- 关键视图/后端护栏字符串存在，例如库存冲突、批量上架 Seller category/type_id、上架记录 raw error、AI provider fallback、榜单独立数据源。
- 单品找货不能作为普通侧边栏入口出现。

## 当前发现

| 编号 | 阻断级别 | 模块 | 建议分派 | 问题 |
|---|---|---|---|---|
| P1-3-BUG-01 | P1 | 店铺管理/API 契约 | backend-engineer | UI 主路径仍是 legacy `/api/seller/shops`，v1 契约路线需要持续跟踪，真实验收前要明确兼容或切换策略。 |
| P1-3-BUG-02 | P1 | 采集箱 | backend-engineer + testing-engineer | 已补本地 fixture/结构 guard 覆盖重复链接、重复 SKU、合并/跳过契约；真实采集链路仍需授权测试。 |
| P1-3-BUG-03 | P1 | AI 套图/商品文本 | backend-engineer + testing-engineer | 已补本地 fixture/结构 guard 覆盖 `<think>`、code fence、噪声和不完整 JSON；真实 AI 生成仍需授权测试。 |

## 验收结论

本矩阵把“页面能开”降为最低前置检查；P1 后续开发必须补足对应模块的只读、授权、外部写影响证据。真实 Ozon/AI/库存/订单写链路仅能在授权测试店铺下按矩阵逐项执行。
