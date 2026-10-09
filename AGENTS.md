<!-- codex-memory:start -->
## 项目记忆（Codex 插件市场自动维护 · 回答前据此 · 勿手动编辑本段）
**当前状态**：当前已按 product-analyst 角色完成只读需求/验收分析，未改代码。结论是单品找货 v2 必须作为独立入口恢复，跑通 Ozon 采集、1688 以图搜货、候选详情、AI 审核、历史与 Excel，并且不得影响批量上架。
**已定决策**：
- 图片已生成并保存到本地
- 默认列表问题不是归档或preview
- 旧库替换前已备份
- 保留并同步 63 条历史记录
- 以UI读取的sqlite库为准
- 将旧 provider 元数据归一为 openai
- 修复数据库和 rollout 元数据前需先备份。
- 保留并补回local-router配置
- 需同步数据库和 rollout 元数据
- 默认列表异常与provider/索引相关
- product-analyst 阶段不改代码
- v2 必须有可判定 P0/P1 验收
**下一步**：
- 由实现 agent 按清单改代码
- 新增独立单品找货入口
- 补齐插件/ERP账号关系校验
- 补任务领取和日志验收 guard
- 跑批量上架回归验证
**关键文件**：/Users/eason/Documents/OZON/siboman/public/js/views/SourcingModule.js、/Users/eason/Documents/OZON/siboman/server.js、/Users/eason/Documents/OZON/agents-erp-ozon/AGENTS.md、/Users/eason/Documents/OZON/siboman/public/extension/zhumeng-collector/background.js、/Users/eason/Documents/OZON/siboman/public/extension/zhumeng-collector/content-bridge-iso.js、/Users/eason/Documents/OZON/siboman/scripts/check-extension-release.mjs、/Users/eason/Documents/OZON/siboman/docs/deploy/test-env-smoke-checklist.md、/Users/eason/Documents/OZON/siboman/docs/deploy/test-env-deploy-runbook.md
**历史话题（需其中细节时用下面命令检索）**：
- 2026-07-17 生成花裤衩大象图片
- 2026-07-16 等待用户提供具体任务
- 2026-07-16 无实际会话内容
- 2026-07-16 无有效项目上下文
- 2026-07-16 闲聊与报时
- 2026-07-16 Codex历史列表不显示
> 回答涉及本段未列出的历史细节前，先运行 `rg -n "关键词" /Users/eason/.codex/memory/c51a27dddd71.md` 查证再答。
<!-- codex-memory:end -->

<!-- user-preferences:start -->
## 用户长期偏好（默认就要做，不用每次提醒）

Eason 明确要求：以下约定在**所有新功能/改动里默认实现**，不要再问「要不要加」。

1. **商品图片必须支持鼠标悬停自动放大**（hover 预览）。
   - 凡是出现商品缩略图的地方都要有：ERP 各列表页、浏览器插件面板、插件浮层等。
   - 统一样式：hover 时在光标旁浮出大图（约 260×260，`object-fit:contain`，下面带商品名），
     鼠标移开会消失；靠边时自动收进视口内，不要被裁掉。
   - 已经是「点击放大」（`el-image` 的 `preview-src-list`）的地方，也要**额外加 hover 放大**。
2. 所有列表默认支持点表头排序。
3. 任何批量写操作前先做快照 / 保证可回滚。
4. 只在测试服 `test.renwz.cn` 上操作，不要动生产。
5. 告警/通知邮件发 `313099488@qq.com`。
6. CSV 交付物一律 UTF-8 带 BOM，Excel 直接能打开。

> 以后新增的长期偏好继续往这一段加。
<!-- user-preferences:end -->
