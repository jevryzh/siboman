# Single Sourcing v2 QA Checklist

范围：测试环境 `https://test.renwz.cn/#/single-sourcing`，只验单品找货 v2。生产环境不在本清单范围内，批量上架只做回归保护，不改核心上架逻辑。

## Local Static Gate

运行：

```bash
node tests/test_single_sourcing_v2.cjs
npm run test:erp
git diff --check
```

必须通过：

- `#/single-sourcing` 是独立侧边栏入口，不是选品中心 Tab。
- 插件由 ERP 页面下发短期 worker token，插件不需要也不保存 ERP 账号密码。
- `app_jobs.store_id` 持久化，worker claim 和 job lookup 都按 scoped token 的店铺过滤。
- 候选数默认仍为 `5`，按用户输入传给插件，不能固定成 `3`。
- 日志含时间、级别、第几条/总数；结果表展示源行号；历史记录能下载 `ozon-1688-*.xlsx`。
- Excel 字段保留 Ozon/1688 图片、链接、MOQ、运费、重量、AI 判断、失败原因。
- MOQ=1 是推荐和 AI 审核硬规则，MOQ>1 或 MOQ 未取到不能自动判定可采用。
- 1688 登录/验证码错误必须显示给操作员，不能被吞成普通失败。
- 批量上架保护和插件 release 检查仍在 `npm run test:erp` 中执行。

## Test Environment Smoke

前置：

- 店铺管理下载的插件版本、Chrome 插件页显示版本、测试环境页面头部版本一致。
- 当前 Chrome 已登录 1688；ERP 页面已登录目标测试账号和目标店铺。
- 单品找货页只显示当前在线采集端，不应显示历史离线插件为可领取状态。

步骤：

1. 打开 `#/single-sourcing`，确认选品中心页面没有“单品找货”Tab。
2. 点击“打开 1688 首页”，确认跳到 `https://www.1688.com/`，人工确认账号已登录。
3. 输入 9 条 Ozon 商品链接，候选数设为 `5`，从第 `1` 行开始，AI 严格审核开启。
4. 开始任务，观察日志是否出现类似 `14:32:10 [INFO] 第 3/9 条 ...` 的时间、级别和行号。
5. 刷新页面，确认当前任务仍能恢复；停止任务时确认 worker 不再继续后台跑新行。
6. 任务完成后，在历史记录下载 Excel，核对页面结果与 Excel 行数、源行号一致。

## Data Quality Acceptance

Excel 核对：

- `Ozon图片` 和 `1688图片` 尽量嵌入；无法嵌入时 `Ozon主图链接` / `1688图片链接` 必须有值或失败原因。
- `最少起批`、`MOQ解析值`、`MOQ规则状态` 必须可解释；MOQ>1 或未知 MOQ 不能被 AI 判为可自动采用。
- `1688运费` 取不到时显示 `未公开/需选择地区` 或采集失败原因，不允许静默空白。
- `1688重量（克）` 取不到时必须保留 `1688重量来源` / `AI估算重量依据` 的可解释信息。
- `AI最终结果` 必须覆盖所有输入行，不能只审核前几条；失败时必须显示 provider/model/错误原因。

## Captcha / Login Acceptance

触发 1688 未登录或验证码时：

- 页面日志、结果状态、Excel 失败原因都要显示“需要人工处理”的信息。
- 如果验证码窗口不可见，任务必须提示用户打开 1688 首页处理，不能后台无限失败。
- 验证码处理完成后，应支持从指定行继续跑。

## Batch Upload Regression

单品找货每次部署前必须保留：

- `node tests/test_batch_listing_guard.cjs`
- `node tests/test_extension_release.cjs`
- `npm run test:erp`

真实回归只在测试店铺执行：批量上架 1 条，确认上架记录出现 Ozon task，状态为处理中或成功，且多图、rich content、库存/仓库没有退化。
