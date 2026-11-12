# 百度股市通接口

app 端定义：`api/StockService.kt`；响应模型：`api/beans.kt`（`BDStockResponse`、`BDResponse`）
主机：`finance.pae.baidu.com`

> 两个接口均需桌面 Chrome `User-Agent`（client.kt 网络拦截器自动附加）。

---

## 1. 行情排行（selfselect）`getRealTimeStocksBD`

- **方法**：`GET https://finance.pae.baidu.com/selfselect/getmarketrank`
- **参数**：
  | 参数 | 默认值 | 说明 |
  |------|--------|------|
  | `pn` | 调用方传入 | **offset 偏移量**（= 批次序号 × 200） |
  | `rn` | 200 | 每批条数 |
  | `group` | `ranklist` | 固定 |
  | `type` | `ab` | A/B 股 |
  | `finClientType` | `pc` | 固定 |
- **响应**：`BDStockResponse → Result.Result[0].DisplayData.resultData.tplData.result.rank: List<Rank>`；`Rank.list: List<Item8(text, value)>` 为文本键值对：`最新价`、`换手率`（带 %）、`涨跌幅`（带 %）、`振幅`（带 %）
- **调用**：`StockRepo.getRealTimeStocksBDInner(start, end, date)` — 按 offset 分批拉取；仅保留换手率 > 0 的记录，用 code 匹配本地 `Stock` 后更新 price/turnoverRate/amplitude/chg；`trackerType` 开启时同步 `realTimeStockMap`

## 2. 行情排行（sapi 表格版）`getRealTimeStocksBD2`

- **方法**：`GET https://finance.pae.baidu.com/sapi/v1/ranks`
- **固定参数**：`bizType=stock_rank&category=undefined&sortKey=&sortType=&market=ab&style=tablelist&finClientType=pc`
- **动态参数**：
  | 参数 | 说明 |
  |------|------|
  | `pn` | **offset 偏移量**（= 分片序号 × 1000） |
  | `rn` | 每批条数，默认 1000 |
- **响应**：`BDResponse(ResultCode==0) → Result.list.body: List<BDBody>`；`BDBody` 关键字段：`code/name/exchange/market` + `rawData: RawData(lastPx 最新价, pxChangeRate 涨跌幅%, pxChange, turnoverRatio 换手率, amplitude 振幅, volume, amount, marketValue)` — **rawData 为数值型，无需文本解析**（相比 selfselect 版更稳）
- **调用**：`StockRepo.getRealTimeStocksBD2Inner(pn, date)` ← `getRealTimeStocksBD2()`：启动 **6 个分片协程**（offset 0/1000/.../5000），交易时段内每片 1s 轮询；用返回的 price/chg 更新本地 `Stock` 并写当日 `HistoryStock`，驱动 Tracker（`trackerMap[code].update` 或 `realTimeStockMap`）
- **前置条件**：仅当本地 `HistoryBK` 中 `000001` 存在当日记录（即当日为交易日且大盘数据已同步）时才拉取
