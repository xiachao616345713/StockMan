# 搜狐财经接口

app 端定义：`api/StockService.kt`；响应模型：`api/beans.kt`（`HistoryBean`）
主机：`q.stock.sohu.com`（http，依赖 manifest 的 cleartext 配置）

---

## 个股历史日 K `getStockHistory`

- **方法**：`GET http://q.stock.sohu.com/hisHq`
- **参数**：
  | 参数 | 说明 | 示例 |
  |------|------|------|
  | `code` | 股票代码，`cn_` 前缀，支持逗号分隔批量 | `cn_000547,cn_600000` |
  | `start` | 开始日期 `yyyyMMdd` | `20220801` |
  | `end` | 结束日期 `yyyyMMdd` | `20220802` |
- **响应**：`List<HistoryBean(status, code("cn_000547"), hq: List<List<String>>)`；`hq` 每行：
  `[0]日期(yyyy-MM-dd) [1]开盘 [2]收盘 [3]涨跌额 [4]涨跌幅% [5]最低 [6]最高 [7]成交量(手) [8]成交额(万) [9]换手率%`
- **调用**：`StockRepo.getHistoryStocks(startDate, endDate)` — 从本地 `Stock` 表取全部代码，**每批 2 只**循环请求，解析后写 `HistoryStock` 表（ztPrice/dtPrice/昨收等置 -1，amplitude 置 100 占位），Toast 显示进度
- **备注**：monitor 端 `SohuApi.getStockHistory` 为同源接口（https + Referer/UA 头），作为历史日 K 的首选策略（`SohuHistoryStockStrategy`），东财 kline 为兜底（`EastMoneyHistoryStockStrategy`）
