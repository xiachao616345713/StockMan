# 股票行情数据接口总览

本目录汇总了 StockMan 项目中**获取股票行情数据的全部网络接口**，覆盖两个部分：

- **Android 主应用**（`app/`）：接口定义集中在 `app/src/main/java/com/liaobusi/stockman/api/StockService.kt`（Retrofit），动态 URL 与调用逻辑在 `repo/StockRepo.kt`，响应模型在 `api/beans.kt` 与 `db/beans.kt`
- **stockman-monitor 服务端**（`stockman-monitor/server/`）：接口已按数据源拆分在 `network/` 目录（EastMoneyApi、SinaApi、SseApi、SohuApi、ThsApi）

> 文档基于 2026-11-11 的代码梳理生成，行号可能随代码演进变化，定位请以函数名为准。

---

## 目录索引

| 文件 | 数据源 | 接口数 |
|------|--------|--------|
| [eastmoney.md](eastmoney.md) | 东方财富（push2 / push2his / datacenter / xuangu / emcfgdata / emstockdiag） | 15 |
| [ths.md](ths.md) | 同花顺（data.10jqka / ozone / dataq / dq / eq） | 9 |
| [cls.md](cls.md) | 财联社（api3 / www / x-quote） | 3 |
| [sina.md](sina.md) | 新浪财经（vip.stock.finance.sina.com.cn） | 1 |
| [sohu.md](sohu.md) | 搜狐财经（q.stock.sohu.com） | 1 |
| [sse.md](sse.md) | 上海证券交易所（yunhq.sse.com.cn） | 1 |
| [baidu.md](baidu.md) | 百度股市通（finance.pae.baidu.com） | 2 |
| [others.md](others.md) | 财新、大智慧、淘股吧、九阳公社、开盘啦(longhuvip) | 6 |
| [monitor.md](monitor.md) | stockman-monitor 服务端 network/ 接口 | 7 |

---

## 接口分类总表

### 1. 实时行情快照（全市场/分市场）

| 接口 | 数据源 | 范围 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getRealTimeStocks` | 东财 clist | 全市场 A 股（分页 pn，pz=200） | StockService.kt | `StockRepo.getRealTimeStocksDFCF` |
| `getSinaHQNodeDataSimple` | 新浪 | 深市综指成份（node=zhishu_399106） | StockService.kt | `StockRepo.getRealTimeSinaSZ` |
| `getRealTimeStocks3` | 上交所 | 沪市 A 股（begin/end 区间） | StockService.kt | `StockRepo.getRealTimeStocksSH` |
| `getRealTimeStocksBD` | 百度 selfselect | 全市场（offset 分页，rn=200） | StockService.kt | `StockRepo.getRealTimeStocksBDInner` |
| `getRealTimeStocksBD2` | 百度 sapi | 全市场（6 分片×rn=1000，交易时段轮询） | StockService.kt | `StockRepo.getRealTimeStocksBD2Inner` |
| `getRealTimeStocksCX` | 财新 | 全市场涨幅榜（size=6000） | StockService.kt | `StockRepo.getRealTimeStocksCX` |

### 2. 实时 tick / 分时流（SSE）

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `requestStocks` | 东财 slist/sse | 全市场 tick 订阅（secid=47.800000），首帧全量+后续增量，原生 OkHttp | StockRepo.kt | `Injector.kt`（自动刷新任务） |
| `getRealTimeStockData` | 东财 trends2/sse | 单股当日分时流（@Streaming） | StockService.kt | `StockRepo.getRealTimeStockData` |

### 3. 历史 K 线

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getSHHistory` | 东财 push2his | 上证指数日 K（secid=1.000001，lmt=66，**仅定义未见调用**） | StockService.kt | — |
| `getBKHistory`(@Url) | 东财 push2his | 通用日 K：板块历史 / 个股补数 / 区间日 K / 指数最新一日 | StockService.kt | `getHistoryBks`、`fixData`、`fetchStockDayKlineRange`、`getRealTimeIndexByCode` |
| `getStockHistory` | 搜狐 hisHq | 个股历史日 K，支持多 code 批量（`cn_xxx,cn_yyy`） | StockService.kt | `StockRepo.getHistoryStocks` |

### 4. 板块（BK）

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getRealTimeTradeBK` | 东财 clist | 行业板块实时（fs=m:90+t:2+f:!50） | StockService.kt | `StockRepo.getRealTimeBKs` |
| `getRealTimeConceptBK` | 东财 clist | 概念板块实时（fs=m:90+t:3+f:!50） | StockService.kt | `StockRepo.getRealTimeBKs` |
| `getRealTimeBK` | 东财 clist | 行业+概念合并实时（**仅定义，未见调用**） | StockService.kt | — |
| `getBKStocks` | 东财 clist | 板块成份股列表（fs=b:BKxxxx，pz=10000） | StockService.kt | `StockRepo.getBKStocks`（每 12 小时刷新） |
| `getStockListForBK`(@Url) | 东财 | 板块成份股动态 URL 版（**仅定义，未见调用**） | StockService.kt | — |

### 5. 涨停 / 跌停 / 涨停复盘

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getLimitUpPool` | 同花顺 | 涨停池（分页，含连板/首封时间/开板次数/涨停原因） | StockService.kt | `StockRepo.getLimitUpPool` |
| `getLimitDownPool` | 同花顺 | 跌停池 | StockService.kt | `StockRepo.getLimitDownPool` |
| `getZTReplay2(date)` | 同花顺 block_top | 涨停复盘（按题材分组的涨停股） | StockService.kt | `StockRepo.fetchZTReplay2` |
| `getAllTabList` | 同花顺 ozone | 异动排行榜全部 tab（当日异动股清单） | StockService.kt | `StockRepo.fetchZTReplay2` |
| `getSpecificData` | 同花顺 dataq | 按 code 批量取指标（兜底补涨停原因） | StockService.kt | `StockRepo.fetchZTReplay2` |
| `getZTReplay2`(@Url) | 九阳公社 | 涨停复盘页面 HTML 抓取解析 | StockService.kt | `StockRepo.fetchZTReplay` |
| `getZTReplay`(POST) | 九阳公社 APP | 涨停复盘 JSON 接口（**仅定义，未见调用**，需 Cookie/token） | StockService.kt | — |
| CLS up_down_analysis | 财联社 x-quote | 涨停池（隐藏 WebView 拦截 JSON，非 Retrofit） | UnusualActionListFragment.kt | `StockRepo.saveClsUpPoolJson` |

### 6. 人气 / 热度榜

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getPopularityRanking` | 东财 xuangu | 东财人气榜 Top1000 | StockService.kt | `StockRepo.fetchPopularityRanking` |
| `getTHSHotRanking` | 同花顺 fuyao | 同花顺热股榜（type=hour） | StockService.kt | `StockRepo.fetchTHSPopularityRanking` |
| `getCLSHotRanking` | 财联社 api3 | 财联社人气榜（固定 sign） | StockService.kt | `StockRepo.fetchCLSPopularityRanking` |
| `getDZHHotRanking` | 大智慧 | 大智慧人气榜（size=300） | StockService.kt | `StockRepo.fetchDZHPopularityRanking` |
| `getTGBRanking` | 淘股吧 | 淘股吧热门股（type=D） | StockService.kt | `StockRepo.fetchTGBPopularityRanking` |
| `getExpectHot` | 东财 emcfgdata | 预期热点题材（POST） | StockService.kt | `StockRepo.getExpectHot` |
| `getHotTopicForStock` | 东财 emstockdiag | 个股关联热点题材（POST） | StockService.kt | `StockRepo.fetchDFCFHotTopic` |

### 7. 龙虎榜

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getDragonTigerRank`(@Url) | 东财 datacenter-web | 每日龙虎榜明细（RPT_DAILYBILLBOARD_DETAILSNEW） | StockService.kt | `StockRepo.fetchDragonTigerRank` |
| `getDragonTigerRank2`(@Url) | 同花顺 | 龙虎榜（含游资/机构净买、概念、标签） | StockService.kt | `StockRepo.fetchDragonTigerRank2` |

### 8. 直播 / 盘中异动

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getDPLive` | 财联社 www | 盘面直播电报（需用户配置 sign） | StockService.kt | `StockRepo.getCLSLive` |
| `getTHSYDLive`(@Url) | 同花顺 eq | 全天异动直播静态文件 apidata_{date}.txt | StockService.kt | `StockRepo.getTHSLive` |
| `getCallWarn` | 同花顺 eq | 集合竞价异动预警（大幅高开/竞价抢筹/大幅低开，POST） | StockService.kt | `StockRepo.getCallWarnType` |
| `getZhiBoStock` | 开盘啦(longhuvip) | 题材直播播报（FormUrlEncoded POST） | StockService.kt | `StockRepo.getKPLLive` |

### 9. 其他（F10 数据）

| 接口 | 数据源 | 说明 | 定义位置 | 调用入口 |
|------|--------|------|----------|----------|
| `getGDRS` | 东财 datacenter | 股东户数（RPT_F10_EH_HOLDERNUM，每 5 天刷新） | StockService.kt | `StockRepo.getHistoryGDRS` |

---

## 通用约定

### Retrofit 配置（app 端）

- `Injector.kt` 中 Retrofit `baseUrl` 为占位符 `https://api.github.com/`；所有接口要么在 `@GET/@POST` 注解中写**完整绝对 URL**，要么通过 `@Url` 传入完整 URL
- OkHttp 配置见 `api/client.kt`：连接/读取超时各 10s；信任所有证书（开发用）；对 `www.cls.cn`、`finance.pae.baidu.com`、`*.finance.sina.com.cn` 自动附加桌面 Chrome `User-Agent`（防反爬）
- Gson 开启 `setLenient()`，兼容新浪等非严格 JSON

### 东财 clist `fs` 市场过滤参数

| fs 值 | 含义 |
|-------|------|
| `m:1+t:2` | 上证 A 股主板 |
| `m:1+t:23` | 科创板 |
| `m:0+t:6` / `m:0+t:13` / `m:0+t:80` | 深证主板 / 中小板 / 创业板 |
| `m:0+t:81+s:2048`（或 `t:81+s:2048`） | 北证 A 股 |
| `m:0+t:7` / `m:1+t:3` | B 股 |
| `b:MK0021..MK0024` | ETF |
| `m:90+t:2` / `m:90+t:3` | 东财行业板块 / 概念板块 |
| `f:!50` | 排除项（配合板块使用） |
| `b:BKxxxx` | 指定板块成份股 |

app 端全市场常量：`FS = "m:1+t:2,m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:23,t:81+s:2048"`；深市：`SZ_BZ_FS = "m:0+t:6,m:0+t:13,m:0+t:80,m:0+t:81+s:2048"`（StockService.kt）

### 东财 `secid` 市场前缀

| 前缀 | 含义 |
|------|------|
| `0.XXXXXX` | 深市（000/001/002/003/300/301 及北交所 43/82/83/87/88/92） |
| `1.XXXXXX` | 沪市（60x/68x），`1.000001` = 上证指数 |
| `90.BKxxxx` | 东财板块 |
| `47.800000` | slist/sse 全市场订阅专用 secid |

映射函数：`StockRepo.eastMoneyStockSecId(code)`

### 东财 K 线参数与返回格式

- `klt=101` 日 K（102 周/103 月）、`fqt=1` 前复权、`lmt` 条数上限、`end=20500000` 到最新、`iscca=1&forcect=1`
- `fields2=f51..f64` 时 `data.klines` 每行逗号分隔：
  `[0]日期 [1]开盘 [2]收盘 [3]最高 [4]最低 [5]成交量(手) [6]成交额(元) [7]振幅% [8]涨跌幅% [9]涨跌额 [10]换手率%`
  （部分调用追加 `f350,f351,f352` 涨停价/跌停价/均价）
- `klines` 默认按日期**降序**返回，代码中普遍 `reversed()` 后使用

### 东财 f 字段映射（EMDiffBean / 实时行情）

| 字段 | 含义 | 字段 | 含义 |
|------|------|------|------|
| f2 | 最新价 | f17 | 开盘价 |
| f3 | 涨跌幅% | f18 | 昨收价 |
| f4 | 涨跌额 | f20 | 总市值 |
| f5 | 成交量 | f21 | 流通市值 |
| f6 | 成交额 | f26 | 上市日期 |
| f7 | 振幅% | f297 | 行情日期 |
| f8 | 换手率 | f350 | 涨停价 |
| f12 | 代码 | f351 | 跌停价 |
| f13 | 市场 | f352 | 均价（当日均价） |
| f14 | 名称 | f383 | 所属概念/板块 |
| f15 | 最高价 | f104/f105/f106 | 板块内涨/跌/平家数 |
| f16 | 最低价 | | |

**数值缩放注意**：clist 接口不带 `fltt=2` 时（app 端 `getRealTimeStocks`、SSE `slist/sse?fltt=1`、monitor `fltt=1`），价格类字段为**放大 100 倍的整数**，客户端统一 `/100` 还原；带 `fltt=2` 的接口（板块实时等）直接返回浮点值。

### 鉴权 / 特殊请求头

| 数据源 | 要求 |
|--------|------|
| 财联社 `www.cls.cn` | 需 `sign` 参数：用户从网页抓取后在设置页存入 SharedPreferences（`app`/`cls_sign`，`SettingActivity.clsSign()`）；`api3.cls.cn/v1/hot_stock` 使用代码内固定 sign |
| 百度 / 新浪 / 财联社 | 必须桌面浏览器 `User-Agent`（client.kt 网络拦截器自动附加） |
| 九阳公社 APP 接口 | 硬编码 `Cookie: SESSION=...` + `token: ...`（可能过期，故 app 端实际使用 HTML 抓取方案） |
| 同花顺（monitor 端） | `Referer: https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html` + 桌面 UA |
| 东财（monitor 端） | `Referer: https://quote.eastmoney.com/` + 桌面 UA |

### 数据源选择与刷新频率（app 端）

- 实时数据源可通过 SharedPreferences 配置切换（东财 DFCF / 新浪 / 上交所 / 百度 / 财新）
- 交易时段内：`Injector.kt` 的自动刷新任务循环调用所选数据源（百度 BD2 为 6 分片、每片 1s 轮询）
- 板块成份股：每 12 小时；股东户数：每 5 天；人气榜：开启自动刷新时约每 10 分钟；涨停复盘/龙虎榜：收盘（15:00）后拉取
