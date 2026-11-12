# stockman-monitor 服务端接口参考

monitor 的行情接口已按数据源拆分在 `stockman-monitor/server/src/main/kotlin/com/liaobusi/stockman/monitor/network/`，由 `MarketApiFactory` 统一构建 Retrofit 实例。响应 DTO 统一用 `JsonElement` 承接数值（兼容字符串/数字混发），转换在 `sync/strategy/` 各策略中完成。

---

## MarketApiFactory（实例工厂）

| 工厂方法 | baseUrl | OkHttpClient |
|----------|---------|--------------|
| `eastMoneyRealtimeApi(host)` | `https://{host}/`（默认 `43.push2.eastmoney.com`；fallback `52.push2.eastmoney.com`） | default（HTTP/1.1，15s/30s 超时） |
| `eastMoneyHistoryApi()` | `http://push2his.eastmoney.com/` | default |
| `sinaApi()` | `https://vip.stock.finance.sina.com.cn/` | default |
| `sseApi()` | `https://yunhq.sse.com.cn:32042/` | **trustAll**（放开证书校验） |
| `sohuApi()` | `https://q.stock.sohu.com/` | default |
| `thsApi()` | `https://data.10jqka.com.cn/` | default |

---

## 1. EastMoneyApi（`network/EastMoneyApi.kt`）

请求头（两个方法共用风格）：`Referer: https://quote.eastmoney.com/...` + 桌面 Chrome UA + `Accept-Encoding: identity`。

### 1a. 全市场实时快照 `getRealtimeStocks`

- **方法**：`GET api/qt/clist/get`
- **参数**：`pn`（从 1 起）、`pz`（策略中 =100）+ QueryMap（encoded，保留 `+`）：
  `po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=1&invt=2&fid=f3&fields=f2,f3,f7,f8,f12,f14,f15,f16,f17,f18,f21,f26,f297,f350,f351,f352,f383&fs=m:1+t:2,m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:23,t:81+s:2048`
- **响应**：`EastMoneyRealtimeResp → data.diff: List<EastMoneyRealtimeStockDto>`（f 字段映射见 [README](README.md)，`fltt=1` 价格 ×100，由策略层还原）
- **调用**：`RealtimeStockSync` — `EastMoneyRealtimeStockStrategy`，43 主机为主源、52 为 fallback（`fetchFirstSuccessfulSnapshot` + 指数退避重试）；首页 total 推算总页数，后续页按 `EAST_MONEY_PARALLEL_PAGES` 并行

### 1b. 日 K 线 `getKLine`

- **方法**：`GET api/qt/stock/kline/get`（host：`push2his.eastmoney.com`，http）
- **参数**（`EastMoneyHistoryStockStrategy` 组装 QueryMap）：
  `secid={market}.{code}&klt=101&fqt=1&lmt={HISTORY_KLINE_SIZE+1}&end=20500000&fields1=f1..f8&fields2=f51..f64`
- **响应**：`EastMoneyKLineResp`（klines 行格式同 app 端，见 [eastmoney.md](eastmoney.md)）
- **调用**：`HistoryStockSync` — 作为搜狐历史接口的**兜底策略**

## 2. SinaApi（`network/SinaApi.kt`）

- **方法**：`GET quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple`
- **参数**：`page`（从 1 起）、`num=6000` + QueryMap `sort=symbol&asc=1&node=hs_a&_s_r_a=page`（**hs_a = 沪深全市场**）
- **响应**：`List<SinaRealtimeStockDto>`（code/symbol/name/trade/settlement/open/high/low/volume/amount/changepercent）
- **调用**：`RealtimeStockSync` — `SinaRealtimeStockStrategy` 为 monitor **默认实时快照源**（`RealtimeRefreshSource.SINA`）；空页即停止翻页；快照数量低于 `FULL_MARKET_STOCK_MIN_COUNT` 视为不完整并重试

## 3. SseApi（`network/SseApi.kt`）

- **方法**：`GET v1/sh1/list/exchange/equity`
- **参数**：`begin/end`（每页 2500 区间分页）、`_`（时间戳）+ QueryMap `select=code,name,open,high,low,last,prev_close,chg_rate,volume,amount,tradephase,change,amp_rate,cpxxsubtype,cpxxprodusta,&order=`
- **响应**：`SseEquityResp(date, total, list: List<JsonArray>)`
- **调用**：`SseRealtimeStockStrategy` — 注释明确「只有沪 A 数据，保留为后续局部数据源，**不参与全量实时快照策略链**」；trustAll client

## 4. SohuApi（`network/SohuApi.kt`）

- **方法**：`GET hisHq`（https）
- **请求头**：`Referer: https://quote.eastmoney.com/` + 桌面 UA
- **参数**：`code`（`cn_` 前缀）、`start/end`（yyyyMMdd；策略中 start=回溯 lookbackDays，end=最近收盘日）
- **响应**：`List<SohuHistoryResp(status, code, hq: List<List<String>>)`（行格式见 [sohu.md](sohu.md)，文件内附完整示例响应）
- **调用**：`HistoryStockSync` — `SohuHistoryStockStrategy` 为历史日 K **首选策略**

## 5. ThsApi（`network/ThsApi.kt`）

请求头：`Referer: https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html` + 桌面 UA。

### 5a. 涨停池 `getLimitUpPool`

- **方法**：`GET dataapi/limit_up/limit_up_pool?field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003&filter=HS,GEM2STAR&order_field=330324&order_type=0`
- **参数**：`date`（yyyyMMdd）、`page`、`limit=200`
- **响应**：`ThsLimitUpPoolResponse → data.info: List<ThsLimitUpPoolStock>`（code/name/first_limit_up_time/last_limit_up_time/high_days/limit_up_type/reason_type/open_num/turnover_rate/latest/change_rate）+ `data.page`
- **调用**：`MarketEngine.kt:225`（涨停池刷新，分页循环）

### 5b. 涨停复盘 `getZtReplay`

- **方法**：`GET dataapi/limit_up/block_top?filter=HS,GEM2STAR`
- **参数**：`date`（yyyyMMdd）
- **响应**：`ThsZtReplayResponse → data: List<ThsZtReplayBlock(name, block_name, reason_type, reason_info, stock_list: List<ThsZtReplayStock(code, name, first_limit_up_time[Long 秒])>)>`
- **调用**：`MarketEngine.kt:255`

---

## monitor 与 app 端接口对应关系

| 能力 | app 端 | monitor 端 |
|------|--------|-----------|
| 全市场实时快照 | 东财 clist / 新浪 zhishu_399106 / 上交所 / 百度 / 财新（可配置） | 新浪 hs_a（默认）→ 东财 43/52（fallback） |
| 历史日 K | 搜狐 hisHq（批量 2 只/次）+ 东财 push2his | 搜狐（首选）+ 东财（兜底） |
| 涨停池 | THS limit_up_pool + CLS WebView 拦截 | THS limit_up_pool |
| 涨停复盘 | THS block_top + ozone all_tab + dataq specific_data + 九阳公社 | THS block_top |
| tick 流 | 东财 slist/sse、trends2/sse | 无（轮询快照） |
