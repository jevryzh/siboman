# 09-data-screen · 数据大屏需求文档

> 归属模块：数据可视化 ｜ 优先级：P2 ｜ 预估工作量：5.5 人日 ｜ 状态：待评审
> 版本：v2.1 (详尽版)

## 1. 背景

随着“逐梦 ERP”功能的日益完善，商家对于数据的实时感知要求不断提高。现有的仪表盘（`app.js:180`）虽然能提供关键数据，但由于受限于后台管理页面的布局，无法在监控终端或办公室大屏上进行直观展示。

本需求旨在构建一个沉浸式的、暗色主题的数据大屏，对标 MyERP 的“数据大屏”（`docs/myerp-reference/18-data-screen.png`）。大屏不仅是视觉上的美化，更是为了帮助卖家在繁忙的促销期（如大促、节日）快速掌握订单脉搏，识别库存告警，提升团队响应速度。

### 1.1 变更记录

| 版本 | 日期 | 变更内容 | 变更人 |
| :--- | :--- | :--- | :--- |
| v1.0 | 2026-06-28 | 初始构想 | Eason |
| v2.0 | 2026-07-02 | 细化暗色主题方案、实时刷新机制与 Fullscreen API 实现 | Codex |
| v2.1 | 2026-07-02 | 增加前端组件细节、动效设计及详尽验收标准 | Codex |

---

## 2. 目标与非目标

### 2.1 目标
- **实时性**：订单状态变更、GMV 跳动需在 30 秒内反映在屏幕上。
- **视觉冲击**：采用暗蓝/深灰基调，支持全屏模式（Fullscreen API）。
- **关键指标**：今日 GMV、今日订单、待打包、待发货、库存预警。
- **订单流**：滚动显示最近 15 条订单详情（订单号、金额、商品缩略图）。
- **低功耗**：优化前端 DOM 操作，确保页面长期开启不内存泄漏。

### 2.2 非目标
- **交互编辑**：大屏主要用于展示，不包含复杂的订单修改或状态操作功能。
- **地理分布**：由于目前主要服务于 Ozon 俄罗斯市场，暂不做基于地图的订单分布。
- **3D 引擎**：不引入 Three.js 等大型 3D 库，保持轻量级。

---

## 3. 用户故事

| ID | 用户角色 | 需求场景 (Given/When) | 期望结果 (Then) | 关联 AC |
| :--- | :--- | :--- | :--- | :--- |
| US.01 | 店主 | 当我走进办公室时 | 能一眼看到巨大的“今日 GMV”数字，了解当天销售表现 | AC.01, AC.08 |
| US.02 | 仓管 | 当库存低于阈值时 | 大屏底部的滚动条出现红色闪烁告警，提示补货 | AC.06, AC.13 |
| US.03 | 客服 | 当有新订单生成时 | 大屏右侧的列表自动弹入一条新记录，并伴有轻微动效 | AC.05, AC.11 |
| US.04 | 店主 | 当我想向合作伙伴展示实力时 | 点击“全屏模式”，界面自动隐藏侧边栏并充满整个屏幕 | AC.02, AC.11 |

---

## 4. 界面草图 (ASCII Sketch)

```text
+---------------------------------------------------------------------------------------+
|  [实时作战大屏]                                                   2026-07-02 14:30:00  |
+---------------------------------------------------------------------------------------+
|  +-------------------+  +-------------------------------------+  +-----------------+  |
|  |   今日成交总额      |  |         GMV 24小时变化趋势            |  |    订单实时流    |  |
|  |  ¥ 12,840.50      |  |                                     |  |  #7654321  ¥120 |  |
|  |  ↑ 8.5%           |  |      * * *                          |  |  #7654322  ¥85  |  |
|  +-------------------+  |    *       *                        |  |  #7654323  ¥210 |  |
|  |   今日订单总数      |  |  *           *                    |  |  #7654324  ¥45  |  |
|  |      85           |  | *             *                   |  |  #7654325  ¥99  |  |
|  +-------------------+  +-------------------------------------+  |  #7654326  ¥15  |  |
|  |   待处理事项        |  +-------------------------------------+  |  #7654327  ¥130 |  |
|  |  待打包: 12        |  |         订单状态构成 (Pie)           |  |  #7654328  ¥77  |  |
|  |  待发货: 05        |  |   [已支付][待处理][运送中]            |  |  ...             |  |
|  +-------------------+  +-------------------------------------+  +-----------------+  |
+---------------------------------------------------------------------------------------+
|  [警告] SKU-12345 (蓝牙耳机) 库存仅剩 2 件 | [警告] SKU-88776 (充电头) 缺货             |
+---------------------------------------------------------------------------------------+
```

---

## 5. 核心技术方案

### 5.1 全屏切换机制 (JS)

```javascript
function toggleDataScreenFullscreen() {
    const el = document.getElementById('data-screen-container');
    if (!document.fullscreenElement) {
        el.requestFullscreen();
        el.classList.add('is-fullscreen');
    } else {
        document.exitFullscreen();
        el.classList.remove('is-fullscreen');
    }
}
```

### 5.2 暗色主题 CSS 变量

```css
:root {
    --screen-bg: #0b0e14;
    --card-bg: rgba(25, 30, 40, 0.8);
    --text-primary: #e0e0e0;
    --accent-color: #00d2ff;
}
#data-screen-container {
    background: var(--screen-bg);
    display: grid;
    grid-template-areas: 
        "header header header"
        "stats  trend   feed"
        "footer footer  footer";
    grid-template-columns: 320px 1fr 380px;
}
```

---

## 6. 前端组件详细设计

### 6.1 KPI 卡片 (KPI Cards)
- **今日成交额**: 48px, 金黄色 (#f1c40f)。
- **订单总数**: 36px, 天蓝色 (#3498db)。

### 6.2 趋势折线图 (Chart.js)
- **配置**: `tension: 0.4`, `fill: true`, `pointRadius: 0`。

### 6.3 订单实时流
- **动效**: 新条目从底部淡入并上移，池化复用 DOM。

---

## 7. 后端 API 适配

### 7.1 GET /api/seller/dashboard?realtime=true
- 跳过 5 分钟缓存。
- 返回 `today_trend: [[hour, gmv], ...]`。

---

## 8. 验收标准 (AC) 详尽版

1.  **[AC.01] 实时性验证**：30 秒内“今日订单数”需发生变化。
2.  **[AC.02] 全屏模式**：页面充满整个显示器，不留任务栏。
3.  **[AC.03] 对比度**：主要数字对比度 > 7:1。
4.  **[AC.04] 性能长跑**：持续开启 12 小时，内存增长 < 50MB。
5.  **[AC.05] 滚动流畅**：动画保持 60FPS。
6.  **[AC.06] 库存警告**：库存 < 10 的 SKU 立即加入跑马灯。
7.  **[AC.07] 断网提示**：弹出“Connection Lost”遮罩。
8.  **[AC.08] 数字动效**：通过 `countUp.js` 实现滚动增长。
9.  **[AC.09] 2K/4K 适配**：自适应缩放，不模糊。
10. **[AC.10] 静态资源**：2s 内加载完成。
11. **[AC.11] Esc 退出**：瞬间导航回 `#/dashboard`。
12. **[AC.12] 状态颜色**：必须符合官方指定色值。
13. **[AC.13] 跑马灯速度**：单条经过时间 > 5s。
14. **[AC.14] 响应式**：iPad 横屏核心指标可见。
15. **[AC.15] 零数据状态**：正常显示 0，不崩溃。

---

## 9. 工作量估算 (详细拆解)

| 阶段 | 任务 | 工期 (人日) |
| :--- | :--- | :--- |
| **设计** | UI 风格与暗色规范 | 0.5 |
| **前端** | 基础框架与全屏逻辑 | 1.0 |
| | 组件开发 (Chart, List) | 1.5 |
| | 实时引擎与动效 | 1.0 |
| **后端** | 实时 API 与缓存优化 | 1.0 |
| **测试** | 适配与长跑测试 | 0.5 |
| **总计** | | **5.5** |

---

## 10. 风险与回滚

- **风险**：GPU 内存溢出。
- **对策**：每 6 小时静默刷新页面。
- **回滚**：移除路由入口。

---

## 11. 后续演进

- 多店轮播、语音广播。

---
## 13. 前端交互细节与伪代码 (Frontend Details)

### 13.1 大屏自适应引擎
为了在不同长宽比的显示器上都能完美展示，采用 CSS `scale` 方案：
```javascript
function autoScaleScreen() {
    const designWidth = 1920;
    const designHeight = 1080;
    const clientWidth = document.documentElement.clientWidth;
    const clientHeight = document.documentElement.clientHeight;
    
    const scale = Math.min(clientWidth / designWidth, clientHeight / designHeight);
    const el = document.getElementById('data-screen-container');
    el.style.transform = `scale(${scale}) translate(-50%, -50%)`;
    el.style.left = '50%';
    el.style.top = '50%';
    el.style.position = 'absolute';
    el.style.transformOrigin = 'center center';
}
window.addEventListener('resize', autoScaleScreen);
```

### 13.2 动态数字跳动组件 (Number Counter)
```javascript
function animateNumber(id, start, end, duration) {
    let obj = document.getElementById(id);
    let range = end - start;
    let minTimer = 50;
    let stepTime = Math.abs(Math.floor(duration / range));
    stepTime = Math.max(stepTime, minTimer);
    let startTime = new Date().getTime();
    let endTime = startTime + duration;
    let timer;

    function run() {
        let now = new Date().getTime();
        let remaining = Math.max((endTime - now) / duration, 0);
        let value = Math.round(end - (remaining * range));
        obj.innerHTML = value.toLocaleString();
        if (value == end) {
            clearInterval(timer);
        }
    }
    timer = setInterval(run, stepTime);
    run();
}
```

## 14. 页面视觉规范 (Visual Specs)

### 14.1 色彩定义
- **背景背景**: `#0b0e14` (Deep Space)
- **卡片背景**: `rgba(25, 30, 40, 0.8)` (Frosted Glass)
- **主文字**: `#ffffff` (White)
- **次要文字**: `#8a8a8a` (Gray)
- **装饰线**: `linear-gradient(90deg, #00d2ff, #3a7bd5)` (Blue Gradient)

### 14.2 字体排版
- **大标题**: `24px`, Font-Weight: `700`, Letter-Spacing: `2px`
- **KPI 数字**: `64px`, Font-Family: `'Roboto Mono', monospace`
- **订单列表**: `16px`, Line-Height: `1.8`

## 15. 用户操作说明 (User Guide)

### 15.1 如何进入大屏
1. 登录 ERP 后，在左侧导航栏选择“数据可视化” -> “实时大屏”。
2. 页面加载完成后，点击右上角的“全屏预览”按钮。
3. 浏览器会提示是否允许进入全屏，点击“允许”。

### 15.2 如何配置告警阈值
1. 在“系统设置” -> “可视化设置”中。
2. 修改“大屏库存预警阈值”，默认值为 10。
3. 修改“大屏刷新频率”，支持 30s / 60s / 5min 三档。

### 15.3 故障排除
- **黑屏**: 请检查浏览器是否支持 WebGL（部分 Chart.js 渲染需要）。
- **数字不更新**: 检查网络连接，或尝试按 `F5` 刷新页面重连 WebSocket/Polling。
- **布局错乱**: 确保浏览器缩放比例为 100%。

## 16. 核心组件交互逻辑 (Widget Interaction)

### 16.1 实时订单流列表 (Feed Component)
```javascript
/**
 * 模拟新订单推入效果
 */
function pushNewOrderToFeed(order) {
    const list = document.querySelector('.order-list-inner');
    const item = document.createElement('div');
    item.className = 'order-item new-pulse'; // 带有呼吸灯动画的类
    item.innerHTML = `
        <img src="${order.image}" class="sku-thumb" />
        <div class="info">
            <span class="id">#${order.id}</span>
            <span class="sku">${order.sku_name}</span>
        </div>
        <div class="price">¥ ${order.amount}</div>
    `;
    
    // 插入到最前面
    list.prepend(item);
    
    // 超过 15 个则移除最后一个
    if (list.children.length > 15) {
        list.removeChild(list.lastChild);
    }
    
    // 播放提示音 (可选)
    // if (state.audioEnabled) playOrderSound();
}
```

### 16.2 KPI 数字滚动特效 (Number Animation)
使用 `requestAnimationFrame` 确保 60FPS 的数字翻滚效果，避免浏览器重排（Reflow）导致的卡顿。

## 17. 性能优化专项 (Performance Tuning)

### 17.1 GPU 硬件加速
在大屏 CSS 中，对频繁变化的组件（滚动列表、跑马灯）强制开启 GPU 加速：
```css
.order-list-inner, .marquee-text {
    will-change: transform, opacity;
    transform: translateZ(0); /* 开启 3D 加速 */
}
```

### 17.2 定时器精准控制
使用自定义的 `TimerManager` 统一管理大屏上的所有异步任务，防止页面在非激活状态下过度消耗 CPU。

## 18. 后台数据聚合详情 (Data Aggregation)

### 18.1 实时趋势计算
后端 `server.js` 会缓存最近 24 小时的订单时间戳，在 realtime 请求时，快速按小时进行 `Group By` 统计。

## 19. 安全与监控 (Monitoring)

- **前端心跳检测**: 大屏每 10 秒向后端发送一次 `ping`，若 3 次未响应则自动触发页面重载。
- **白名单限制**: 建议在 Nginx 层面限制大屏入口的 IP 地址。

## 20. 验收测试案例 (QA Cases)

### TC-SCREEN-01: 4K 分辨率压力测试
1. **Given**: 使用 4K 电视（3840x2160）作为显示终端。
2. **When**: 开启全屏大屏，持续运行 2 小时。
3. **Then**: 文字必须保持锐利，不应有模糊或拉伸感，帧率保持在 30FPS 以上。

### TC-SCREEN-02: 断网恢复一致性
1. **Given**: 拔掉网线 5 分钟后插回。
2. **When**: 网络恢复。
3. **Then**: 大屏应能在 30s 内自动恢复轮询，且数字应从“缓存值”平滑跳动到“最新值”。

### TC-SCREEN-03: 多状态图表同步
1. **Given**: Ozon 后台有 5 笔订单从“待处理”变为“运输中”。
2. **When**: 大屏刷新。
3. **Then**: 饼图（状态分布）的扇区比例应同步发生变化。

---
*文档版本：v2.3*
*编写日期：2026-07-02*
