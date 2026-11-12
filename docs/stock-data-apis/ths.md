# 同花顺（10jqka）接口

app 端定义：`api/StockService.kt`；响应模型：`api/beans.kt`、`db/beans.kt`
涉及主机：`data.10jqka.com.cn`、`ozone.10jqka.com.cn`、`dataq.10jqka.com.cn`、`dq.10jqka.com.cn`、`eq.10jqka.com.cn`

---

## 1. 涨停池 `getLimitUpPool`

- **方法**：`GET https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool`
- **固定参数**：`field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003&filter=HS,GEM2STAR&order_field=330324&order_type=0`
- **动态参数**：
  | 参数 | 说明 |
  |------|------|
  | `date` | 交易日 `yyyyMMdd` |
  | `page` | 页码，从 1 开始 |
  | `limit` | 每页条数，默认 200 |
- **响应**：`LimitUpPoolResponse → LimitUpPoolData(info: List<Info>, limit_up_count, limit_down_count, page, trade_status)`；`Info` 关键字段：`code/name/latest/change_rate/high_days`（几天几板）`/limit_up_type`（涨停类型）`/reason_type`（涨停原因）`/first_limit_up_time/last_limit_up_time`（秒级时间戳）`/open_num`（开板次数）`/turnover_rate/order_volume`（封单）
- **调用**：`StockRepo.getLimitUpPool(date)` — 循环翻页直到取完，转 `UnusualActionHistory`（type=5）入库
- **备注**：monitor 端对应 `ThsApi.getLimitUpPool`（相同 path 与参数，另加 Referer/UA 头）

## 2. 跌停池 `getLimitDownPool`

- **方法**：`GET https://data.10jqka.com.cn/dataapi/limit_up/lower_limit_pool`
- **固定参数**：`field=199112,10,330333,330334,1968584,3475914&filter=HS,GEM2STAR&order_field=330334&order_type=0`
- **动态参数**：`date`（yyyyMMdd）、`page`、`limit=200`
- **响应**：`LimitDownPoolResponse → LimitDownPoolData(info: List<LimitDownPoolInfo>)`；关键字段：`code/name/latest/change_rate/first_limit_down_time/last_limit_down_time/is_again_limit`
- **调用**：`StockRepo.getLimitDownPool(date)` — 循环翻页，转 `UnusualActionHistory`（type=6）入库

## 3. 涨停复盘 `getZTReplay2(date)`

- **方法**：`GET https://data.10jqka.com.cn/dataapi/limit_up/block_top`
- **固定参数**：`filter=HS,GEM2STAR`
- **动态参数**：`date`（yyyyMMdd）
- **响应**：`THSFPResponse → data: List<THSFPData>`；`THSFPData` 为题材分组：`name/code/limit_up_num/days/stock_list: List<THSFPStock>`；`THSFPStock` 关键字段：`code/name/change_rate/concept/continue_num`（连板数）`/high_days/first_limit_up_time/reason_type/reason_info`（涨停原因）
- **调用**：`StockRepo.fetchZTReplay2(date)` — 15:00 后且当日大盘历史存在时拉取，与 `getAllTabList` 结果合并写 `ZTReplayBean` 表

## 4. 异动排行榜全 tab `getAllTabList`

- **方法**：`GET https://ozone.10jqka.com.cn/open/api/draw_lots/v1/rank/all_tab_data`
- **动态参数**：`date`（yyyyMMdd）
- **响应**：`AllTabListResponse → data.tab_list: List<Tab(date, tab_name, tab_data: List<TabData>)>`；`TabData` 关键字段：`market/stock_code/stock_name/ths_code/abnormal_reason/reason/concept`
- **调用**：`StockRepo.fetchZTReplay2(date)` — 提供当日全部异动股清单（涨停复盘骨架）

## 5. 批量指标查询 `getSpecificData`

- **方法**：`POST https://dataq.10jqka.com.cn/fetch-data-server/fetch/v1/specific_data`
- **请求体**：`SpecificDataBean`，默认构造 `getDefaultSpecificDataBean(codes)`：
  ```json
  {
    "code_selectors": {"intersection": [{"type": "stock_code", "values": ["1:600000", "0:000001"]}]},
    "indexes": [{"index_id": "security_name"}, {"index_id": "last_price"},
                {"index_id": "price_change_ratio_pct"}, {"index_id": "up_down_stock_limit_up_reason"}],
    "page_info": {"page_begin": 0, "page_size": 100},
    "sort": [{"idx": 2, "type": "DESC"}]
  }
  ```
- **响应**：`SpecificDataResponse → data.data: List<DataX(code, values: List<Value(idx, value)>)>`；`idx=3` 对应涨停原因
- **调用**：`StockRepo.fetchZTReplay2` — 对 block_top 中缺失的个股兜底补涨停原因

## 6. 热股榜 `getTHSHotRanking`

- **方法**：`GET https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock`
- **固定参数**：`stock_type=a&type=hour&list_type=normal`
- **响应**：`THSHotRankingResponse → data.stock_list: List<THSStock>`；关键字段：`code/name/order`（排名）`/hot_rank_chg`（排名变化）`/rise_and_fall/tag.concept_tag/topic`
- **调用**：`StockRepo.fetchTHSPopularityRanking()` → `PopularityRank` 表（thsRank 字段）

## 7. 全天异动直播 `getTHSYDLive(@Url)`

- **方法**：`GET https://eq.10jqka.com.cn/dpyddata/apidata_{date}.txt`（完整 URL 传入，date 为 yyyyMMdd 静态文件）
- **响应**：`THSYDResponse`（ArrayList）→ `THSYDResponseItem(ctime, info: List<THSInfo>)`；`THSInfo` 关键字段：`title/analysisContent/bkname`（板块名）`/sentiment/stocklist: List<Stocklist(stockCode, stockName, dzf, capitalFlow)>`
- **调用**：`StockRepo.getTHSLive(date)` — 转 `UnusualActionHistory`（type=4）入库

## 8. 集合竞价异动预警 `getCallWarn`

- **方法**：`POST https://eq.10jqka.com.cn/call_auction/v2/stock_chance/v1/real_time_list/call_warn`
- **请求体**：`CallWarnParam(filter=Filter(market="1", st=0, warn_types=...), page_num=1, page_size=20, sort=0)`
- **warn_types 取值**（`WARN_TYPE_MAP`，db/beans.kt）：`68715`=大幅高开、`68713`=竞价抢筹、`68716`=大幅低开
- **响应**：`CallWarnResponse → data.data_list: List<List<Any>>`；行内索引：`[0]`名称、`[1]`代码、`[3]`预警类型、`[5]`涨跌幅(Double)、`[11]`时间戳(Double)
- **调用**：`StockRepo.getCallWarnType()` — 三种预警类型并行拉取，先删当日旧记录再写 `UnusualActionHistory`

## 9. 龙虎榜 `getDragonTigerRank2(@Url)`

- **方法**：`GET https://data.10jqka.com.cn/dataapi/transaction/stock/v1/list`（完整 URL 由 `fetchDragonTigerRank2` 拼接）
- **参数**：`order_field=hot_rank&order_type=asc&date={yyyy-MM-dd}&filter=&page=1&size=50&module=all&order_null_greater=1`
- **响应**：`DraganTigerDataResponse → data.items: List<DragonTiger2Item>`；关键字段：`stock_code/stock_name/change/net_value`（净买额）`/hot_money_net_value`（游资）`/org_net_value`（机构）`/limit_reason/concept_list/tags`（营业部标签）
- **调用**：`StockRepo.fetchDragonTigerRank2(date)` — 生成 code→item Map，供 `fetchDragonTigerRank` 合并 tags 使用

---

### monitor 端对应接口

monitor 的 `ThsApi`（`network/ThsApi.kt`）实现了上述 **1（涨停池）** 与 **3（涨停复盘 block_top）**，baseUrl `https://data.10jqka.com.cn/`，请求头 `Referer: https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html` + 桌面 UA；调用方为 `MarketEngine`（`thsApi.getLimitUpPool(date, page)`、`thsApi.getZtReplay(date)`）。详见 [monitor.md](monitor.md)。
