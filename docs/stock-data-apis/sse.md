# 上海证券交易所接口

app 端定义：`api/StockService.kt`；响应模型：`api/beans.kt`（`StockResponse`）
主机：`yunhq.sse.com.cn:32042`（自签/特殊证书，依赖 client.kt 的信任所有证书配置）

---

## 沪市 A 股实时列表 `getRealTimeStocks3`

- **方法**：`GET https://yunhq.sse.com.cn:32042/v1/sh1/list/exchange/equity`
- **固定参数**：
  | 参数 | 值 |
  |------|-----|
  | `select` | `code,name,open,high,low,last,prev_close,chg_rate,volume,amount,tradephase,change,amp_rate,cpxxsubtype,cpxxprodusta,` |
  | `order` | 空 |
  | `begin` / `end` | `0` / `2500`（区间分页） |
  | `_` | 时间戳（防缓存） |
- **响应**：`StockResponse(date: Int, list: List<List<Any>>)` — 二维数组，列序与 `select` 一致：
  `[0]code [1]name [2]open [3]high [4]low [5]last [6]prev_close [7]chg_rate [8]volume [9]amount [10]tradephase [11]change [12]amp_rate [13]cpxxsubtype [14]cpxxprodusta`
- **调用**：`StockRepo.getRealTimeStocksSH()` — 按 code 去重（LinkedHashMap），过滤 `price==0`；仅含**沪市 A 股**，与本地 `Stock` 合并后入库并驱动 Tracker；耗时打点「获取上交所数据」
- **备注**：
  - monitor 端对应 `SseApi.getEquities`（`network/SseApi.kt`），使用 trustAll OkHttpClient；`SseRealtimeStockStrategy` 注释明确「只有沪 A 数据，保留为后续局部数据源，不参与全量实时快照策略链」，begin/end 每页 2500 循环拉全量
  - 请求无需特殊 UA，但证书校验必须放开（app 端 client.kt、monitor 端 trustAllOkHttpClient）
