# web-stock 后端接口文档

> 版本：v1.4.0 · Base URL：`http://localhost:8787`（端口默认 8787，可在设置页/`PUT /api/config` 修改后**重启生效**；环境变量 `PORT` 优先于配置库）
> 上游接口出处见 [design.md §4 映射表](design.md)；本文档描述**本项目后端自身**暴露的 REST 接口。

## 通用约定

- 查询接口仅支持 `GET`（例外：`DELETE /api/cache`、`POST /api/agent/chat`、`PUT /api/config`），无需鉴权（含配置接口，见 design.md §6 限制 16）。
- **成功响应**（HTTP 200）：

```json
{
  "data": { },
  "meta": {
    "source": "eastmoney:20.push2.eastmoney.com",
    "fetchedAt": "2026-11-11T08:04:11.327Z",
    "fromCache": false
  }
}
```

- **失败响应**（HTTP 400/404/405/413/502/503）：

```json
{ "error": { "status": 400, "message": "参数 code 必须为 6 位数字股票代码" } }
```

| 状态码 | 含义 |
|--------|------|
| 400 | 参数/配置校验失败（含 `PUT /api/config` 的非法值与请求体非合法 JSON） |
| 404 | 资源不存在（如快照中无该股票）/ 未知接口 |
| 405 | 请求方法不支持 |
| 413 | 请求体过大（`/api/agent/chat`、`/api/config` 上限 64KB） |
| 502 | 上游数据获取失败（含兜底源也失败）/ LLM 服务调用失败 |
| 503 | LLM 未配置（`/api/agent/chat`，message 附配置指引） |

- 数值字段上游缺失（停牌等）时统一为 `null`；成交量单位为**手**，金额/市值单位为**元**。
- 缓存策略见 [design.md §5](design.md)；v1.4.0 起各接口 TTL 为 `cache` 配置组默认值，可经 §20 在线调整。

---

## 1. 健康检查 `GET /api/health`

无参数。`isTradingTime` 为宽松判断（上海时区周一至五，时段窗口取配置 `server.tradingStart/tradingEnd`，默认 09:15–15:05，不含节假日）；`llmConfigured`（v1.3.0）表示 AI 助手的 LLM 是否已配置（随设置页「AI 模型」组变化，见 §18/§20）。

```json
{ "data": { "ok": true, "version": "1.4.0", "isTradingTime": false, "serverTime": "2026-11-11T07:57:52.300Z", "llmConfigured": true } }
```

## 2. 三大指数 `GET /api/indices`

上证指数 / 深证成指 / 创业板指 最新一日行情（东财 kline lmt=1，盘中为当日实时累计值）。

```json
{
  "data": [
    {
      "secid": "1.000001", "code": "000001", "name": "上证指数",
      "preClose": 3663.72, "date": "2026-11-11",
      "open": 3655.66, "close": 3680.64, "high": 3689.65, "low": 3650.31,
      "volume": 433120083, "amount": 736154792000.5,
      "amplitude": 1.07, "pct": 0.46, "change": 16.92, "turnover": 0.89
    }
  ]
}
```

## 3. 全市场涨跌统计 `GET /api/stats`

基于全市场快照（约 5900 只，含北交所）。`limitUp/limitDown` 按 最新价 ≥ 涨停价 / ≤ 跌停价 判定。

```json
{ "data": { "total": 5928, "up": 3538, "down": 1827, "flat": 212, "suspended": 351, "limitUp": 85, "limitDown": 3 } }
```

## 4. 涨跌幅排行 `GET /api/ranking`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `order` | string | `desc` | `desc` 涨幅榜 / `asc` 跌幅榜 |
| `limit` | int | 20 | 1–200 |

返回按涨跌幅排序的股票数组（元素结构同 §5 的 `data`，不含 `board`/`limitPct`）。停牌（`pct=null`）不参与排行。

## 5. 单股实时行情 `GET /api/quote`

| 参数 | 类型 | 说明 |
|------|------|------|
| `code` | string | 6 位股票代码，必填 |

```json
{
  "data": {
    "code": "600000", "market": 1, "name": "浦发银行",
    "price": 10.17, "pct": -0.29, "change": -0.03,
    "volume": 485046, "amount": 496375448,
    "amplitude": 1.57, "turnover": 0.15,
    "high": 10.31, "low": 10.15, "open": 10.22, "preClose": 10.2,
    "totalMv": 338720375511, "circMv": 338720375511,
    "peTtm": 5.62, "pe": 5.58, "pb": 0.48, "volumeRatio": 0.9,
    "pct60": 3.2, "pctYtd": 8.4,
    "listDate": 19991110, "quoteDate": 20261111,
    "ztPrice": 11.22, "dtPrice": 9.18, "avgPrice": 10.23,
    "board": "主板", "limitPct": 10
  }
}
```

字段说明：`volume` 手 · `amount`/`totalMv`/`circMv` 元 · `amplitude`/`pct`/`turnover` % · `listDate`/`quoteDate` yyyyMMdd · `board` ∈ 主板/创业板/科创板/北交所/ST · `limitPct` 涨跌停幅度%（主板10/创业·科创20/北交30/ST5）。
v1.2.0 新增：`peTtm`/`pe` 市盈率（TTM/动态）· `pb` 市净率 · `volumeRatio` 量比 · `pct60` 60日涨跌幅% · `pctYtd` 年初至今涨跌幅%（东财快照 f115/f9/f23/f10/f24/f25）。
新浪兜底源时 `ztPrice`/`dtPrice`/`avgPrice`/`totalMv`/`circMv`/`turnover`/`amplitude`/`peTtm`/`pe`/`pb`/`volumeRatio`/`pct60`/`pctYtd` 为 `null`。

## 6. 股票搜索 `GET /api/search`

| 参数 | 类型 | 说明 |
|------|------|------|
| `kw` | string | 关键词（≤20 字符），必填。纯数字按代码前缀匹配，否则按名称子串匹配 |

返回 ≤20 条（元素结构同 §5 的 `data`，不含 `board`/`limitPct`），排序：代码精确 > 代码前缀 > 名称前缀 > 名称包含，同级按涨跌幅降序。

```bash
curl "http://localhost:8787/api/search?kw=浦发"
curl "http://localhost:8787/api/search?kw=600000"
```

## 7. 日 K 线 `GET /api/kline`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `code` | string | — | 6 位代码，必填 |
| `days` | int | 120 | 30–1200（超出自动收敛到边界） |

东财前复权日 K（`fqt=1`），**按日期升序**；东财失败自动切换搜狐（`source` 字段可区分；搜狐行 `amplitude` 由相邻收盘推算，盘中无当日数据）。

```json
{
  "data": {
    "code": "600000", "name": "浦发银行", "preClose": 10.2, "source": "eastmoney:push2his",
    "klines": [
      { "date": "2026-09-23", "open": 9.9, "close": 9.94, "high": 9.99, "low": 9.86,
        "volume": 512894, "amount": 509318944, "amplitude": 1.31, "pct": 0.2,
        "change": 0.02, "turnover": 0.16 }
    ]
  }
}
```

`volume` 手 · `amount` 元 · 其余同 §5。

## 8. 板块实时排行 `GET /api/sectors`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `type` | string | `industry` | `industry` 行业板块 / `concept` 概念板块 |

```json
{
  "data": [
    { "code": "BK1295", "name": "其他数字媒体", "price": 1234.56, "pct": 7.27,
      "amplitude": 8.1, "turnover": 5.2, "high": 1250.0, "low": 1160.0,
      "open": 1170.0, "preClose": 1150.9, "totalMv": 1.2e11, "circMv": 1.1e11,
      "upCount": 2, "downCount": 0, "flatCount": 0, "quoteDate": 20261111 }
  ]
}
```

默认按涨跌幅降序（上游 `fid=f3&po=1`）。`upCount/downCount/flatCount` 为板块内涨/跌/平家数（f104/f105/f106）。

## 9. 板块成份股 `GET /api/sectors/stocks`

| 参数 | 类型 | 说明 |
|------|------|------|
| `bk` | string | 板块代码（`BK` + 4~6 位数字，大小写不敏感），必填 |

返回该板块全部成份股实时行情（元素结构同 §5 的 `data`，不含 `board`/`limitPct`），按涨跌幅降序。

```bash
curl "http://localhost:8787/api/sectors/stocks?bk=BK0482"
```

## 10. 涨停池 `GET /api/limitup/pool`

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `date` | string | 今天（上海时区） | yyyyMMdd，不可晚于今天 |

```json
{
  "data": {
    "source": "ths:limit_up_pool", "date": "20261110",
    "summary": { "limitUpCount": 93, "limitDownCount": null, "tradeStatus": "已收盘", "page": { "limit": 200, "total": 1, "count": 93, "page": 1 } },
    "list": [
      { "code": "300426", "name": "华智数媒", "price": 12.34, "pct": 19.98,
        "highDays": "首板", "limitUpType": "换手板",
        "reasonType": "AI漫剧+互动影游+短剧出海+浙江国资",
        "openNum": null, "turnover": 27.56, "orderVolume": 4567400,
        "circMv": 4588000000, "firstLimitUpTime": "14:56:27", "lastLimitUpTime": "14:56:27",
        "isAgainLimit": 0, "limitUpSucRate": 0.4 }
    ]
  }
}
```

字段说明：`highDays` 几天几板（如 `2天2板`） · `limitUpType` 换手板/一字板等 · `openNum` 开板次数（null=未开板） · `orderVolume` 封单量（股） · `circMv` 流通市值（元） · `firstLimitUpTime`/`lastLimitUpTime` 首/末次封板时间（上海时区 HH:mm:ss） · `limitUpSucRate` 封板率。
非交易日查询返回空 `list`（`summary.tradeStatus` 可判断交易状态）。

## 11. 涨停复盘 `GET /api/limitup/replay`

参数同 §10。按题材分组：

```json
{
  "data": {
    "source": "ths:block_top", "date": "20261110",
    "groups": [
      { "code": "885xxx", "name": "机器人概念", "limitUpNum": 34, "days": null,
        "reasonType": null, "reasonInfo": null,
        "stocks": [
          { "code": "002931", "name": "锋龙股份", "pct": 10.01, "concept": null,
            "continueNum": 5, "highDays": "5天5板", "firstLimitUpTime": "09:25:03",
            "reasonType": "机器人概念", "reasonInfo": "…" }
        ] }
    ]
  }
}
```

## 12. 清空缓存 `DELETE /api/cache`（调试用）

清空后端全部 TTL 缓存，下一次请求将强制回源。响应：`{ "ok": true }`。

```bash
curl -X DELETE http://localhost:8787/api/cache
```

## 13. 条件选股 `GET /api/screen`（v1.1.0，v1.2.0 扩充指标）

选股器模块：基于**全市场快照**（与 §3–§6 共用同一份缓存，不新增上游请求）做指标区间过滤 + 排序。

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `pctMin` / `pctMax` | number | 空 | 涨跌幅 % 区间（闭区间） |
| `turnoverMin` / `turnoverMax` | number | 空 | 换手率 % 区间 |
| `amountMin` / `amountMax` | number | 空 | 成交额区间，单位**亿**（快照字段为元，服务端换算） |
| `mvMin` / `mvMax` | number | 空 | 总市值区间，单位**亿** |
| `circMvMin` / `circMvMax` | number | 空 | 流通市值区间，单位**亿**（v1.2.0） |
| `peMin` / `peMax` | number | 空 | 市盈率 TTM 区间（v1.2.0） |
| `pbMin` / `pbMax` | number | 空 | 市净率区间（v1.2.0） |
| `volumeRatioMin` / `volumeRatioMax` | number | 空 | 量比区间（v1.2.0） |
| `pct60Min` / `pct60Max` | number | 空 | 60日涨跌幅 % 区间（v1.2.0） |
| `pctYtdMin` / `pctYtdMax` | number | 空 | 年初至今涨跌幅 % 区间（v1.2.0） |
| `boards` | string | 空 | 逗号分隔板块过滤：`主板,创业板,科创板,北交所`；含其他值 → 400 |
| `excludeSt` | string | `1` | 默认排除名称含 ST 的股票；`0` 表示不排除 |
| `sort` | string | `pct` | 排序字段：`pct`/`turnover`/`amount`/`amplitude`/`totalMv`/`circMv`/`peTtm`/`pb`/`volumeRatio`/`pct60`/`pctYtd`（v1.2.0 新增后 6 项） |
| `dir` | string | `desc` | `desc` 降序 / `asc` 升序 |
| `limit` | int | 100 | 返回条数上限，1–300 |

**过滤规则**：
- 停牌（`price`/`pct` 为 null）一律不入选；
- 某阈值已设置但股票该字段为 null（如新浪兜底源缺换手率/市值/市盈率等）→ 该股票不入选（不做「未知即通过」的静默放行）；
- 排序字段为 null 的股票排在末尾。

```json
{
  "data": {
    "total": 119,
    "list": [
      { "code": "688135", "name": "利扬芯片", "board": "科创板",
        "price": 35.02, "pct": 20.01, "turnover": null, "amount": 989000000, "totalMv": null }
    ]
  },
  "meta": { "source": "sina:hs_a", "fetchedAt": "…", "fromCache": true, "sort": "pct", "dir": "desc" }
}
```

`total` 为命中总数（可能大于 `list.length`）。`meta.source` 可判断快照是否处于兜底源（兜底源下换手率/振幅/市值类阈值会筛空，前端选股器据此显示「兜底源」提示）。

```bash
curl "http://localhost:8787/api/screen?pctMin=9&sort=pct&dir=desc&limit=20"
curl "http://localhost:8787/api/screen?pctMin=3&pctMax=6&turnoverMin=5&turnoverMax=15&boards=主板,创业板&excludeSt=1&sort=turnover"
curl "http://localhost:8787/api/screen?peMin=0&peMax=15&pbMin=0&pbMax=1.5&mvMin=200&sort=peTtm&dir=asc"
```

## 14. 龙虎榜 `GET /api/dragon-tiger`（v1.2.0）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `date` | string | 今天（上海时区） | yyyyMMdd，不可晚于今天 |

东财 datacenter 明细（主源：上榜原因/净买额/买卖额/次日涨幅/换手/流通市值）+ 同花顺（游资/机构净买、营业部标签、概念）按代码合并。榜单每日收盘后约 17:00 起发布，发布前或非交易日返回空 `list`。

```json
{
  "data": {
    "source": "eastmoney:datacenter-web+ths:transaction",
    "date": "20261111",
    "platforms": [ { "ok": true, "name": "eastmoney" }, { "ok": true, "name": "ths" } ],
    "list": [
      { "code": "002384", "name": "东山精密", "close": 92.06, "pct": 10.0,
        "explanation": "日涨幅偏离值达到7%的前5只证券", "explain": null,
        "netAmount": 722000000, "buyAmount": 2378000000, "sellAmount": 1657000000,
        "dealAmount": 5120000000, "totalAmount": 8630000000, "netRatio": 14.1, "dealRatio": 59.3,
        "turnover": 10.3151, "freeMv": 127620000000,
        "d1Pct": null, "d2Pct": null, "d5Pct": null, "d10Pct": null,
        "hotMoneyNet": 102000000, "orgNet": 470000000, "limitReason": null,
        "tags": ["量化基金买", "同花顺平滑指数"], "concepts": ["共封装光学(CPO)", "PCB概念"] }
    ]
  }
}
```

字段说明：金额单位**元**、比率 %；`explanation` 上榜原因（东财同一股票同日多榜单行按代码合并：主行取榜单成交额更大者，原因去重后以「；」连接）；`d1Pct`/`d2Pct`/`d5Pct`/`d10Pct` 为上榜后 1/2/5/10 日涨跌幅（仅历史榜单有值，当日榜为 null）；`hotMoneyNet`/`orgNet`/`limitReason`/`tags`/`concepts` 来自同花顺，该平台不可用时分别为 `null`/`null`/`null`/`[]`/`[]`。
**降级**：`platforms` 标注各源 `ok`/`error`；单源失败降级为另一源字段（东财失败时同花顺行缺 收盘价/买卖额/次日涨幅 等东财独有字段）；两源全失败 → 502。默认按净买额降序。

## 15. 热榜（多平台人气聚合） `GET /api/hot-rank`（v1.2.0）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `limit` | int | 100 | 返回条数上限，1–300 |

四平台合并：东财 xuangu 人气榜 / 同花顺 fuyao 热股榜 / 财联社热股榜 / 大智慧人气榜，按代码聚合成行（淘股吧当前 DNS 不可达未接入，见 design.md §6）。

```json
{
  "data": {
    "platforms": [
      { "ok": true, "name": "dfcf", "count": 300 }, { "ok": true, "name": "ths", "count": 100 },
      { "ok": true, "name": "cls", "count": 29 }, { "ok": true, "name": "dzh", "count": 100 }
    ],
    "total": 307,
    "list": [
      { "code": "600715", "name": "文投控股", "price": 5.2, "pct": 10.0, "volumeRatio": 2.1,
        "dfcfRank": 1, "thsRank": 3, "clsRank": null, "dzhRank": 12,
        "thsRankChange": -1, "clsRankChange": null, "thsHotValue": 98213, "dzhHeat": 8741,
        "popularityTag": "连续升温", "concepts": ["足球概念", "IP经济"], "analyseTitle": "…" }
    ]
  }
}
```

字段说明：各平台名次为 `null` 表示该平台未收录此股；`thsRankChange`/`clsRankChange` 为较上期名次变化（负=上升）；`popularityTag`/`analyseTitle`/`concepts` 来自同花顺；`name`/`price`/`pct`/`volumeRatio` 取 dfcf→ths→cls 首个非 null 值。默认按 `dfcfRank` 升序、其次 `thsRank` 升序（缺名次排末尾）。各平台独立容错（`platforms` 标注 `ok`/`error`/`count`），全部失败才 502。

## 16. 连板天梯 `GET /api/ladder`（v1.2.0）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `date` | string | 今天 | yyyyMMdd，不可晚于今天 |

当日涨停池按连板数分层（复用涨停池缓存，零新增上游请求）。

```json
{
  "data": {
    "source": "ths:limit_up_pool", "date": "20261111", "tradeStatus": "已收盘",
    "totalCount": 84, "maxBoards": 5,
    "tiers": [
      { "boards": 5, "label": "5连板", "count": 1,
        "stocks": [ { "code": "…", "name": "…", "highDays": "5天5板", "ladderDays": 5,
                      "firstLimitUpTime": "09:32:18", "…": "其余字段同 §10 涨停池 list 元素" } ] },
      { "boards": 1, "label": "首板", "count": 60, "stocks": ["…"] }
    ]
  }
}
```

层序按板数降序（最高板在前）；层内按 `ladderDays`（几天几板中的天数）升序（N 板 N 天最强）、再按首封时间升序。`stocks` 元素为 §10 涨停池字段附加 `ladderDays`（由 `highDays` 解码，解码失败按首板）。

## 17. 涨停关联分析 `GET /api/limitup/related`（v1.2.0）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `code` | string | — | 6 位代码，必填，且**须在当日涨停池**，否则 404 |
| `date` | string | 今天 | yyyyMMdd，不可晚于今天 |
| `days` | int | 10 | 共同涨停回看窗口（交易日），3–20 |

两类关联：**题材关联** = 当日涨停复盘（block_top）中包含该股的分组（同组即同题材）；**共同涨停** = 回看近 `days` 个交易日的历史涨停池（跳过周末、批 5 并发、取满为止、单日失败容忍），统计与目标股票同日涨停的股票。

```json
{
  "data": {
    "source": "ths:limit_up_pool+block_top", "date": "20261111", "windowDays": 10,
    "target": { "code": "603228", "name": "景旺电子", "highDays": "2天2板", "…": "涨停池字段" },
    "targetLimitUpDays": ["20261111", "20261110"],
    "themes": [
      { "code": "885xxx", "name": "PCB概念", "days": 6, "limitUpNum": 12,
        "stocks": ["同 §11 复盘分组 stocks 元素"] }
    ],
    "coLimit": [
      { "code": "002708", "name": "光洋股份", "count": 4,
        "dates": ["20261110", "20261109", "20261029", "20261028"],
        "highDays": "3天3板", "reasonType": "汽车零部件", "inTodayPool": true }
    ],
    "historyDates": ["20261110", "20261109", "…共 days 个交易日"]
  }
}
```

字段说明：`themes` 为 `null` 表示涨停复盘获取失败（题材关联缺失，共同涨停不受影响）；复盘仅 top 20 题材组，未入组股票 `themes` 为 `[]`；`targetLimitUpDays` 含当前查询日；`coLimit.dates` 降序，整体按 `count` 降序、`inTodayPool` 降序排列；`inTodayPool` 表示是否也在查询日涨停池。首次查询需回看历史池（≈`days` 次池请求，均走缓存键 `limitup:pool:{date}`）。

## 18. AI 选股助手对话 `POST /api/agent/chat`（v1.3.0）

LLM function-calling Agent：模型根据自然语言请求调用本服务既有数据接口（复用 §1–§17 的路由与缓存，见 design.md D14），最终返回中文回答 + 工具调用轨迹 + 可点击股票列表。

**LLM 配置**（v1.4.0 起存配置库，经 §19/§20 读写；token 只存服务端、GET 不回显）：推荐在设置页「AI 模型」组填写 `modelUrl`（base 或完整 chat/completions 地址均可）/ `accessToken` / `model`，保存即生效。环境变量（`LLM_MODEL_URL`/`LLM_ACCESS_TOKEN`/`LLM_MODEL`）与 `server/llm.config.json` 仅在**首次运行（配置库无 llm 组）时作为种子**写入数据库，此后数据库为唯一真相源（见 design.md D16）。

**请求体**（≤64KB）：

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `messages` | array | 条数 ≤ `agent.maxMessages`（默认 30），最后一条须为 user | 对话历史，元素 `{role: "user"\|"assistant", content: string}`，单条 ≤ `agent.maxContent` 字符（默认 4000）；多轮对话由前端携带历史（服务端无会话状态）；上限可在设置页调整（§20） |

```bash
curl -X POST http://localhost:8787/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"帮我筛选涨幅超过5%、换手率大于10%的创业板股票"}]}'
```

**成功响应**：

```json
{
  "data": {
    "reply": "已按「创业板、涨幅≥5%、换手率≥10%」筛选，共命中 12 只：\n1. 300xxx xxx …\n数据仅供参考，不构成投资建议。",
    "toolTrace": [
      { "tool": "screen_stocks", "label": "条件选股",
        "args": { "pctMin": 5, "turnoverMin": 10, "boards": ["创业板"], "sort": "pct", "dir": "desc", "limit": 10 },
        "status": "ok", "summary": "命中 12 只" }
    ],
    "stocks": [ { "code": "300xxx", "name": "xxx", "price": 12.34, "pct": 7.89 } ],
    "model": "model-name", "llmRounds": 2, "truncated": false
  },
  "meta": { "source": "llm:model-name", "fetchedAt": "…", "fromCache": false }
}
```

字段说明：
- `toolTrace`：Agent 每次工具调用的轨迹（`status: "ok"|"error"`，`summary` 为一句话摘要），前端渲染为气泡内标签。
- `stocks`：从工具结果收集的 A 股（≤60 只，板块 BK 代码与指数自动排除），前端渲染为可点击 chips 跳个股页。
- `llmRounds`：本次对话的 LLM 交互轮数；`truncated: true` 表示达到最大轮数（`agent.maxRounds`，默认 6）仍未收敛，`reply` 为中止提示。
- 可用工具（13 个）：
  - **数据工具（10 个，复用 §1–§17 路由与缓存）**：`screen_stocks`（条件选股，核心）、`search_stock`、`get_quote`、`get_indices`、`get_market_stats`、`get_ranking`、`get_hot_rank`、`get_limitup_pool`、`get_sectors`、`get_dragon_tiger`（`lib/agent.js#TOOL_ROUTES`）。
  - **历史工具（3 个，读本地归档做跨日查询）**：`history_overview`（各类归档覆盖天数与日期范围，供模型判断数据是否足够）、`history_screen`（最近 N 天跨日筛选：有涨停/热榜名次≤X/上过龙虎榜 组合条件）、`history_co_limitup`（与目标股票共同涨停关联度排行，缺失归档自动按日回补）（`lib/agent.js#HISTORY_TOOLS`）。

**历史归档（v1.3.0，支撑历史工具）**：

- 涨停池/热榜/龙虎榜/连板天梯四类数据按日归档至 `server/data/{limitup,hotrank,dragontiger,ladder}/{yyyyMMdd}.json`（gitignored，运行期生成）。
- 写入双通道：① 对应路由（§10/§14/§15/§16）请求成功后写穿归档（节流窗口 `collection.rewriteIntervalMinutes`，默认 10min）；② 后台采集器按 `collection` 组排程（首跑延时默认 5s、周期默认 30min，龙虎榜仅上海时间 `collection.dragonTigerAfterHour` 默认 15 点后采集；总开关 `enabled` 与四类分项开关 `types` 均可在设置页关停，v1.4.0）。
- 涨停池/龙虎榜可按 `date` 参数回补历史（`history_co_limitup` 自动回补，也可手动 `GET /api/limitup/pool?date=20261110` 触发写穿）；**热榜上游无日期参数，不可回补，归档自启用日起向前积累**——跨日热榜查询的覆盖范围以 `history_overview` 返回为准。
- 归档文件损坏时按缺失处理（不影响服务），详见 design.md D15。

**错误响应**：400（messages 校验失败）/ 413（请求体超限）/ 502（LLM 服务调用失败，message 含 HTTP 状态与响应摘录）/ 503（LLM 未配置，message 附配置指引）。

## 19. 读取系统配置 `GET /api/config`（v1.4.0）

无参数。返回全部 6 个配置组（`collection` / `llm` / `agent` / `cache` / `server` / `http`），`meta.store` 标注存储后端与文件路径。**密钥掩码**：`llm.accessToken` 原文永不出现在响应中，以派生布尔 `llm.accessTokenSet` 代替。

```json
{
  "data": {
    "collection": {
      "enabled": true, "intervalMinutes": 30, "initialDelaySeconds": 5,
      "dragonTigerAfterHour": 15, "rewriteIntervalMinutes": 10,
      "types": { "limitup": true, "ladder": true, "hotrank": true, "dragontiger": true }
    },
    "llm": {
      "enabled": true, "modelUrl": "https://api.example.com/v1", "model": "model-name",
      "accessTokenSet": false, "timeoutMs": 90000, "temperature": 0.3, "maxTokens": 2048
    },
    "agent": { "maxRounds": 6, "maxMessages": 30, "maxContent": 4000 },
    "cache": {
      "snapshot": { "trading": 30, "closed": 600 },
      "indices": { "trading": 30, "closed": 600 },
      "kline": { "trading": 60, "closed": 1800 },
      "sectors": { "trading": 60, "closed": 900 },
      "bkstocks": { "trading": 60, "closed": 900 },
      "limitup": { "trading": 120, "closed": 1800 },
      "ladder": { "trading": 120, "closed": 1800 },
      "related": { "trading": 300, "closed": 1800 },
      "dragontiger": { "trading": 300, "closed": 1800 },
      "hotrank": { "trading": 300, "closed": 600 }
    },
    "server": { "port": 8787, "tradingStart": "09:15", "tradingEnd": "15:05" },
    "http": { "timeoutMs": 10000, "retries": 1, "retryBackoffMs": 300 }
  },
  "meta": {
    "source": "config", "fetchedAt": "2026-11-12T08:00:00.000Z", "fromCache": false,
    "store": { "backend": "sqlite", "path": "/…/server/data/config.db" }
  }
}
```

字段说明：`cache.*` 单位为**秒**（trading 交易时段 / closed 收盘后，各缓存键语义见 design.md §5）；`llm.timeoutMs`/`http.timeoutMs`/`http.retryBackoffMs` 单位为毫秒；`meta.store.backend` ∈ `sqlite`（node:sqlite，Node ≥ 22.5）/ `json`（兜底 `server/data/config.json`，功能一致）。

```bash
curl http://localhost:8787/api/config
```

## 20. 更新系统配置 `PUT /api/config`（v1.4.0）

请求体为**部分配置补丁**（可只含一个组、组内只含要改的字段；空对象 `{}` 为无操作）：按组深合并 → 逐字段校验 → 仅变更组落库 → 内存态热替换。响应 `data` 为更新后的**完整掩码配置**（结构同 §19 的 `data`）。

**密钥三态语义**（`llm.accessToken`）：字段**缺省 = 保持**已存值；**空串 `""` = 清除**；**非空字符串 = 覆盖**。派生字段 `llm.accessTokenSet` 只读，写入时忽略。

**校验规则**（违反 → 400，message 为中文、指明字段路径与允许范围）：

| 字段 | 约束 |
|------|------|
| `collection.enabled` / `types.*` | 布尔值 |
| `collection.intervalMinutes` / `rewriteIntervalMinutes` | 整数 1–1440 |
| `collection.initialDelaySeconds` | 整数 0–600 |
| `collection.dragonTigerAfterHour` | 整数 0–23 |
| `llm.modelUrl` | 空串或合法 http(s) 地址 |
| `llm.timeoutMs` | 整数 5000–600000 |
| `llm.temperature` | 数字 0–2 |
| `llm.maxTokens` | 整数 256–32768 |
| `agent.maxRounds` | 整数 1–20 |
| `agent.maxMessages` | 整数 1–200 |
| `agent.maxContent` | 整数 100–100000 |
| `cache.{键}.trading` / `.closed` | 整数 5–7200（秒）；键限 §19 列出的 10 个 |
| `server.port` | 整数 1–65535 |
| `server.tradingStart` / `tradingEnd` | `HH:MM`（24 小时制）且 start 必须早于 end |
| `http.timeoutMs` | 整数 1000–120000 |
| `http.retries` | 整数 0–5 |
| `http.retryBackoffMs` | 整数 0–10000 |
| 未知配置组 / 组内未知字段 / 未知缓存键 / 未知采集类型 | 400（message 列出可选值） |

**生效时机**：保存即热生效——采集开关/周期/延时变化自动重排定时器；TTL/HTTP/LLM/Agent 参数下次请求即用新值；**仅 `server.port` 需重启服务**（环境变量 `PORT` 始终优先于配置库）。

```bash
# 改采集周期为 10min + 快照交易时段 TTL 为 15s（其余字段保持不变）
curl -X PUT http://localhost:8787/api/config \
  -H 'Content-Type: application/json' \
  -d '{"collection":{"intervalMinutes":10},"cache":{"snapshot":{"trading":15}}}'

# 设置 LLM（token 覆盖）
curl -X PUT http://localhost:8787/api/config \
  -H 'Content-Type: application/json' \
  -d '{"llm":{"modelUrl":"https://api.example.com/v1","accessToken":"sk-xxx","model":"model-name"}}'

# 清除已存 token
curl -X PUT http://localhost:8787/api/config \
  -H 'Content-Type: application/json' \
  -d '{"llm":{"accessToken":""}}'
```

**错误响应**：400（字段校验失败 / 未知组或字段 / 请求体非合法 JSON，message 指明原因）/ 413（请求体超 64KB）/ 500（配置落库失败）。
