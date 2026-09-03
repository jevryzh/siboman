# Yandex 商品批量调价与上架 Skill

## 目标

把已经从 Ozon 同步到 Yandex Market 的商品，按 1688 采购价和 CEL Economy 跨境头程价卡重新计算 CNY 售价，写回 Yandex，并补库存让商品进入可售处理队列。

## 输入

- Yandex 商品列表，至少包含 `offerId`、`marketSku`、标题、主图 URL、当前售价、币种。
- AlphaShop API 凭据，从安全配置读取，不能写入日志或文档。
- Yandex Market API 凭据，从服务端环境变量读取：
  - `YANDEX_MARKET_API_SECRET`
  - `YANDEX_MARKET_CLIENT_ID`
  - 可选：`YANDEX_MARKET_BUSINESS_ID`
  - 可选：`YANDEX_MARKET_CAMPAIGN_ID`
- 1688 登录态，用于以图搜图。

## 数据来源

1. 从 Yandex 商品主图或 Ozon 同步图发起 1688 以图搜图。
2. 对候选 1688 商品调用 AlphaShop 详情接口。
3. 从 AlphaShop 商品详情读取：
   - `productSaleInfo.priceRanges[*].price`
   - `productSaleInfo.priceRanges[*].startQuantity`
   - `productShippingInfo.skuShippingInfoList[*].weight`
   - `productShippingInfo.skuShippingInfoList[*].length`
   - `productShippingInfo.skuShippingInfoList[*].width`
   - `productShippingInfo.skuShippingInfoList[*].height`
4. 优先选择图片、标题、规格和 Yandex 商品最匹配的候选。不要只按最低价选明显不相关候选。

## 最小售卖单位

定价前必须确认 1688 价格对应的最小售卖单位。

- 如果 Yandex 标题是 `2 шт`，而 1688 候选是单件价格，则采购成本乘以 2，重量也乘以 2。
- 如果 1688 候选标题或 SKU 规格已经是 `12个装`、`12件套`、`12 шт`，则按整套价格和整套重量计算，不再乘数量。
- 如果候选存在多个 SKU，选中哪个 SKU 就使用该 SKU 的价格、重量和尺寸。

## 定价公式

Yandex 当前店铺按 CNY 售价写入：

```text
售价 CNY = ceil((采购价 + 国内运费 + 货代服务费 + 跨境头程费 + 尾程费) /
               (1 - 平台佣金率 - 收单费率 - 提现费率 - 退货亏损率 - 广告费率 - 目标毛利率))
```

默认参数：

- 国内运费：按页面或业务输入；未知时可先用 `4` 或 `5`，但必须在结果里标注来源。
- 货代服务费：`3` 元。
- 尾程费：ERP 默认 `4.68` 元；如果该店铺实际按百分比计算，需按业务配置覆盖。
- 平台佣金率：按类目配置；未知时先用 `22%`，但必须标注为默认值。
- 收单费率：`3.8%`。
- 提现费率：`1.2%`。
- 退货亏损率：默认 `0%`。
- 广告费率：默认 `10%`，如走 Ozon 精铺旧公式可设为 `0%`。
- 目标毛利率：ERP 默认 `35%`，如走 Ozon 精铺旧公式可设为 `15%`。
- 汇率：默认 `12.8205`，只用于按货值 RUB 匹配 CEL 价卡分区。

## CEL Economy 跨境头程价卡

先用 CNY 售价乘汇率估算 RUB 货值，再匹配分区。

| 分区 | 货值 RUB | 重量 | 计费公式 CNY |
| --- | --- | --- | --- |
| Extra Small | `<=1500` | `<=0.5kg` | `28.1 * Q + 3.37` |
| Budget | `<=1500` | `0.5-25kg` | `19.1 * Q + 25.83` |
| Small | `1501-7000` | `<=2kg` | `28.1 * Q + 17.97` |
| Big | `1501-7000` | `2-30kg` | `19.1 * Q + 40.44` |
| Premium Small | `7001-250000` | `<=5kg` | `28.1 * Q + 24.71` |
| Premium Big | `7001-250000` | `5-30kg` | `25.8 * Q + 69.64` |

计费重量：

- Big 和 Premium Big：`Q = max(实重kg, 长cm * 宽cm * 高cm / 12000)`。
- 其他分区：`Q = 实重kg`。

## 迭代计算

因为售价会影响 RUB 货值分区，必须迭代：

1. 先用当前成本和低货值分区估算售价。
2. 用估算售价乘汇率得到 RUB 货值。
3. 按价卡重新计算跨境头程费。
4. 重新计算售价。
5. 重复 3 到 5 次，直到售价和分区稳定。

## Yandex API 执行顺序

1. 获取店铺上下文：

```text
GET /v2/campaigns?limit=100
```

按 `YANDEX_MARKET_CAMPAIGN_ID` 或 `YANDEX_MARKET_BUSINESS_ID` 选中店铺。

2. 更新价格：

```text
POST /v2/businesses/{businessId}/offer-prices/updates
{
  "offers": [
    {
      "offerId": "...",
      "price": {
        "value": 31,
        "currencyId": "CNY"
      }
    }
  ]
}
```

3. 获取仓库：

```text
POST /v3/businesses/{businessId}/warehouses
```

4. 补库存上架：

```text
POST /v3/businesses/{businessId}/offers/stocks/update
{
  "skuItems": [
    {
      "sku": "...",
      "partnerWarehouseId": 2428333,
      "count": 100
    }
  ]
}
```

注意：`sku` 必须等于 Yandex 商品的 `offerId`，不要传 `marketSku`。

## 验收查询

价格：

```text
POST /v2/businesses/{businessId}/offer-prices
{
  "offerIds": ["..."]
}
```

库存：

```text
POST /v3/businesses/{businessId}/offers/stocks
{
  "partnerWarehouseId": 2428333,
  "offerIds": ["..."]
}
```

验收标准：

- Yandex 价格接口返回目标 CNY 售价。
- Yandex 库存接口返回 `FIT > 0`。
- 对每个 SKU 输出执行报告：Yandex SKU、offerId、1688 货源、采购价、售卖单位倍数、重量、尺寸、头程分区、计费重量、头程费、最终售价、价格更新状态、库存更新状态。

## 风险处理

- 如果 1688 以图搜图候选明显不匹配，不要自动调价，标记 `needs_manual_review`。
- 如果 AlphaShop 缺少重量，先尝试 `skuShippingInfos[*].skuWeight`；仍缺失时标记人工确认，不要用固定 `8.32`。
- 如果尺寸缺失且商品进入 Big/Premium Big 区间，必须人工补尺寸后再计算。
- 如果 Yandex 更新返回 `OK` 但商品仍不可售，继续查商品卡片审核状态或质量 verdict；价格和库存成功不等于审核一定通过。
