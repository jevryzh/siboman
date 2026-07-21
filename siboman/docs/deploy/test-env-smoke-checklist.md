# 测试环境 Smoke 清单

每次部署到 `https://test.renwz.cn` 后，先完成本清单，再交给用户验收。

## 命令检查

```bash
curl -fsS https://test.renwz.cn/api/version
curl -fsS https://test.renwz.cn/extension/zhumeng-collector/manifest.json
curl -fsS 'https://test.renwz.cn/extension/zhumeng-collector.zip?v=2.2.9.53' | shasum -a 256
```

## 页面检查

- 登录页可打开，登录测试账号成功。
- 顶部店铺切换器显示当前店铺，不默认多选批量上架店铺。
- 商品管理：图片可放大，状态显示中文，编辑页类目可回填，库存为只读说明。
- 采集箱：失败原因可见；已采集记录点“送上架”后，只预填批量上架，不自动提交 Ozon。
- 批量上架：插件状态、店铺、仓库、库存、水印、AI 重写可见；解析后页面不被撑破；上架后可跳转上架记录。
- 上架记录：task id、中文状态、错误摘要、同步/重试/导出入口可见。
- 库存管理：库存写入有明确确认，仓库状态为中文。
- 订单管理：发货/取消等危险操作有确认提示。
- AI 生图：provider、失败原因、可用操作清晰。

## 记录要求

把本次结果写到 `docs/testing/acceptance-runs/YYYY-MM-DD-版本.md`，至少包含：

- `/api/version.version`
- `/api/version.buildTime`
- 插件 manifest version
- 插件 zip sha256
- 测试账号与店铺
- 失败项截图或录屏路径
- 修复 owner 与复测版本
