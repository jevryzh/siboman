# Ozon to 1688 Sourcing Tool

私有 Ozon -> 1688 找货工具：批量输入 Ozon 商品链接，抓取商品标题、图片、价格、属性，再用主图去 1688 以图搜货，最后导出带图片的 Excel。

新会话或新模型接手前，先读：

```bash
/Users/eason/Documents/OZON/PROJECT_CONTEXT.md
```

## 本地单机模式

```bash
npm install
npm start
```

打开页面后：

1. 点击“打开 1688 登录窗口”，在弹出的浏览器里登录 1688。
2. 粘贴 Ozon 链接，每行一个。
3. 点击“开始采集”。
4. 完成后下载 Excel。

数据和图片会保存在 `data/jobs/` 下。浏览器登录状态会保存在 `data/browser-profile/` 下。

## 服务器队列模式

当前正式使用的是服务器队列模式：

- 服务器：`http://xm.renwz.cn`
- 服务器负责：登录、任务队列、历史记录、Excel 下载
- 本机采集端负责：在用户/同事电脑上打开 Ozon 和 1688 执行采集

服务器模式下，不需要在网页里点“打开 1688 登录窗口”。创建任务后，本机采集端会自动领取。

## 本机采集端

服务器模式下，网页登录后创建任务，采集由本机采集端领取执行：

```bash
npm run collector
```

当前后台运行方式：

```bash
screen -dmS ozon-collector /bin/zsh -lc 'cd /Users/eason/Documents/OZON && exec /opt/homebrew/bin/node collector.js >> data/collector.log 2>> data/collector-error.log'
```

查看后台采集端：

```bash
screen -ls
tail -f data/collector.log
```

停止后台采集端：

```bash
screen -S ozon-collector -X quit
```

## 配置

复制 `.env.example` 到 `.env`，填入真实密钥和账号密码：

```bash
cp .env.example .env
```

不要提交 `.env`。

## Yandex 多店铺管理（2026-09 起）

系统在 Ozon 店铺之外新增 **Yandex Market 店铺体系**（`app_stores.platform = 'yandex'`），支持多 Yandex 店铺并存、切换与隔离管理：

- **店铺授权**：店铺管理页可新增 Yandex 授权（平台切换 → 填 API Key → 探测并选择 campaign）；环境变量配置的旧店铺（Three Latte）启动时自动迁入。
- **Yandex 商品页 / 订单页 / 库存页**：顶栏按路由自动切换到 Yandex 店铺体系，全部接口按 `store_id` 隔离（含改价记录、调价候选、AI 优化记录）。
- **Yandex 库存管理页**（`#/yandex-inventory`）：实时拉取平台仓库与库存（FIT/AVAILABLE），支持分仓修改、批量设值、低库存统计；首次全量拉取异步预热，前端轮询展示。
- **卡片质量评分**（本地估算 0-100，≥80 绿）：按标题/图片/描述/属性/类目完整性计分，随列表展示并支持质量、AI 状态、调价状态多维筛选。
- **AI 优化（对标"熊猫上架"补全模式）**：列表行内 / 批量「AI 优化」与编辑抽屉「AI 智能填充」——只补空缺字段：俄语标题改写、描述生成、**空缺类目属性自动选合法值**（枚举从 Yandex 类目参数模板取值，测量类属性禁止 AI 猜测）；每次提交计入 `yandex_ai_records`（时间/改动维度/状态），列表可查次数与明细。
- **属性名中文化**：`data/yandex_attr_zh.json` 提供俄→中属性名词典（169 条高频属性），编辑弹窗与 AI 结果均显示中文名。

详细变更说明见 [docs/2026-09-yandex-multistore-ai-update.md](docs/2026-09-yandex-multistore-ai-update.md)。
