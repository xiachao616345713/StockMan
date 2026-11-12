# 新浪财经接口

app 端定义：`api/StockService.kt`；响应模型：`api/beans.kt`（`SinaHQNodeItem`）
主机：`vip.stock.finance.sina.com.cn`

---

## 成份股实时行情 `getSinaHQNodeDataSimple(@Url)`

- **方法**：`GET https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple`（完整 URL 由调用方拼接）
- **参数**：
  | 参数 | app 端取值 | 说明 |
  |------|-----------|------|
  | `page` | 0 起 | 页码 |
  | `num` | 3000 | 每页条数 |
  | `sort` | `symbol` | 排序字段 |
  | `asc` | `1` | 升序 |
  | `node` | `zhishu_399106` | 深证综指成份（≈深市全部 A 股） |
  | `_s_r_a` | `page` | 固定 |
- **请求头**：桌面 Chrome `User-Agent`（client.kt 拦截器对 `*.finance.sina.com.cn` 自动附加）
- **响应**：非严格 JSON 数组（Gson lenient 解析）→ `List<SinaHQNodeItem>`；字段：`symbol`（sz000001）、`code`、`name`、`trade`（最新价）、`pricechange`、`changepercent`、`settlement`（昨收）、`open/high/low`、`volume`（股）、`amount`（元）、`ticktime`
- **调用**：`StockRepo.getRealTimeSinaSZ(pageSize=3000, maxPages=1)` — 按页拉取直到返回条数不足 pageSize；经 `parseSinaStockCode`/`sinaItemToStock` 转换后与本地 `Stock` 合并（保留本地 ztPrice/dtPrice 等字段），写 `Stock` + `HistoryStock` 表并驱动 Tracker
- **node 可选值**（monitor 端使用）：`hs_a` = 沪深全部 A 股；其他如 `zhishu_399106`（深综指）

---

### monitor 端对应接口

`network/SinaApi.kt`：`GET quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple`，参数 `page`（从 1 起）、`num=6000` + QueryMap `sort=symbol&asc=1&node=hs_a&_s_r_a=page`，响应 `List<SinaRealtimeStockDto>`（code/symbol/name/trade/settlement/open/high/low/volume/amount/changepercent）。
调用方：`RealtimeStockSync`（`SinaRealtimeStockStrategy`，monitor 默认实时快照源，全市场分页拉取）。
