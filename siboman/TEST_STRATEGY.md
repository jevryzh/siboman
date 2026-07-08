# Siboman 项目测试策略文档

## 1. 异常测试用例矩阵 (Exception Handling Matrix)

针对跨境抓取中的不确定性，重点覆盖登录失效与结构变动场景。

| 场景分类 | 测试用例描述 | 预期行为 | 验证方法 |
| :--- | :--- | :--- | :--- |
| **1688 登录** | Cookie 令牌 (`_m_h5_tk`) 过期 | `ensure1688CookieState` 应触发 `refresh1688MtopToken` | 检查日志中是否有 "已尝试刷新 1688 搜图 token" |
| **1688 登录** | 账号被强制退出 (Session 彻底失效) | 捕获异常并停止搜图，日志记录 "没有拿到 1688 搜图 token" | 观察 collector 是否抛出 "请先完成登录" 的 UI 提示 |
| **1688 登录** | 出现滑块验证码 (Anti-bot) | 脚本触发 `waitForHumanVerificationIfNeeded` 并挂起 | 检查 UI 界面是否弹出验证提示，任务状态变为 "等待验证" |
| **页面解析** | Ozon 详情页标题/价格选择器失效 | `scrapeOzonProduct` 返回空值或触发断言错误 | 校验 `results.json` 中 `ozon.title` 是否为空 |
| **页面解析** | Ozon 页面出现 "商品不可售" 信号 | 命中 `unavailableSignals` 逻辑，停止当前行抓取 | 检查 Excel 导出中的 "Ozon 错误" 列是否记录相关原因 |
| **页面解析** | 1688 MTOP 接口结构变动 | `parseMtopText` 或 `assertMtopSuccess` 报错 | 确认任务是否计入 `consecutiveFailures` 并自动停止 |
| **数据导出** | 导出时主图文件缺失 | `writeXlsxWithEmbeddedImages` 应具备韧性跳过该图片 | 检查生成的 Excel 是否能正常打开，缺失图片行显示空白 |

---

## 2. 现有 Shell 脚本评审

### 脚本清单：
- `collector-test-start.sh`: 启动测试采集器。
- `collector-test-stop.sh`: 停止采集器进程。

### 优点：
- 使用 `pkill -f` 能够快速清理特定 URL 相关的进程，避免端口冲突。
- 区分了 `BROWSER_PROFILE_DIR`，保证测试环境不干扰生产环境的登录态。

### 覆盖盲点及不足：
1. **缺乏健康检查**：脚本启动后没有验证 `collector.js` 是否真正与服务器建立连接。
2. **日志管理简陋**：使用 `> /tmp/test-collector.log` 无法持久化历史错误，且不方便滚动查看。
3. **环境硬编码**：脚本中硬编码了 `/Users/eason/` 路径，缺乏跨平台兼容性。
4. **无回归验证**：停止脚本只是杀掉进程，没有检查当前是否有正在处理中的任务，可能导致数据损坏。

---

## 3. 自动化测试优化思路

### A. 单元测试与快照 (Extractor Testing)
- **目标**：解决 "页面结构变动" 导致的解析失效。
- **思路**：
    - 收集 Ozon 和 1688 的典型 HTML 样本（Save as HTML）。
    - 使用 Playwright 离线加载这些样本，运行解析逻辑。
    - 采用快照测试 (Snapshot) 比较解析出的 JSON 对象，任何字段丢失立刻报错。

### B. 接口健康监控 (API Monitoring)
- **目标**：解决 "1688 登录失效" 发现滞后的问题。
- **思路**：
    - 开发一个轻量级的 `canary-check.js` 脚本。
    - 每小时自动模拟一次简单的 Ozon URL 抓取和 1688 Token 获取。
    - 如果 Token 获取失败，通过集成插件（如 Feishu/Lark）发送即时预警。

### C. 自动化 UI 回归测试
- **目标**：验证整体业务链路。
- **思路**：
    - 利用 Playwright Test (Runner) 编写端到端脚本。
    - 模拟从“粘贴链接”到“点击采集”再到“下载 Excel”的完整流程。
    - 增加 Excel 内容校验逻辑，确保图片导出不是空白。

---

## 4. 改进建议

1. **引入任务重试策略**：在 `collector.js` 中增加针对临时网络抖动的重试次数。
2. **解耦解析逻辑**：将 `server.js` 中巨大的 `scrapeOzonProduct` 抽取为独立的解析模块，便于进行 mock 测试。
3. **增强日志可见性**：将日志推送到数据库或中央日志服务器，以便远程监控 `consecutiveFailures` 指标。
