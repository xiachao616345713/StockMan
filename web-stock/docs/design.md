# web-stock 设计文档

> 版本：v1.4.0 · 日期：2026-11-12 · 状态：已实现并验证
> 本文档记录需求范围、架构、技术决策与数据源映射，作为实现的可回溯依据。
> 上游接口出处统一引用 [`../../docs/stock-data-apis/`](../../docs/stock-data-apis/)（下文简称「接口文档」）。
> LLM 接入（v1.3.0）不依赖接口文档，配置与决策见 D14；配置持久化与设置页（v1.4.0）见 D16。

---

## 1. 需求与范围

**原始需求**（2026-11-11）：基于 `docs/stock-data-apis/` 接口文档，实现一个查询行情数据的 Web 功能，具体功能范围自行决定，实现结果需形成可回溯文档。

**v1.0.0 范围**（自主决定，见 §3 决策 D1）：

| # | 功能 | 说明 |
|---|------|------|
| F1 | 市场总览 | 三大指数卡片、全市场涨跌统计、涨幅/跌幅榜 Top20 |
| F2 | 个股查询 | 代码/名称搜索、实时行情明细（21 字段）、日 K 线图（蜡烛+均线+成交量） |
| F3 | 板块排行 | 行业/概念板块实时排行（4 列可排序 + 涨跌平家数）、板块成份股下钻 |
| F4 | 涨停中心 | 按日期查询涨停池明细、按题材分组的涨停复盘 |
| F5 | 条件选股（v1.1.0，v1.2.0 扩充） | 左栏筛选结果排序列表（点击加载 K 线）、右上日 K 线、右下筛选指标（涨跌幅/换手率/成交额/总市值区间 + 板块 + 排除 ST + 排序键 + 快捷预设）；v1.2.0 新增 流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今 6 组区间与排序键、3 个预设 |
| F6 | 龙虎榜（v1.2.0） | 按日期查询上榜股票：东财明细（原因/净买/买卖/次日涨幅）+ 同花顺（游资/机构净买/标签/概念）合并，13 列 9 列可排序 |
| F7 | 热榜（v1.2.0） | 东财/同花顺/财联社/大智慧 四平台人气榜合并排行（各平台名次与变化/热度/人气标签/概念），条数 50/100/300 |
| F8 | 连板天梯（v1.2.0） | 涨停中心子页：当日涨停池按连板数分层（最高板在前，层内 N 板 N 天优先） |
| F9 | 涨停关联分析（v1.2.0） | 涨停中心子页：目标涨停股的题材关联（复盘同组）+ 近 N 日共同涨停统计；涨停池行「关联」按钮带入代码 |
| F10 | AI 选股助手（v1.3.0） | **默认标签页**聊天框：自然语言描述筛选条件 → 后端 Agent（LLM function-calling）调用既有数据接口完成选股/查行情/看热榜，回答附工具轨迹与可点击股票 chips；LLM 经 model_url + access_token 配置（仅服务端） |
| F11 | 系统设置（v1.4.0） | 服务端配置持久化到数据库（node:sqlite，JSON 兜底）+ 右上角 ⚙ 设置页在线读写：数据采集开关/周期、LLM 配置（密钥不回显）、Agent 对话上限、缓存 TTL、服务端口+交易时段、上游 HTTP 超时/重试；除端口外保存即热生效 |

**明确不做**（v1 范围外，理由见 §6 已知限制）：分时/SSE tick 流、自选股与账号体系。~~历史数据落库~~ → v1.3.0 已实现**按日 JSON 归档**（热榜/龙虎榜/涨停池/连板天梯，见 D15），但仍非全量行情库（分时/tick 级落库继续不做）。

## 2. 架构

```
浏览器 (Vue 3 SPA, web/dist)
   │  fetch /api/*  (JSON 信封: {data, meta} / {error})
   ▼
Node.js 服务 (server/, 零第三方依赖, 端口 config.server.port 默认 8787)
   ├── index.js      入口：配置初始化(v1.4.0) + HTTP 服务：/api/* 路由分发 + web/dist 静态托管(SPA fallback) + 采集器启动
   ├── api.js        路由层：参数校验 → TTL 缓存(config.cache) → 数据源 → 响应包装
   │                 v1.3.0 增：invokeRoute(进程内路由复用) / 归档写穿 / POST /api/agent/chat / collectHistory
   │                 v1.4.0 增：GET·PUT /api/config(读取/热更新配置)
   ├── lib/          http(上游请求封装·config.http) cache(TTL+去重) market(交易时段·config.server/secid) util
   │   ├── config-store.js 配置存储：node:sqlite(主)/JSON(兜底) 自动探测（server/data/config.db，v1.4.0）
   │   ├── config.js       配置中心：6 组 schema/校验/热更新/密钥掩码（v1.4.0）
   │   ├── collector.js    历史采集定时器：按 config.collection 排程、onChange 自动重排（v1.4.0，自 index.js 抽出）
   │   ├── llm.js      OpenAI 兼容 chat/completions 客户端（配置取 config.llm，token 仅服务端，v1.3.0）
   │   ├── agent.js    Agent 循环：系统提示词 + 13 工具定义 + 工具结果压缩 + 3 个历史 join 工具（v1.3.0）
   │   └── history.js  JSON 历史归档：原子写/节流(config.collection)/日期窗口/概览（server/data/，v1.3.0）
   ├── data/         配置库 config.db(v1.4.0) + 历史归档 {limitup,hotrank,dragontiger,ladder}/{yyyyMMdd}.json（运行期生成，gitignored）
   └── sources/      eastmoney(主源/龙虎榜/人气) sina(快照兜底) sohu(K线兜底)
                     ths(涨停/龙虎榜/热榜) cls(热榜) dzh(热榜)
                          │  fetch + UA/Referer + 超时/重试(config.http)
                          ▼
        上游公开行情接口（东财 / 新浪 / 搜狐 / 同花顺）    +    用户配置的 LLM 服务（OpenAI 兼容，v1.3.0）
```

- **前后端同端口部署**：生产模式后端直接托管 `web/dist`；开发模式 Vite dev server（5173）将 `/api` 代理到 8787。
- **数据流**：视图 → `src/api.js`（信封解析）→ 后端 `api.js`（校验+缓存）→ `sources/*`（归一化）→ 上游。所有上游字段差异（缩放、单位、`'-'` 占位、`%` 后缀）在 sources 层归一化，前端只见统一结构。
- **Agent 数据流（v1.3.0）**：ChatView → `POST /api/agent/chat` → `agent.js#runAgent`（LLM ↔ 工具循环，轮数上限 config.agent.maxRounds）→ 数据工具经 `invokeRoute` 复用既有路由（共享校验与 TTL 缓存）/ 历史工具读 `data/` 归档 → 回复 + 工具轨迹 + 股票 chips 一次性返回。
- **配置数据流（v1.4.0）**：SettingsView → `GET/PUT /api/config` → `lib/config.js`（逐字段校验 → 按组深合并 → `config-store` 落库 → 内存态整体替换 + onChange 通知采集器重排）。所有消费方在**使用时**调 `getGroup(name)` 热读（不在模块加载期缓存引用），故除端口（listen 一次性）外保存即生效。详见 D16。

## 3. 技术决策记录（ADR）

### D1. 功能范围取「查询」四件套
- **决策**：v1 只做 总览/个股/板块/涨停中心 四个查询视图。
- **理由**：需求为「查询行情数据」；这四项覆盖接口文档中 快照/K线/板块/涨停 四类最核心的查询型接口，且全部有 monitor 端已验证的调用先例。龙虎榜/人气榜等接口多需鉴权参数（CLS sign）或仅收盘后可用，不适合作为 v1 基础能力。
- **被否方案**：全量移植 app 端功能（38 个接口）——工作量与鉴权复杂度不成比例。

### D2. 后端用零依赖 Node.js 而非 Spring Boot / Ktor
- **决策**：后端仅用 Node 内置模块（`node:http` + 内置 `fetch`），无任何 npm 依赖。
- **理由**：本质是「带缓存的 HTTP 代理 + 静态托管」，Node >= 18 内置 fetch 后零依赖即可覆盖；`cd server && npm start` 即跑，无构建步骤。仓库内 stockman-monitor 已有 Ktor/Gradle 重型方案，本目录定位为轻量查询工具，避免重复建设。
- **被否方案**：Spring Boot（全局规范偏好，但对 8 个代理接口过重）；Vite SSR / Next（引入框架锁）。

### D3. 前端 Vue 3 + Vite + ECharts，不引入 UI 组件库与 Pinia
- **决策**：手写暗色主题 CSS（CSS 变量），状态用模块级 `ref` 单例（`src/store.js`），视图切换用 tab 而非 vue-router。
- **理由**：4 个视图、2 个共享状态（activeTab/selectedCode），router/Pinia 收益为零；行情终端风格（暗色、红涨绿跌、等宽数字）手写 CSS 比改造 Element Plus 主题更直接。构建产物仅 vue+echarts 两个运行时依赖。
- **符合规范**：Composition API + `<script setup>`、组件 PascalCase 文件名、props camelCase/模板 kebab-case、事件处理函数 `handle*` 前缀、布尔值 `is*` 前缀（vue.md §1、§2.1）。
- **被否方案**：Element Plus（全局偏好，但暗色行情风格定制成本高，表格需求简单）。

### D4. 全市场快照作为搜索/排行/统计的统一数据底座
- **决策**：后端按需拉取全市场快照（东财 clist 分页并行），缓存后同时支撑 搜索、涨跌幅榜、涨跌统计、单股行情 四个接口。
- **理由**：接口文档未收录单股实时快照接口（app 端单股实时走 SSE tick 流）；东财 clist 一次全量 ≈ 60 页 × 100 条（实测 6 并发约 1.3s），缓存 30s 后所有查询零上游成本，且搜索无需引入额外 suggest 接口。
- **实测修正**：文档标注 `pz=200`，**实测服务端单页最多返回 100 条**（与 monitor 端 `pz=100`、app 端「pn=1..59」互相印证），实现按 `pz=100` 分页，总页数上限 80。
- **被否方案**：kline lmt=1 逐股查询（无法支撑搜索/排行）。

### D5. 双源兜底链
- **决策**：快照 东财→新浪（hs_a，num=6000 单页全量）；日 K 东财 push2his→搜狐 hisHq。
- **理由**：复刻 monitor 端多源策略链思想（monitor.md：新浪为默认快照源、搜狐为历史 K 首选）。东财字段最全作主源；兜底源字段缺失置 `null`，前端统一显示 `-`。
- **实测修正**：搜狐百分比字段带 `%` 后缀（文档未提及），需去后缀解析；搜狐不返回振幅，由相邻两日收盘推算（实测与东财振幅一致，误差 0）；搜狐当日盘中数据缺失，兜底场景下最后一根 K 线可能滞后一日。

### D6. 缓存 TTL 按交易时段区分 + in-flight 去重
- **决策**：同一 key 交易时段/收盘后使用不同 TTL（快照 30s/10min，K线 60s/30min，板块 60s/15min，涨停 2min/30min）；并发请求同 key 只触发一次上游拉取。
- **理由**：对公开接口保持克制；收盘后数据不变，长 TTL 无副作用。交易时段判断为宽松规则（周一至五 09:15–15:05 上海时区，不识别节假日），仅影响 TTL 选择，误判无业务风险。

### D7. 请求上游统一携带桌面 UA + 对应 Referer
- **理由**：接口文档「鉴权/特殊请求头」：新浪/同花顺/东财均有 UA 或 Referer 要求，缺失会被反爬拦截。同花顺涨停接口需 `Referer: https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html`。

### D8. 数值缩放统一走 fltt=2
- **决策**：clist 快照/板块/成份股请求统一带 `fltt=2`，服务端直接返回浮点。
- **理由**：README「数值缩放注意」：不带 fltt=2 时价格为 ×100 整数需客户端还原；fltt=2 免去还原逻辑与出错面（实测 clist 带 fltt=2 正常返回浮点）。

### D9. 选股器（v1.1.0）完全基于快照字段，不引入新上游（补充 D4）
- **决策**：`/api/screen` 的过滤/排序字段全部取自全市场快照归一化字段（pct/turnover/amount/amplitude/totalMv + board/ST）；前端三栏布局（左列表 / 右上 K / 右下指标），K 线复用 `/api/kline` 与 KLineChart 组件。
- **理由**：快照已缓存（30s/10min TTL），选股零新增上游成本，5900 只内存过滤 <1ms；接口文档中的历史类筛选（创新高、连板数）需逐股 K 线或涨停池 join，请求量与复杂度不成比例。
- **降级行为**：快照处于新浪兜底源时换手率/振幅/市值为 null，设这些阈值的筛选结果为空——服务端不做「未知即通过」的静默放行，前端以「兜底源」标签 + 空态提示明示（见 §6 限制 8）。
- **被否方案**：逐股拉 K 线做历史条件筛选（≈5900 请求/次）；前端拿全量快照自行过滤（需新增「导出全量快照」接口，且把归一化规则泄漏到前端）。

### D10. 龙虎榜「东财明细 + 同花顺补充」双源合并、单侧降级（v1.2.0）
- **决策**：东财 datacenter-web `RPT_DAILYBILLBOARD_DETAILSNEW` 为主源（上榜原因/净买额/买卖额/次日涨幅/换手/流通市值），同花顺 transaction 龙虎榜按代码合并补充游资/机构净买、营业部标签、概念；`platforms` 数组标注各源 ok/error，单侧失败降级为另一侧字段，全失败才 502。
- **理由**：两源字段高度互补（东财有金额与次日涨幅、同花顺有席位结构与题材标签）；龙虎榜为收盘后数据（约 17:00 发布），时效要求低，5min/30min TTL 缓存足够。
- **实测修正**：东财同一股票同日可有多条榜单行（上多个榜）——按代码合并：主行取榜单成交额更大者，上榜原因去重后「；」连接（见 changelog v1.2.0 实测修正）。
- **被否方案**：只接单源（丢一半字段）；合并席位明细（营业部买卖前五）——表格信息密度过低，列 v2 候选。

### D11. 热榜四平台按代码聚合、独立容错（v1.2.0）
- **决策**：东财 xuangu 人气榜（300）/同花顺 fuyao 热股榜（100）/财联社热股榜/大智慧人气榜（100）按代码合并成行，保留各平台名次与名次变化、热度值、人气标签、概念；默认 dfcfRank→thsRank 升序、缺名次排末尾；各平台独立容错，全失败才 502。
- **理由**：app 端 Injector 的人气榜合并任务已验证多平台交叉的价值（同一股票在各平台的名次差本身是信息）；合并行让前端可展示「哪些平台同时收录」。
- **实测修正**：淘股吧（tgb.cn）当前网络环境 DNS 不可达，未接入（§6 限制 10）；财联社接口需固定 sign 计算（沿用接口文档 cls.md 算法）。
- **被否方案**：单平台人气榜（无交叉验证）；淘股吧强接（DNS 级失败，重试无意义）。

### D12. 连板天梯与关联分析纯派生自涨停池/复盘缓存，零新增上游（v1.2.0）
- **决策**：`/api/ladder` 由当日涨停池在内存中按 `highDays` 板数分组；`/api/limitup/related` 的题材关联取自当日 block_top 分组过滤、共同涨停逐日回看历史涨停池（跳过周末、批 5 并发、取满 N 个交易日为止、单日失败容忍），全部复用 `limitup:pool:{date}` / `limitup:replay:{date}` 缓存。
- **理由**：两者都是「既有数据的二次组织」，不新增上游接口；回看 10 个交易日 ≈10 次池请求，首次之后全命中缓存（收盘后 30min TTL），成本可控。
- **实测修正**：复盘仅 top 20 题材组——不在任何组的股票 `themes: []`（前端明示「未出现在涨停复盘分组中」），与 `themes: null`（复盘源失败）语义区分；`highDays` 解码失败按首板兜底。
- **被否方案**：自建历史涨停库（v1 范围外，§6）；逐股拉 K 线判定涨停（≈5900×N 请求）。

### D13. 选股器新指标只取快照既有 f 字段（v1.2.0，补充 D9）
- **决策**：新增 流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今 6 组区间条件与排序键，全部取自东财快照字段（clist 增补 f9/f10/f23/f24/f25/f115，流通市值 f21 原有），不新增上游请求。
- **理由**：延续 D9「零新增上游」原则；6 个字段与价格/换手同在一次 clist 响应中返回，边际成本为零。
- **降级**：新浪兜底源下 6 字段为 null，含其阈值的条件筛空——沿用 v1.1.0「不静默放行 + 兜底源标签 + 空态提示」语义，提示文案同步列出缺失字段。
- **待补验证**：验证窗口内东财 clist 故障，6 个 f 字段映射的实测值待恢复后复核（§6 限制 9）。

### D14. AI 选股助手：OpenAI 兼容 function-calling Agent，配置仅服务端（v1.3.0）
- **决策**：新增 `POST /api/agent/chat`（唯一 POST 接口）。服务端以 OpenAI 兼容协议调用用户配置的 LLM（`model_url` 自动补全 `/chat/completions`，`Authorization: Bearer {access_token}`），走 tools function-calling 循环（最多 6 轮）：LLM 产出 tool_calls → 服务端执行 → tool 消息回填 → 直至最终文本。13 个工具中 10 个数据工具（选股/行情/指数/统计/排行/热榜/涨停池/板块/龙虎榜/搜索）全部经 `invokeRoute(pathname, params)` 进程内复用既有路由——共享参数校验与 TTL 缓存，零重复逻辑；3 个历史工具读本地归档（D15）。LLM 配置优先级 env（`LLM_MODEL_URL`/`LLM_ACCESS_TOKEN`/`LLM_MODEL`）> `server/llm.config.json`（gitignored），**token 只存服务端、绝不下发前端**；未配置返回 503 + 配置指引。（v1.4.0 更新：LLM 配置迁入配置库并经设置页读写，env/file 降级为首跑种子，见 D16。）`runAgent(history, invoke)` 依赖注入路由执行器，规避 api.js ↔ agent.js 的 ESM 循环导入。
- **理由**：需求本质是「自然语言 → 既有数据接口」，function-calling 让 LLM 自主选工具与参数，覆盖任意条件组合，远优于规则式意图解析；工具结果压缩（列表截断 + 字段挑选，如选股 100×27 字段 → 50×15）控制 token；系统提示词约束「只依据工具返回数据回答、纯文本、附免责声明」。
- **实测**：mock LLM 端到端验证 3 场景通过——条件选股（screen_stocks 命中 12 只）、跨日筛选（history_overview → history_screen 链，命中 15 只且排序/过滤正确）、共同涨停关联（1.6s 含 7 天回补）；auth 头、tools=13、压缩结果均符合预期（changelog v1.3.0 验证记录）。
- **被否方案**：前端直连 LLM（token 泄漏到浏览器）；规则式意图解析（脆弱、组合爆炸）；SSE 流式输出（v2 候选，见 §6 限制 12）；LangChain 等框架（违背 D2 零依赖）。

### D15. 历史归档用按日 JSON 文件而非 sqlite/chroma（v1.3.0）
- **决策**：涨停池/热榜/龙虎榜/连板天梯四类数据按日落盘 `server/data/{type}/{yyyyMMdd}.json`（结构 `{type,date,savedAt,data}`，data 与路由响应同构）。**写入双通道**：① 路由写穿——4 个路由请求成功后 fire-and-forget 归档，10min 节流防抖动；② 后台采集器——启动 5s 首跑、之后每 30min 一轮（龙虎榜仅上海时间 15:00 后采集），复用路由缓存。原子写（tmp+rename）。**读取**：agent 历史工具（history_overview/history_screen/history_co_limitup）纯内存 join，无查询引擎。**回补**：涨停池/龙虎榜上游支持 date 参数——history_co_limitup 发现窗口内归档缺失时自动按日回补（批 5 并发，顺带写穿归档，实测一次补齐 7 个交易日）；**热榜上游无日期参数，不可回补，只能向前积累**。
- **理由**：零第三方依赖是硬约束（D2）——`node:sqlite` 需 Node ≥ 22.5 且带 experimental 标记，chroma 需 Python 进程；数据量小（每类每日 ≈100–300 行、单文件 10–90KB，一年 ≈70MB），读文件+内存过滤毫秒级；JSON 人类可读可手工修复，按日文件天然隔离、损坏只影响单日（loadRecord 容错返回 null）；用户明确「向量库或关系库均可，chroma/sqlite 只是为了免安装」——JSON 文件同样免安装且更贴合本场景（结构化跨日 join，非语义检索，向量库无用武之地）。
- **被否方案**：node:sqlite（Node 版本门槛 + experimental，部署面收窄）；chroma（引入 Python 运行时，违背零依赖）；单独归档接口（与写穿重复）。

### D16. 配置持久化用 node:sqlite + JSON 兜底，设置页在线读写（v1.4.0）
- **决策**：服务端全部可调参数收敛为 **6 个配置组**（`collection` 采集开关/周期/类型、`llm` 模型接入、`agent` 对话上限、`cache` 10 键双档 TTL、`server` 端口/交易时段、`http` 上游超时/重试），持久化到 `server/data/config.db`（Node 内置 `node:sqlite`，表 `app_config(key, value, updated_at)`，一行一组、value 为该组 JSON）；`node:sqlite` 不可用（Node < 22.5）时自动回退 `server/data/config.json`（tmp+rename 原子写），启动日志打印实际后端。新增 `GET/PUT /api/config` 与前端设置页（右上角齿轮入口，不占导航标签）。PUT 为**部分合并语义**：按组深合并、逐字段类型/区间校验（未知组/未知字段/越界 → 400 中文 message），仅变更组落库。**密钥掩码**：`maskSecrets()` 保证 GET 永不回显 `llm.accessToken` 原文，只返回 `accessTokenSet` 布尔；PUT 对 token 采用**三态语义**——字段缺省=保持、空串=清除、非空=覆盖。**热生效模型**：内存态 `current` 整体替换，所有消费方在使用时 `getGroup()` 热读（约定禁止模块加载期缓存引用）；采集器经 `onChange` 重排定时器；仅**端口需重启**（listen 一次性），`PORT` 环境变量仍优先于数据库（部署逃生口）。**首跑播种**：库中无 `llm` 组时用 `LLM_*` env / `server/llm.config.json` 播种、无 `server` 组时用 `PORT` env 播种端口，此后数据库为唯一真相源（老部署升级不中断）。
- **理由**：改任何参数不再需要改代码/重启（端口除外），且配置有单一可审计的持久化位置；`node:sqlite` 为 Node 内置模块，**不违背 D2 零依赖**——与 D15 拒绝 sqlite 归档的语境不同：归档拒绝的是「Node ≥ 22.5 门槛收窄部署面」，此处以 JSON 兜底消除该门槛（新旧 Node 均可运行，仅存储介质不同，功能一致）；一行一组的 KV 结构让部分更新只写变更组、无需整库重写；密钥掩码在 config 层统一实现（而非各路由自行处理），沿用 D14「token 绝不下发前端」原则；校验放在写入侧（而非读取侧），保证库中值恒合法、读取方无需防御。
- **实测**：部分合并（改 `cache.snapshot.trading` 保留 `closed`）、密钥三态、7 类非法值 400、重启持久化、采集器热重排、首跑播种（env.PORT → server.port）全部通过（changelog v1.4.0 验证记录）。
- **被否方案**：better-sqlite3 / lowdb 等 npm 包（违背 D2 零依赖）；纯 env + 配置文件（无页面化读写入口，改配置仍需登录服务器改文件并重启）；复用归档 JSON 体系存配置（配置与数据生命周期不同：配置需按组部分更新+写入侧校验+密钥掩码，独立 KV 更清晰）；前端 localStorage 存配置（服务端读不到、多端不一致）；WebSocket/SSE 推送配置变更（单实例部署下 onChange 进程内通知已足够）。


## 4. 功能 → 上游接口映射（可回溯核心表）

| 前端功能 | 后端接口 | 上游接口 | 接口文档出处 | 代码位置 |
|----------|----------|----------|--------------|----------|
| 指数卡片 | `GET /api/indices` | 东财 `push2his/api/qt/stock/kline/get`（secid=1.000001/0.399001/0.399006, lmt=1） | eastmoney.md §5（getRealTimeIndexByCode 用法） | `sources/eastmoney.js#fetchIndexQuote` |
| 涨跌统计/排行榜/搜索/单股行情 | `GET /api/stats` `/api/ranking` `/api/search` `/api/quote` | 东财 `20.push2/api/qt/clist/get`（fs=全市场, fltt=2, pz=100 分页×6并发） | eastmoney.md §1 + README fs/f 字段表 | `sources/eastmoney.js#fetchFullSnapshot` |
| └ 快照兜底 | 同上（东财失败时） | 新浪 `Market_Center.getHQNodeDataSimple`（node=hs_a, num=6000） | sina.md + monitor.md §2 | `sources/sina.js#fetchFullSnapshot` |
| 日 K 线图 | `GET /api/kline` | 东财 `push2his/api/qt/stock/kline/get`（klt=101, fqt=1, fields2=f51..f64） | eastmoney.md §5 + README K线参数/返回格式 | `sources/eastmoney.js#fetchKline` |
| └ K线兜底 | 同上（东财失败时） | 搜狐 `q.stock.sohu.com/hisHq`（code=cn_xxx） | sohu.md + monitor.md §4 | `sources/sohu.js#fetchKline` |
| 板块排行 | `GET /api/sectors` | 东财 clist（fs=m:90+t:2+f:!50 / m:90+t:3+f:!50, fltt=2, 含 f104/f105/f106） | eastmoney.md §7 + README f 字段表 | `sources/eastmoney.js#fetchSectors` |
| 板块成份股 | `GET /api/sectors/stocks` | 东财 clist（fs=b:BKxxxx） | eastmoney.md §6 | `sources/eastmoney.js#fetchBkStocks` |
| 涨停池 | `GET /api/limitup/pool` | 同花顺 `data.10jqka.com.cn/dataapi/limit_up/limit_up_pool`（limit=200 翻页） | ths.md §1 + monitor.md §5a | `sources/ths.js#fetchLimitUpPool` |
| 涨停复盘 | `GET /api/limitup/replay` | 同花顺 `dataapi/limit_up/block_top`（组内个股 `high_days` 为编码整数：高 16 位板数/低 16 位天数，`decodeHighDays` 解码，见 changelog 实测修正 #7） | ths.md §3 + monitor.md §5b | `sources/ths.js#fetchZtReplay` |
| 选股器列表（v1.1.0） | `GET /api/screen` | 无新增上游：复用 D4 全市场快照缓存（东财 clist → 新浪兜底），服务端过滤+排序 | README fs/f 字段表（字段集合同快照） | `server/api.js` 路由 `/api/screen` |
| 选股器 K 线（v1.1.0） | `GET /api/kline`（复用 §F2） | 同 F2：东财 push2his → 搜狐兜底 | eastmoney.md §5 / sohu.md | `components/KLineChart.vue` 复用 |
| 选股器新指标（v1.2.0） | `GET /api/screen`（扩充） | 无新增上游：D4 快照 clist 字段集增补 f9/f10/f23/f24/f25/f115（市盈率动/量比/市净率/60日涨幅/年初至今/市盈率TTM） | README fs/f 字段表 | `sources/eastmoney.js#SNAPSHOT_FIELDS` |
| 龙虎榜主表（v1.2.0） | `GET /api/dragon-tiger` | 东财 `datacenter-web`（reportName=RPT_DAILYBILLBOARD_DETAILSNEW） | eastmoney.md §11 | `sources/eastmoney.js#fetchDragonTiger` |
| 龙虎榜同花顺补充（v1.2.0） | 同上（按代码合并） | 同花顺 transaction 龙虎榜（游资/机构净买/标签/概念） | ths.md §9 | `sources/ths.js#fetchDragonTigerList` |
| 热榜·东财（v1.2.0） | `GET /api/hot-rank` | 东财 xuangu `dataapi/xuangu/list`（st=POPULARITY_RANK） | eastmoney.md §10 | `sources/eastmoney.js#fetchPopularityRank` |
| 热榜·同花顺（v1.2.0） | 同上（按代码聚合） | 同花顺 fuyao 热股榜 | ths.md §6 | `sources/ths.js#fetchHotList` |
| 热榜·财联社（v1.2.0） | 同上 | 财联社 hot_stock（固定 sign） | cls.md §1 | `sources/cls.js#fetchHotRanking` |
| 热榜·大智慧（v1.2.0） | 同上 | 大智慧 `imsearch.dzh.com.cn/stock/top` | others.md §2 | `sources/dzh.js#fetchHotRanking` |
| 连板天梯（v1.2.0） | `GET /api/ladder` | 无新增上游：复用涨停池缓存，内存按板数分组 | ths.md §1 | `server/api.js` 路由 `/api/ladder` |
| 涨停关联分析（v1.2.0） | `GET /api/limitup/related` | 无新增上游：涨停池（当日+历史回看）+ 复盘 block_top | ths.md §1/§3 | `server/api.js` 路由 `/api/limitup/related` |
| 交易状态徽章 | `GET /api/health` | 无（本地时钟，上海时区周一至五，时段窗口取 `config.server.tradingStart/End`，默认 09:15–15:05） | — | `lib/market.js#isTradingTime` |
| AI 选股助手（v1.3.0） | `POST /api/agent/chat` | 用户配置的 LLM `/chat/completions`（OpenAI 兼容）+ 10 个数据工具经 invokeRoute 复用本表全部既有路由（零新增行情上游） | —（LLM 接入见 D14） | `lib/agent.js#runAgent` + `api.js#handleAgentChat` |
| └ 历史跨日查询（v1.3.0） | 同上（history_overview / history_screen / history_co_limitup 工具） | 本地 JSON 归档 `server/data/`；涨停池/龙虎榜缺失日按 date 参数回补上游（同 ths.md §1 / eastmoney.md §11） | D15 | `lib/agent.js#execHistoryTool` + `lib/history.js` |
| └ 历史归档写入（v1.3.0） | `/api/limitup/pool` `/api/ladder` `/api/dragon-tiger` `/api/hot-rank` 写穿 + 后台采集器（周期取 `config.collection.intervalMinutes`，默认 30min） | 同对应路由上游（复用缓存，无额外请求） | D15 | `api.js#archive/collectHistory` + `lib/collector.js` + `lib/history.js#saveRecordThrottled` |
| 系统设置（v1.4.0） | `GET/PUT /api/config` | 无（本地配置库 `server/data/config.db`，node:sqlite / JSON 兜底） | —（D16） | `lib/config.js` + `lib/config-store.js` + `views/SettingsView.vue` |

**secid / fs / f 字段映射**：与接口文档 README 完全一致（`lib/market.js#secIdForStock` 复刻 app 端 `StockRepo.eastMoneyStockSecId`，含北交所前缀）。

## 5. 缓存与限速策略

> v1.4.0 起下表 TTL 为 `cache` 配置组的**默认值**，可在设置页 / `PUT /api/config` 在线调整（保存即生效，已缓存条目按旧 TTL 自然过期）；采集器周期/开关取 `collection` 组，上游超时/重试取 `http` 组（见 D16）。

| 缓存 key | 交易时段 TTL | 收盘 TTL | 单次 miss 上游请求数 |
|----------|-------------|----------|---------------------|
| `snapshot` | 30s | 10min | ≈60（6 并发） |
| `indices` | 30s | 10min | 3 |
| `kline:{code}:{days}` | 60s | 30min | 1 |
| `sectors:{type}` | 60s | 15min | 5–6 |
| `bkstocks:{bk}` | 60s | 15min | 1–4 |
| `limitup:pool:{date}` / `limitup:replay:{date}` | 2min | 30min | 1–2 / 1 |
| `ladder:{date}`（v1.2.0） | 2min | 30min | 0（复用涨停池缓存） |
| `limitup:related:{code}:{date}:{days}`（v1.2.0） | 5min | 30min | 0–≈days+2（全部经池/复盘缓存键，miss 时按对应键计数） |
| `dragontiger:{date}`（v1.2.0） | 5min | 30min | 2（东财+同花顺并行） |
| `hotrank`（v1.2.0） | 5min | 10min | 4（四平台并行） |

- 所有上游请求：超时/重试次数/退避基数取 `config.http`（默认 10s / 1 次 / 300ms×attempt），UA/Referer 见 D7；sources 层 12 处调用均走默认参数，配置对全部上游均匀生效。
- 快照个别页失败容忍（跳过该页），东财三主机 20/43/52 顺序 fallback（monitor 端同款）。
- 调试接口：`DELETE /api/cache` 清空缓存（见 api.md）。
- **Agent 工具零新增缓存键（v1.3.0）**：数据工具经 `invokeRoute` 复用本表对应路由的缓存；LLM 请求不缓存（对话语义）。LLM 单次调用超时取 `config.llm.timeoutMs`（默认 90s）。
- **归档不是缓存（v1.3.0）**：`server/data/` 为持久化落盘（重启不丢），写穿节流窗口取 `config.collection.rewriteIntervalMinutes`（默认 10min）；采集器（`lib/collector.js`）按 `config.collection` 排程（首跑延时默认 5s、周期默认 30min、分项类型开关、龙虎榜采集时点），配置变更自动重排定时器；采集复用路由缓存，不产生额外上游请求（cache miss 时按本表计数）。

## 6. 已知限制（v1）

1. **非实时推送**：数据为轮询快照（30s 级），非 SSE tick；接口文档中的 `slist/sse`、`trends2/sse` 未接入（v2 候选）。
2. **交易时段判断不含节假日**：仅按周一至五（窗口取 `config.server.tradingStart/End`，默认 09:15–15:05）判断，节假日会误判为「交易中」，影响仅限 TTL 变短。
3. **搜索依赖快照**：服务冷启动后第一次搜索需等全市场快照拉取（实测 ≈1.3s）；新浪兜底源缺 涨跌停价/市值/换手 字段（显示 `-`）。
4. **搜狐兜底 K 线盘中缺当日数据**，且无均价/涨跌停价字段。
5. **涨停中心日期需手动选择**：非交易日默认查询当天会返回空列表（UI 已给出「请选择最近交易日」提示），未实现自动回退到最近交易日。
6. **无鉴权**：服务默认仅绑定本机使用场景，未做访问控制，公网部署需自行加防护。
7. ECharts 全量引入（bundle ≈1.1MB / gzip 381KB），未做按需裁剪。
8. **选股器仅支持快照字段条件**（v1.1.0，v1.2.0 扩充）：涨跌幅/换手率/成交额/振幅/总市值/流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今/板块/ST；不支持历史条件（创新高、连板数、N 日涨幅）。快照处于新浪兜底源时，换手率/振幅/市值/估值类阈值筛选结果为空（UI 显示「兜底源」标签与空态提示，不做静默放行）。
9. **东财 clist/push2his 故障窗口**（2026-11-11 午后起实测）：clist 三主机空响应（curl 退出码 52/502），快照降级新浪，v1.2.0 新增 6 个快照字段（市盈率/市净率/量比/60日/年初至今）为 null、含其阈值的条件筛空；6 个 f 字段映射（f9/f10/f23/f24/f25/f115）的实测值**待补验证**（东财恢复后与已知值比对，如 600000 浦发银行 PE≈5–6、PB≈0.5）。push2his 同窗口故障导致总览指数卡片报错，为既有依赖、与本版本改动无关。
10. **淘股吧人气榜未接入**：tgb.cn 当前网络环境 DNS 解析失败（2026-11-11 实测），热榜为四平台合并；网络环境恢复后再评估接入。
11. **涨停复盘仅 top 20 题材组**：不在任何组的股票题材关联为空（UI 明示「该股未出现在涨停复盘分组中」），非缺陷；龙虎榜席位明细（营业部买卖前五）未展示（v2 候选）。
12. **AI 助手非流式输出**（v1.3.0）：`/api/agent/chat` 一次性返回全文，多轮工具调用 + LLM 推理的总耗时可达 10s 级（前端以「思考中」占位）；SSE 流式为 v2 候选。
13. **依赖 function-calling 能力**（v1.3.0）：所配模型须支持 OpenAI 兼容 tools 协议；不支持时模型只能凭提示词直接回答，工具轨迹为空。LLM 未配置时接口返回 503 + 配置指引，前端聊天框显示错误提示。
14. **热榜/龙虎榜归档不可回补历史**（v1.3.0）：热榜上游无日期参数，归档只能从启用当日向前积累（龙虎榜可按 date 回补但仅收盘后有数据）；「最近 N 天热榜前 50」类查询在归档积累满 N 天前只覆盖已有日期——history_overview 工具向 LLM 明示各类归档覆盖范围，提示词要求如实告知数据不足，不编造历史。
15. **Agent 无会话状态**（v1.3.0）：每次请求由前端携带完整对话历史（条数/单条字数上限取 `config.agent`，默认 ≤30 条、≤4000 字），服务端不落对话、无用户隔离（与限制 6 一致，默认本机使用）。
16. **配置 API 无鉴权**（v1.4.0）：`GET/PUT /api/config` 与其余接口一致不做访问控制（限制 6），能访问服务即可修改配置——GET 侧密钥不回显（仅 `accessTokenSet` 布尔），但 PUT 侧可覆盖 LLM 地址/采集开关等，公网部署必须自行加防护。`server.port` 修改后需重启服务才生效，且 `PORT` 环境变量优先级更高（部署逃生口）。

## 7. v2 候选（未实现，仅记录）

- 分时图 + SSE 实时推送（东财 `trends2/sse`，接口文档 eastmoney.md §3）
- 龙虎榜席位明细（营业部买卖前五，eastmoney.md §11 / ths.md §9 的席位字段）
- 淘股吧人气榜接入（当前 DNS 不可达，见 §6 限制 10）
- 板块历史 K 线（getBKHistory 用法，eastmoney.md §5）
- 自选股（localStorage）与涨跌停触发提醒
- 选股器历史条件：创 N 日新高、连板数、N 日涨幅（需 K 线批量拉取或与同花顺涨停池 join，见 D9 被否方案；v1.3.0 后涨停类历史条件已可由 AI 助手经归档回答）
- 选股结果导出（CSV）与条件收藏
- AI 助手 SSE 流式输出与多会话管理（v1.3.0 为非流式单会话，§6 限制 12/15）
- 归档数据接入语义检索（若引入研报/公告等非结构化数据，再评估向量库，D15）
