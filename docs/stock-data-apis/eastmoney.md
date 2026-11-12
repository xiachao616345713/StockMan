# 东方财富（East Money）接口

app 端定义：`api/StockService.kt`（Retrofit）+ `repo/StockRepo.kt`（1 个原生 OkHttp SSE）
涉及主机：`20/31/43/52/53.push2.eastmoney.com`、`push2his.eastmoney.com`、`datacenter.eastmoney.com`、`datacenter-web.eastmoney.com`、`data.eastmoney.com`、`emcfgdata.eastmoney.com`、`emstockdiag.eastmoney.com`

---

## 1. 全市场 A 股实时快照 `getRealTimeStocks`

- **方法**：`GET http://20.push2.eastmoney.com/api/qt/clist/get`
- **固定参数**：`pz=200&np=1&fid=f3&fields=f2,f3,f7,f8,f12,f14,f15,f16,f17,f18,f21,f26,f297,f350,f351,f352,f383`（常量 `FILED`）
- **动态参数**：
  | 参数 | 说明 |
  |------|------|
  | `pn` | 页码，从 1 开始 |
  | `fs` | 市场过滤，默认常量 `FS`（全市场 A 股，见 README） |
- **响应**：`EMResponse → EMData(total, diff: List<EMDiffBean>)`；价格类字段 ×100（未设 fltt），f 字段含义见 README 映射表
- **调用**：`StockRepo.getRealTimeStocksDFCF2(start, end)` ← `getRealTimeStocksDFCF()`：拉取 pn=1..59，拆成 6 个并行任务（每任务 10 页）；结果写入 `Stock` + `HistoryStock` 表并驱动 Tracker
- **备注**：主机可换（20/43/52.push2 等效）；monitor 端对应 `EastMoneyApi.getRealtimeStocks`

## 2. 全市场 tick 订阅（SSE）`StockRepo.requestStocks`

- **方法**：`GET https://31.push2.eastmoney.com/api/qt/slist/sse`（原生 OkHttp 同步请求，非 Retrofit）
- **请求头**：`Accept: text/event-stream`
- **参数**：
  | 参数 | 值 | 说明 |
  |------|-----|------|
  | `secid` | `47.800000` | 全市场订阅专用 |
  | `ut` | `f057cbcbce2a86e2866ab8877db1d059` | 固定 token |
  | `fltt` | `1` | 数值 ×100 整数 |
  | `fields` | `f1,f2,f3,f4,f7,f8,f12,f13,f14,f15,f16,f17,18,f21,f26,f152,f297,f350,f351,f352,f383` | 注意源码中 `18` 缺 f 前缀 |
  | `pz` / `pn` | 2000 / 页码 | 分页订阅 |
  | `po`/`fid`/`mpi`/`spt`/`invt` | `1`/`f3`/`1000`/`11`/`2` | 排序与推送参数 |
- **响应**：SSE 流，每行 `data: {...}` → `StockEventBean`（`data.diff: Map<String, EMDiffBean>`）；**首帧为全量快照，后续帧为增量**（仅含变化字段，null 表示沿用缓存值），解析时 `"-"/"-"` 替换为 -1，价格 `/100`
- **调用**：`StockRepo.requestStocks(pn, pz=2000)` + `processEventLine()`；由 `Injector.kt` 自动刷新任务触发（`StockRepo.requestStocks(it + 1)`）

## 3. 单股分时流（SSE）`getRealTimeStockData`

- **方法**：`GET https://53.push2.eastmoney.com/api/qt/stock/trends2/sse`（`@Streaming`）
- **固定参数**：`fields1=FILED&fields2=f51,f52,f53,f54,f55,f56,f57,f58&mpi=1000&ut=fa5fd1943c7b386f172d6893dbfba10b&ndays=1&iscr=0&iscca=0`
- **动态参数**：`secid`（如 `1.600000` / `0.000001`）
- **响应**：SSE 流，每行含 JSON → `StockTrend(data.trends: List<String>)`，trends 行格式：`时间,开,收,高,低,成交量,成交额,...`
- **调用**：`StockRepo.getRealTimeStockData(code)`（逐行读取并解析）
- **备注**：StockService.kt 中另有被注释的 `stock/details/sse`（逐笔成交）变体

## 4. 上证指数日 K `getSHHistory`

- **方法**：`GET https://push2his.eastmoney.com/api/qt/stock/kline/get`
- **固定参数**：`secid=1.000001&klt=101&fqt=1&lmt=66&end=20500000&iscca=1&fields1=f1..f8&fields2=f51..f64&forcect=1`
- **响应**：`DPDayKLineResponse → Data(code, name, klines: List<String>, prePrice, ...)`；klines 行格式见 README
- **调用**：**仅定义，未见调用**（大盘分析 DPActivity 当前使用 `getBKHistory` 动态 URL 方式获取指数 K 线）

## 5. 通用日 K（动态 URL）`getBKHistory(@Url)`

- **方法**：`GET https://push2his.eastmoney.com/api/qt/stock/kline/get?...`（完整 URL 由调用方拼接）
- **公共参数**：`klt=101&fqt=1&end=20500000&iscca=1&fields1=f1..f8&forcect=1`；变化项为 `secid`、`lmt`、`fields2`
- **响应**：`DPDayKLineResponse`
- **调用场景**（均在 StockRepo.kt）：

| 调用函数 | secid | lmt | fields2 | 用途 |
|----------|-------|-----|---------|------|
| `getHistoryBks(count=250)` | `90.BKxxxx`（板块）或 `1.代码`（指数） | 250 | f51..f64 | 板块/指数历史日 K → `HistoryBK` |
| `fixData(code, fixedDate)` | `market.code`（个股） | 100 | f51..f64 + f350,f351,f352 | 修复某日历史数据（补昨收） |
| `fetchStockDayKlineRange(code, startDate, endDate, lmt=1200)` | `eastMoneyStockSecId(code)` | 1200 | f51..f64 + f350,f351,f352 | 个股区间日 K → `HistoryStock`（升序） |
| `getRealTimeIndexByCode(codeWithMarket)` | 如 `1.000001` | 1 | f51..f64 | 指数最新一日行情 → `BK` + `HistoryBK` |

## 6. 板块成份股 `getBKStocks`

- **方法**：`GET https://52.push2.eastmoney.com/api/qt/clist/get`
- **固定参数**：`pn=1&pz=10000&po=1&np=1&fields=f1..f26,f62,f128,f136,f115,f152,f45`
- **动态参数**：`fs=b:BKxxxx`（板块代码）
- **响应**：`EMResponse`（取 `data.diff[].code`）
- **调用**：`StockRepo.getBKStocks()` — 遍历全部非特殊板块（排除 `000001`），写入 `BKStock` 关联表；每 12 小时刷新（`fetch_bk_stocks_time`）

## 7. 板块实时行情 `getRealTimeTradeBK` / `getRealTimeConceptBK` / `getRealTimeBK`

- **方法**：`GET https://43.push2.eastmoney.com/api/qt/clist/get`
- **固定参数**：`pz=10000&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fields=f2,f3,f7,f8,f12,f14,f15,f16,f17,f18,f20,f21,f297`（getBKStocks 的 TradeBK 版；ConceptBK 版 `pz=200`）
- **fs**：
  - `getRealTimeTradeBK(pn)`：`m:90+t:2+f:!50`（行业板块）
  - `getRealTimeConceptBK(pn)`：`m:90+t:3+f:!50`（概念板块）
  - `getRealTimeBK()`：`m:90+t:2+f:!50,m:90+t:3+f:!50`（合并，**仅定义未见调用**）
- **响应**：`EMResponse`；`fltt=2` 返回浮点原值（无需 /100）
- **调用**：`StockRepo.getRealTimeBKs()` — 行业 5 页 + 概念 6 页，写 `BK` + `HistoryBK` 表

## 8. 板块成份股（动态 URL）`getStockListForBK(@Url)`

- **方法**：`GET`（完整 URL 传入），响应 `EMResponse`
- **参考 URL 模板**（StockService.kt 注释）：`https://push2.eastmoney.com/api/qt/clist/get?np=1&fltt=1&invt=2&fs=b:BK0482&fields=f14,f12,f13,...&fid=f62&pn=1&pz=8&po=1&ut=fa5fd1943c7b386f172d6893dbfba10b`
- **状态**：**仅定义，未见调用**

## 9. 股东户数 `getGDRS`

- **方法**：`GET https://datacenter.eastmoney.com/securities/api/data/v1/get`
- **固定参数**：`reportName=RPT_F10_EH_HOLDERNUM&columns=A_MARK,B_MARK,...,HOLDER_TOTAL_NUM,TOTAL_NUM_RATIO,...&client=APP&source=SECURITIES&pageNumber=1&pageSize=200&sr=-1&st=END_DATE`
- **动态参数**：`filter=(SECUCODE="600000.SH")`（代码.市场后缀 SH/SZ）
- **响应**：`GDRSResponse → Result(pages, count, data: List<GDRSBean>)`；关键字段：`END_DATE`、`HOLDER_TOTAL_NUM`（股东总数）、`TOTAL_NUM_RATIO`（环比变化）、`AVG_FREE_SHARES`（户均流通股）、`HOLD_FOCUS`（筹码集中度）
- **调用**：`StockRepo.getHistoryGDRS()` — 遍历全部个股逐只请求（TOTAL_NUM_RATIO 为 0 时用相邻两期户数差自行计算），写 `GDRS` 表；每 5 天刷新（`fetch_gdrs_time`）
- **备注**：F10 数据而非行情，因定义在 StockService 一并收录

## 10. 人气榜 `getPopularityRanking`

- **方法**：`GET https://data.eastmoney.com/dataapi/xuangu/list`
- **固定参数**：`st=POPULARITY_RANK&sr=1&ps=300&p=1&sty=SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,POPULARITY_RANK&filter=(POPULARITY_RANK>0)(POPULARITY_RANK<=1000)&source=SELECT_SECURITIES&client=WEB`
- **响应**：`PopularityRankingResponse → ResultX(count, data: List<PopularityData>)`；关键字段：`SECURITY_CODE`、`POPULARITY_RANK`、`CHANGE_RATE`、`VOLUME_RATIO`
- **调用**：`StockRepo.fetchPopularityRanking()` → `PopularityRank` 表（rank 字段）

## 11. 龙虎榜 `getDragonTigerRank(@Url)`

- **方法**：`GET https://datacenter-web.eastmoney.com/api/data/v1/get`（完整 URL 由 `fetchDragonTigerRank` 拼接）
- **固定参数**：`reportName=RPT_DAILYBILLBOARD_DETAILSNEW&sortColumns=SECURITY_CODE,TRADE_DATE&sortTypes=1,-1&pageSize=100&pageNumber=1&columns=SECURITY_CODE,...,EXPLANATION,D1/D2/D5/D10_CLOSE_ADJCHRATE,...&source=WEB&client=WEB`
- **动态参数**：`filter=(TRADE_DATE<='yyyy-MM-dd')(TRADE_DATE>='yyyy-MM-dd')`（URL 编码）
- **响应**：`DragonTigerRankResponse → result.data: List<DragonTigerRankData>`；关键字段：`SECURITY_CODE`、`EXPLANATION`（上榜原因）、`BILLBOARD_NET_AMT`（榜单净买）、`D1_CLOSE_ADJCHRATE`（次日涨幅）
- **调用**：`StockRepo.fetchDragonTigerRank(date)` — 15:00 后拉取；与同花顺龙虎榜（tags）合并后写 `DragonTigerRank` 表

## 12. 预期热点 `getExpectHot`

- **方法**：`POST https://emcfgdata.eastmoney.com/api/themeInvest/getExpectHot`
- **请求体**：`ExpectHotParam(client="web", clientType="cfw", clientVersion="8.3", randomCode="XyuKF8DSJNhfne3N", timestamp=当前毫秒)`
- **响应**：`ExpectHotResponse → data: List<ExpectHotData(date, summary, expireTime, theme: List<Theme(code, name, f3)>)>`
- **调用**：`StockRepo.getExpectHot()` — 题材名匹配本地 `BK` 表后写 `ExpectHot` 表（id 由 code+date+summary 的 MD5 生成）

## 13. 个股热点题材 `getHotTopicForStock`

- **方法**：`POST https://emstockdiag.eastmoney.com/apistock/Tran/GetData`
- **请求体**：`HotTopicParam`，关键字段 `parm` 为 JSON 字符串：`{"deviceid":"C1C1...","version":"180","product":"EastMoney","plat":"Android","gubaCode":"SZ300260,SH600111,..."}`（gubaCode 为逗号分隔的带市场前缀代码），`path="newtopic/api/Topic/GubaCodeHotTopicNewRead"`
- **响应**：`HotTopicResponse(RData: String)` — RData 为嵌套 JSON 字符串，二次解析为 `RDataBean(re: Map<code, List<RDataInnerBean(name, summary)>>)`
- **调用**：`StockRepo.fetchDFCFHotTopic(codes)` — 返回个股 → 热点题材列表
