# 其他数据源接口

财新、大智慧、淘股吧、九阳公社、开盘啦（longhuvip）。app 端定义均在 `api/StockService.kt`。

---

## 1. 财新网 — 全市场涨幅榜 `getRealTimeStocksCX`

- **方法**：`GET https://stock.caixin.com/cgi/StockRankEx`
- **固定参数**：`mar=all&type=changeRate&page=1&size=6000&isAsc=false`（按涨幅降序，一次取 6000 条）
- **响应**：`CXStockDataResponse(status, data: CXData(list, page, pages, timestamp))`；`CXItem` 关键字段：`stkCode/stkShortName/curPrice/changeRate/openPrice/highPrice/lowPrice/preClosePrice/upLimit/downLimit`（**含涨跌停价**）`/turnoverRate/volRatio/amplitude/tradeVol/tradeAmut/floatValue/totValue/isDelisted/todayIsTrade`
- **调用**：`StockRepo.getRealTimeStocksCX()` — 耗时打点「获取财新网数据」；`Injector.kt` 中该源的自动刷新调用当前被注释（备用数据源）
- **特点**：字段最全的单一快照源（含 upLimit/downLimit，无需自算涨跌停价）

## 2. 大智慧 — 人气榜 `getDZHHotRanking`

- **方法**：`GET https://imsearch.dzh.com.cn/stock/top`
- **固定参数**：`size=300&type=0&time=h`（按小时榜）
- **响应**：`DZHRankResponse(result: List<Map<String, Double>>)` — 弱类型 Map 列表
- **调用**：`StockRepo.fetchDZHPopularityRanking()` 原样返回列表，由 `Injector.kt`（人气榜合并任务，与 THS/DFCF/TGB/CLS 榜一起）解析并合并到 `PopularityRank` 表（dzhRank 字段）

## 3. 淘股吧 — 热门股榜 `getTGBRanking`

- **方法**：`GET https://www.tgb.cn/new/nrnt/getNoticeStock`
- **固定参数**：`type=D`
- **响应**：`TGBResponse(status, errorCode, dto: List<TGBStock>)`；`TGBStock` 关键字段：`fullCode/stockName/ranking`（排名）`/popularValue`（热度值）`/continuenum`（连板数）`/linkingBoard`（关联板块）`/gnList`（涨停概念）`/implied.subject`（题材）
- **调用**：`StockRepo.fetchTGBPopularityRanking()` → `PopularityRank` 表（tgbRank 字段）

## 4. 九阳公社 — 涨停复盘

### 4a. HTML 页面抓取 `getZTReplay2(@Url)`（实际使用）

- **方法**：`GET https://www.jiuyangongshe.com/action/{yyyy-MM-dd}`（`@Streaming`，完整 URL 传入）
- **响应**：`ResponseBody` — **非 JSON**，为页面文本；`StockRepo.fetchZTReplay(date)` 手工截取 `actionFieldList:` 与 `,totalCount:` 之间的内容，按 `action_field_id:` 分段，再逐段解析 `name:`（题材名）、`reason:`、`code:`（成员股）生成 `ZTReplayBean`（groupName2/reason2/expound2 字段来源）
- **调用**：`StockRepo.fetchZTReplay(date)`

### 4b. APP JSON 接口 `getZTReplay`（仅定义，未见调用）

- **方法**：`POST https://app.jiuyangongshe.com/jystock-app/api/v1/action/field`
- **请求头**（硬编码，可能过期）：
  - `Cookie: SESSION=YzE2MjVjYzAtYjI3Ni00MzdjLTk0ZDctZDZlM2MxMTI5NjMw; Hm_lvt_...; Hm_lpvt_...`
  - `token: 444e264e006a33d49eca5e6d5c3bc1c5`
- **请求体**：`FPRequest(date: "yyyy-MM-dd", pc: 0)`
- **响应**：`FPResponse`（db/beans.kt）→ `data: List<Data2(action_field_id, name, reason, list: List<ArticleWrap(article.action_info.expound/stock_id/time, code, name)>)>`
- **备注**：app 内「涨停复盘」按钮打开的 WebView 页面即 `https://www.jiuyangongshe.com/action`（HomeActivity → WebViewActivity），WebView 内会拦截页面数据回写 `ZTReplayBean`（groupName2 等）

## 5. 开盘啦（龙虎 VIP）— 题材直播 `getZhiBoStock`

- **方法**：`POST https://apphwhq.longhuvip.com/w1/api/index.php`（`@FormUrlEncoded` + `@FieldMap`）
- **表单参数**（StockRepo.getKPLLive 组装）：
  | 字段 | 值 |
  |------|-----|
  | `a` | `ZhiBoContent` |
  | `apiv` | `w42` |
  | `c` | `ConceptionPoint` |
  | `PhoneOSNew` | `1` |
  | `DeviceID` | `598d905194133b9e`（硬编码设备号） |
  | `VerSion` | `5.21.0.2` |
  | `index` | `0` |
- **响应**：`ZhiBoResponse(Status, Time, date, List: List<Item0>)`；`Item0` 关键字段：`Time`（秒级时间戳）、`Comment`（播报内容）、`PlateName/PlateCode/PlateZDF`（板块及涨幅）、`Stock/DisStock`（关联股票列表）、`BoomReason/Interpretation`（异动原因/解读）
- **调用**：`StockRepo.getKPLLive()` — 转 `UnusualActionHistory`（type=3，bk=板块名+代码）入库
