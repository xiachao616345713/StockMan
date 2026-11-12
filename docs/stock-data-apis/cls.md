# 财联社（CLS）接口

app 端定义：`api/StockService.kt` + `UnusualActionListFragment.kt`（WebView 拦截）
涉及主机：`api3.cls.cn`、`www.cls.cn`、`x-quote.cls.cn`

---

## 1. 人气榜 `getCLSHotRanking`

- **方法**：`GET https://api3.cls.cn/v1/hot_stock`
- **固定参数**：`app=cailianpress&os=android&sv=850&sign=e4d8f886f269874b1578fec645b258fa`（sign 硬编码在注解中）
- **响应**：`CLSRankResponse(errno, data: List<CLSData>)`；`CLSData` 关键字段：`title`、`ranking_change`（排名变化）、`stock: CLSStock(StockID[sz/sh前缀], name, last, RiseRange, status)`
- **调用**：`StockRepo.fetchCLSPopularityRanking()` → `PopularityRank` 表（clsRank 字段）

## 2. 盘面直播电报 `getDPLive`

- **方法**：`GET https://www.cls.cn/v3/transaction/articles`
- **固定参数**：`app=CailianpressWeb&os=web&sv=8.4.6`
- **动态参数**：`sign` — **需用户自行配置**：从财联社网页抓取后在设置页写入 SharedPreferences（`app`/`cls_sign`，读取函数 `SettingActivity.clsSign(context)`）；sign 为空时 `getCLSLive()` 直接返回
- **请求头**：桌面 Chrome `User-Agent`（client.kt 拦截器对 `www.cls.cn` 自动附加）
- **响应**：`CLSLiveResponse(errno, data: List<CLSLiveData>)`；关键字段：`ctime`（秒级时间戳）、`title/brief`、`plate_name/plate_code`（关联板块）、`stock_list: List<CLSStock>`
- **调用**：`StockRepo.getCLSLive()` — 转 `UnusualActionHistory`（type=2，stocks 去掉 sz/sh 前缀）入库

## 3. 涨跌池分析 `up_down_analysis`（WebView 拦截，非 Retrofit）

- **URL**：`https://x-quote.cls.cn/quote/index/up_down_analysis?type=up_pool&...`
- **获取方式**：该接口带动态签名无法直接请求，app 采用**隐藏 WebView 方案**：
  1. `UnusualActionListFragment.ensureHiddenClsWebView()` 创建不可见 WebView 并加载 `https://www.cls.cn/finance`
  2. `WebViewJsonInterceptor.inject(view)` 注入 JS，将页面发出的 XHR/fetch 响应 Base64 后经 `JsonBridge.onJsonBase64(url, b64)` 回传
  3. 仅处理 URL 前缀为 `x-quote.cls.cn/quote/index/up_down_analysis` 且 `type=up_pool` 的响应
  4. 去重（payloadKey = url + json.hashCode）后调用 `StockRepo.saveClsUpPoolJson(json)` 解析入库
- **相关代码**：`UnusualActionListFragment.kt`（`CLS_UP_POOL_API_PREFIX`、`ClsJsonBridge`）、`WebViewJsonInterceptor.kt`、`CustomWebView.kt`
- **数据内容**：财联社涨停池（含封单、连板、涨停原因等），落库为异动/涨停数据

---

### 备注

- 首页「财联社」按钮通过 `WebViewActivity.startDesktop` 打开 `https://www.cls.cn/finance`（桌面 UA），属于页面浏览而非数据接口
- CLS 三个数据入口分别覆盖：人气榜（api3，固定 sign）、直播电报（www，用户配置 sign）、涨停池（x-quote，WebView 拦截）
