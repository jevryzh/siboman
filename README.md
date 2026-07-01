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
