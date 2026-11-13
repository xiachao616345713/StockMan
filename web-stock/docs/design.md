# web-stock 设计文档

> 版本：v1.6.0 · 日期：2026-11-12 · 状态：已实现并验证
> 本文档记录需求范围、架构、技术决策与数据源映射，作为实现的可回溯依据。
> 上游接口出处统一引用 [`../../docs/stock-data-apis/`](../../docs/stock-data-apis/)（下文简称「接口文档」）。
> LLM 接入（v1.3.0）不依赖接口文档，配置与决策见 D14；配置持久化与设置页（v1.4.0）见 D16；会话持久化与流式可观测（v1.5.0）见 D17/D18；归档直读与收盘长缓存（v1.6.0）见 D19。

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
| F11 | 系统设置（v1.4.0） | 服务端配置持久化到数据库（node:sqlite，JSON 兜底）+ 右上角 ⚙ 设置页在线读写：数据采集开关/周期、LLM 配置（密钥不回显）、Agent 对话上限、缓存 TTL、服务端口+交易时段、上游 HTTP 超时/重试/按主机限流（v1.6.1）；除端口外保存即热生效 |
| F12 | AI 会话持久化与可观测（v1.5.0） | 会话/消息/调用链路服务端落库 + 多会话管理（首条消息自动标题、重命名、删除、上限 100 修剪），切页/刷新不丢；`/api/agent/chat` 改 **SSE 流式**（思考过程/回答逐字推送、工具进度实时可见、客户端断开即中止）；**调用链路看板**（每轮 LLM 输入输出/tokens/耗时 + 工具参数/结果预览）与**系统提示词/工具清单**查看页 |
| F13 | 归档直读与收盘长缓存（v1.6.0） | 涨停池/连板天梯/龙虎榜/热榜的**历史日期**请求优先读本地归档（命中零上游请求，`meta.fromArchive`）；热榜新增 `date` 参数（上游无历史接口，归档缺失如实 404）；收盘后缓存默认 24h（龙虎榜 1h、空列表 30min 封顶），实际过期**封顶到下一交易日开盘**，昨日数据「直接查」不再打扰上游 |

**明确不做**（v1 范围外，理由见 §6 已知限制）：行情分时/SSE tick 流（AI 对话输出自 v1.5.0 为 SSE 流式，见 D18，两者不同）、自选股与账号体系。~~历史数据落库~~ → v1.3.0 已实现**按日 JSON 归档**（热榜/龙虎榜/涨停池/连板天梯，见 D15），但仍非全量行情库（分时/tick 级落库继续不做）。

## 2. 架构

```
浏览器 (Vue 3 SPA, web/dist)
   │  fetch /api/*  (JSON 信封: {data, meta} / {error})
   ▼
Node.js 服务 (server/, 零第三方依赖, 端口 config.server.port 默认 8787)
   ├── index.js      入口：配置初始化(v1.4.0) + 会话存储初始化(v1.5.0) + HTTP 服务：/api/* 路由分发 + web/dist 静态托管(SPA fallback) + 采集器启动
   ├── api.js        路由层：参数校验 → TTL 缓存(config.cache) → 数据源 → 响应包装
   │                 v1.3.0 增：invokeRoute(进程内路由复用) / 归档写穿 / POST /api/agent/chat / collectHistory
   │                 v1.4.0 增：GET·PUT /api/config(读取/热更新配置)
   │                 v1.5.0 增：/api/agent/chat 重写为 SSE 流式 / 会话 CRUD / meta / traces 路由
   │                 v1.6.0 增：历史日期归档直读(tryArchive) / 收盘 TTL 封顶下一交易日开盘 / hot-rank date 参数
   ├── lib/          http(上游请求封装·config.http) cache(TTL+去重·TTL 可按结果定值 v1.6.0) market(交易时段·下一开盘秒数·config.server/secid) util
   │   ├── config-store.js 配置存储：node:sqlite(主)/JSON(兜底) 自动探测（server/data/config.db，v1.4.0）
   │   ├── config.js       配置中心：6 组 schema/校验/热更新/密钥掩码（v1.4.0）
   │   ├── collector.js    历史采集定时器：按 config.collection 排程、onChange 自动重排（v1.4.0，自 index.js 抽出）
   │   ├── chat-store.js   会话存储：会话/消息/trace 三表，node:sqlite(主)/JSON(兜底)，上限 100 会话修剪（server/data/chat.db，v1.5.0）
   │   ├── llm.js      OpenAI 兼容 chat/completions 客户端（配置取 config.llm，token 仅服务端，v1.3.0；v1.5.0 增 SSE 流式 chatCompletionsStream）
   │   ├── agent.js    Agent 循环：系统提示词 + 13 工具定义 + 工具结果压缩 + 3 个历史 join 工具（v1.3.0；v1.5.0 事件化 emit + rounds 链路记录 + getAgentMeta）
   │   └── history.js  JSON 历史归档：原子写/节流(config.collection)/日期窗口/概览（server/data/，v1.3.0；v1.6.0 增 loadRecordWithMeta 供路由归档直读）
   ├── data/         配置库 config.db(v1.4.0) + 会话库 chat.db(v1.5.0) + 历史归档 {limitup,hotrank,dragontiger,ladder}/{yyyyMMdd}.json（运行期生成，gitignored）
   └── sources/      eastmoney(主源/龙虎榜/人气) sina(快照兜底) sohu(K线兜底)
                     ths(涨停/龙虎榜/热榜) cls(热榜) dzh(热榜)
                          │  fetch + UA/Referer + 超时/重试(config.http)
                          ▼
        上游公开行情接口（东财 / 新浪 / 搜狐 / 同花顺）    +    用户配置的 LLM 服务（OpenAI 兼容，v1.3.0）
```

- **前后端同端口部署**：生产模式后端直接托管 `web/dist`；开发模式 Vite dev server（5173）将 `/api` 代理到 8787。
- **数据流**：视图 → `src/api.js`（信封解析）→ 后端 `api.js`（校验+缓存）→ `sources/*`（归一化）→ 上游。所有上游字段差异（缩放、单位、`'-'` 占位、`%` 后缀）在 sources 层归一化，前端只见统一结构。
- **Agent 数据流（v1.3.0，v1.5.0 改流式）**：ChatView（状态在模块级 `chatStore.js` 单例，tab 切换不丢）→ `POST /api/agent/chat`（SSE，body `{sessionId, message}`）→ 历史由服务端从 `chat-store` 加载（最近 `agent.maxMessages-1` 条，前端不再携带）→ `agent.js#runAgent` 事件循环（LLM ↔ 工具，轮数上限 config.agent.maxRounds；`reasoning`/`content`/`tool_call`/`tool_result` 逐段推送）→ 数据工具经 `invokeRoute` 复用既有路由（共享校验与 TTL 缓存）/ 历史工具读 `data/` 归档 → `done` 后消息与 trace 落库；客户端断开 → AbortController 链中止，半截回答不落库（D17/D18）。
- **可观测数据流（v1.5.0）**：消息尾「🔗 调用链路」→ `GET /api/agent/traces/{id}` → TracePanel 按轮展示（输入消息数/思考/输出/tokens/工具参数与结果预览）；「📋 系统提示词与工具」→ `GET /api/agent/meta` → AgentMetaDialog（提示词全文 + 13 工具定义含参数 Schema）。
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
- **决策**：同一 key 交易时段/收盘后使用不同 TTL（v1.4.0 起为 `cache` 配置组，v1.6.0 默认 交易 30s–5min / 收盘 24h，龙虎榜收盘 1h，见 §5 表）；并发请求同 key 只触发一次上游拉取。
- **理由**：对公开接口保持克制；收盘后数据不变，长 TTL 无副作用。交易时段判断为宽松规则（周一至五 09:15–15:05 上海时区，不识别节假日），仅影响 TTL 选择，误判无业务风险。
- **v1.6.0 更新（D19）**：收盘 TTL 的实际过期时间**封顶到下一交易日开盘**——长 TTL 的正确性前提，否则周一盘前会命中上周五旧快照。

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
- **决策**：涨停池/热榜/龙虎榜/连板天梯四类数据按日落盘 `server/data/{type}/{yyyyMMdd}.json`（结构 `{type,date,savedAt,data}`，data 与路由响应同构）。**写入双通道**：① 路由写穿——4 个路由请求成功后 fire-and-forget 归档，10min 节流防抖动；② 后台采集器——启动 5s 首跑、之后每 30min 一轮（龙虎榜仅上海时间 15:00 后采集），复用路由缓存。原子写（tmp+rename）。**读取**：agent 历史工具（history_overview/history_screen/history_co_limitup）纯内存 join，无查询引擎。**回补**：涨停池/龙虎榜上游支持 date 参数——history_co_limitup 发现窗口内归档缺失时自动按日回补（批 5 并发，顺带写穿归档，实测一次补齐 7 个交易日）；**热榜上游无日期参数，不可回补，只能向前积累**。**读取路径扩展（v1.6.0，D19）**：除 agent 历史工具外，四类 REST 路由对历史日期也**归档直读**（`api.js#tryArchive`，命中零上游请求），工作日的空归档视为未命中回退上游（中途快照自愈）。
- **理由**：零第三方依赖是硬约束（D2）——`node:sqlite` 需 Node ≥ 22.5 且带 experimental 标记，chroma 需 Python 进程；数据量小（每类每日 ≈100–300 行、单文件 10–90KB，一年 ≈70MB），读文件+内存过滤毫秒级；JSON 人类可读可手工修复，按日文件天然隔离、损坏只影响单日（loadRecord 容错返回 null）；用户明确「向量库或关系库均可，chroma/sqlite 只是为了免安装」——JSON 文件同样免安装且更贴合本场景（结构化跨日 join，非语义检索，向量库无用武之地）。
- **被否方案**：node:sqlite（Node 版本门槛 + experimental，部署面收窄）；chroma（引入 Python 运行时，违背零依赖）；单独归档接口（与写穿重复）。

### D16. 配置持久化用 node:sqlite + JSON 兜底，设置页在线读写（v1.4.0）
- **决策**：服务端全部可调参数收敛为 **6 个配置组**（`collection` 采集开关/周期/类型、`llm` 模型接入、`agent` 对话上限、`cache` 10 键双档 TTL、`server` 端口/交易时段、`http` 上游超时/重试），持久化到 `server/data/config.db`（Node 内置 `node:sqlite`，表 `app_config(key, value, updated_at)`，一行一组、value 为该组 JSON）；`node:sqlite` 不可用（Node < 22.5）时自动回退 `server/data/config.json`（tmp+rename 原子写），启动日志打印实际后端。新增 `GET/PUT /api/config` 与前端设置页（右上角齿轮入口，不占导航标签）。PUT 为**部分合并语义**：按组深合并、逐字段类型/区间校验（未知组/未知字段/越界 → 400 中文 message），仅变更组落库。**密钥掩码**：`maskSecrets()` 保证 GET 永不回显 `llm.accessToken` 原文，只返回 `accessTokenSet` 布尔；PUT 对 token 采用**三态语义**——字段缺省=保持、空串=清除、非空=覆盖。**热生效模型**：内存态 `current` 整体替换，所有消费方在使用时 `getGroup()` 热读（约定禁止模块加载期缓存引用）；采集器经 `onChange` 重排定时器；仅**端口需重启**（listen 一次性），`PORT` 环境变量仍优先于数据库（部署逃生口）。**首跑播种**：库中无 `llm` 组时用 `LLM_*` env / `server/llm.config.json` 播种、无 `server` 组时用 `PORT` env 播种端口，此后数据库为唯一真相源（老部署升级不中断）。
- **理由**：改任何参数不再需要改代码/重启（端口除外），且配置有单一可审计的持久化位置；`node:sqlite` 为 Node 内置模块，**不违背 D2 零依赖**——与 D15 拒绝 sqlite 归档的语境不同：归档拒绝的是「Node ≥ 22.5 门槛收窄部署面」，此处以 JSON 兜底消除该门槛（新旧 Node 均可运行，仅存储介质不同，功能一致）；一行一组的 KV 结构让部分更新只写变更组、无需整库重写；密钥掩码在 config 层统一实现（而非各路由自行处理），沿用 D14「token 绝不下发前端」原则；校验放在写入侧（而非读取侧），保证库中值恒合法、读取方无需防御。
- **实测**：部分合并（改 `cache.snapshot.trading` 保留 `closed`）、密钥三态、7 类非法值 400、重启持久化、采集器热重排、首跑播种（env.PORT → server.port）全部通过（changelog v1.4.0 验证记录）。
- **被否方案**：better-sqlite3 / lowdb 等 npm 包（违背 D2 零依赖）；纯 env + 配置文件（无页面化读写入口，改配置仍需登录服务器改文件并重启）；复用归档 JSON 体系存配置（配置与数据生命周期不同：配置需按组部分更新+写入侧校验+密钥掩码，独立 KV 更清晰）；前端 localStorage 存配置（服务端读不到、多端不一致）；WebSocket/SSE 推送配置变更（单实例部署下 onChange 进程内通知已足够）。

### D17. 会话/消息/trace 落库 node:sqlite + JSON 兜底，服务端为唯一真相源（v1.5.0）
- **决策**：新增 `lib/chat-store.js`，三张表落 `server/data/chat.db`——`chat_sessions(id,title,created_at,updated_at)`、`chat_messages(session_id,role,content,reasoning,tool_trace,stocks,trace_id,created_at)`、`agent_traces(id,session_id,model,llm_rounds,duration_ms,data)`（data 为完整 rounds JSON）；`node:sqlite` 探测与 JSON 兜底（`server/data/chat.json`，tmp+rename 原子写）沿用 config-store 模式（D16），启动日志打印实际后端。会话上限 **100**，新建时修剪最旧（级联删消息与 trace）。`POST /api/agent/chat` 请求体由 v1.3.0 的「前端携带完整 messages 数组」改为 `{sessionId, message}`：历史由服务端从库中加载（最近 `agent.maxMessages-1` 条 user/assistant），user 消息**即时落库**、assistant 消息在流结束后连同 reasoning/toolTrace/stocks/traceId 落库；首条消息自动作会话标题（截 30 字）。前端 `chatStore.js` 为**模块级单例**状态（tab 经 `<component :is>` 切换会卸载组件，局部 ref 即丢——此为 v1.3.0「切页对话消失」的根因），localStorage 记忆活动会话 id，刷新后从服务端恢复。
- **理由**：模块级状态只解决「切页不丢」，刷新/关浏览器仍需持久化；服务端存储让 会话列表/标题/消息/trace 有同一真相源，多端打开一致，且 trace 与消息同库关联（traceId）支撑调用链路看板；复用 D16 已验证的存储模式零新增部署门槛。
- **断开落库语义**：客户端中止时 **user 消息保留落库、assistant 半截回答与 trace 不落**——用户的问题是下一轮历史的有效输入，半截回答会污染历史且误导用户（前端对已推送的部分内容标注「已停止」）。
- **被否方案**：纯前端 localStorage 持久化（服务端不可见、trace 无法关联、换设备即丢）；每会话独立 JSON 文件（列表/修剪需扫目录，不如单库）；不存 user 消息于中止场景（丢失有效历史）。

### D18. SSE 流式输出 + 全链路可观测（v1.5.0）
- **决策**：`/api/agent/chat` 响应改为 `text/event-stream`，**8 类事件**：`session`（会话确认+标题）/ `round_start` / `reasoning`（思考增量）/ `content`（回答增量）/ `tool_call`（工具即将执行，参数完整）/ `tool_result`（状态/摘要/耗时）/ `done`（汇总+traceId，**不带 rounds**——体积大，看板按 traceId 走 `GET /api/agent/traces/{id}` 拉取）/ `error`。两阶段错误：流开始前（参数/会话/LLM 未配置）走 JSON 信封 400/404/503，流开始后走 `error` 事件。`llm.js#chatCompletionsStream` 以 `stream:true` 调上游并解析 SSE 帧：`content`/`reasoning_content` 增量回调，`tool_calls` 按 `delta.index` 聚合 id/name/arguments 分片（缺 id 兜底 `call_stream_N`）。`runAgent` 每轮记录 `rounds[]`（inputMessages/reasoning/content/usage/durationMs/toolCalls[args/status/summary/durationMs/resultPreview ≤1500 字]）落 `agent_traces`，TracePanel 按轮展示——评估**模型输入输出质量、工具选择正确性、工具参数正确性**的直接材料；`GET /api/agent/meta` 返回系统提示词全文 + 13 工具定义（含参数 JSON Schema）。**断开检测**：监听 `res` 的 `'close'`（实测 `req` 的 `'close'` 在 POST 请求体读完后即触发，不可用），以 `writableEnded` 区分正常收尾；AbortController 链贯穿 前端 fetch abort → 服务端 res close → 上游 LLM fetch abort。
- **理由**：多轮工具调用 + 推理总耗时 10s 级（原限制 12），逐字推送思考与工具进度把「黑盒等待」变为可观测过程；SSE over POST（EventSource 不支持 POST → 前端 fetch + ReadableStream 手工分帧），零第三方依赖（D2）；`X-Accel-Buffering: no` 保证反代场景逐字透传。
- **被否方案**：WebSocket（需依赖或复杂握手，单向推送场景 SSE 足够）；维持非流式 + 前端假进度（用户明确要求本期做流式）；trace 存完整工具结果（token 体积失控，1500 字预览 + 摘要足够评估，完整数据可按参数重放）。

### D19. 历史日期归档直读 + 收盘长缓存封顶下一交易日开盘（v1.6.0）
- **背景（用户诉求）**：「人气热榜、龙虎榜、连板天梯、涨停池，每天收盘之后实际都是静态的，应当支持每日永久保存，这样我如果需要昨日的数据，你可以直接查。其他行情缓存时间应当支持也更长的缓存时间，收盘之后无变化所以需要」。归档自 v1.3.0 已永久保存（D15 无清理策略），但只被 agent 历史工具读取，REST 路由历史日期仍打上游；收盘 TTL 上限仅 2h。
- **决策 ①（归档直读）**：四类路由收到**早于今天（上海）**的日期时先读本地归档（`api.js#tryArchive` → `lib/history.js#loadRecordWithMeta`），命中即返回——零上游请求，`meta.fromArchive=true` + `archiveSavedAt`。热榜新增可选 `date` 参数：上游无历史热榜接口，历史日期**只能由归档提供**，缺失时如实 404（不编造、不以「最近一份」冒充）。**工作日空归档视为未命中**回退上游（可能是盘前/龙虎榜发布前的中途快照；回退成功后写穿覆盖为终态 = 自愈），**周末空归档照常返回**（非交易日占位，避免节假日反复拉上游）。天梯归档缺失但池归档存在时，由池归档派生天梯，仍零上游；关联分析的历史回看同样经 `getLimitUpPool` 受益。归档命中不再重复写穿。
- **决策 ②（收盘长缓存 + 开盘封顶）**：`cache.*.closed` 默认调至 24h（86400s），校验上限放宽为 trading 5–7200 / closed 5–86400；**实际过期时间封顶到下一交易日开盘**——`cacheTtl = min(closed, secondsUntilNextTradingStart())`（`lib/market.js`，上海固定 UTC+8 无夏令时，开盘时刻可精确计算；仅识别工作日，节假日同 D6 宽松语义）。两个例外：**龙虎榜** closed 默认 1h（收盘后约 17:00 才发布，傍晚经历「空→有」）；**空龙虎榜列表** TTL 封顶 30min（`lib/cache.js` 的 ttlMs 支持按结果定值的函数形式），防止发布前的空结果被长缓存挡住真数据。
- **理由**：收盘后四类数据为终态，归档直读省上游、毫秒级响应，且「昨日数据直接查」对 REST/前端/AI 助手三条路径同时生效；长 TTL 的正确性前提是**次日开盘前必须过期**——snapshot/indices/hotrank/kline 等缓存键不含日期，24h TTL 会跨过开盘边界（周一盘前命中上周五快照），封顶到开盘时刻以一行 min() 消除该缺陷；含日期的键（`limitup:pool:{date}`）天然按日隔离，归档直读进一步归零上游。
- **取舍**：采集器复用路由缓存（D15），收盘长缓存期间采集轮命中内存缓存、重复归档同一份终态值（10min 节流、无上游成本，可接受）；节假日不识别——节假日的「下一开盘」按工作日规则计算，TTL 只会偏短不会偏长（安全方向）；涨停复盘（replay）不在四类归档之列，历史日期仍走上游。
- **被否方案**：短 TTL + 条件请求（上游不支持 ETag/Last-Modified）；24h TTL 不封顶开盘（周一盘前读上周五快照，正确性缺陷）；历史热榜缺失时返回最近一份归档（以旧充新属语义编造，与 D15「不编造历史」原则冲突）；为归档引入查询引擎/数据库（JSON 文件 + 内存 join 已覆盖，D15 已论证）。


### D20. 上游按主机限流 + 全链路失败日志（v1.6.1）
- **背景（用户诉求）**：「当前对话中出现返回空导致失败的问题，可能是接口频繁访问的原因。1. 如果失败了需要打印一下日志看看 2. 行情的接口可能存在调用频率限制导致调用失败，需要调整一下调用频率，并增加频率值配置」。排查发现两类盲区：① 多处失败被静默容忍（快照分页 `catch {}`、agent 工具异常只进 trace 不进进程日志、LLM 坏 chunk 直接跳过、热榜/龙虎榜单平台失败只写 meta），「返回空」无从定位；② 快照 ≈60 页 6 并发、历史回补批 5 并发都是瞬时突发，易触发上游隐性频率限制（表现为空数据/拒连）。
- **决策 ①（按主机限流）**：`lib/http.js` 内置每主机限流器（FIFO 队列）：`maxConcurrent`（同主机并发在途上限，默认 4）+ `minIntervalMs`（同主机相邻请求启动最小间隔，默认 100ms），参数入 `config.http` 组（设置页可调、热生效；校验 0–10000 / 1–32）。所有上游请求（sources 层 12 处 + 重试）经 `fetchText` 单点过闸，对 sources 透明；限流器进程内常驻、按 host 归组（东财三主机各自计数，与 fallback 语义正交）。
- **决策 ②（失败日志）**：`http.js` 每次尝试失败打 `console.warn`（URL/轮次/HTTP 状态/响应体摘录 200 字符——限流页常在响应体说明原因）；`eastmoney.js` 快照分页失败逐页留痕 + 汇总不完整告警 + **空快照抛错**（不再向下输出空列表，转新浪兜底或回填模型错误）；`llm.js` 统计坏 chunk（数量+首例摘录），content/reasoning/tool_calls/usage 全空时告警；`agent.js` 工具异常/工具级 error/空回答/达到轮数上限均落进程日志；`api.js` 热榜/龙虎榜单平台降级、关联分析单日回补失败留痕。
- **理由**：全部上游经 http.js 单点出入，限流放这里一处生效、零 sources 改动；「返回空」的每个可能来源（上游空响应/坏 chunk/工具失败/模型空输出）都有对应日志锚点，问题可回放。默认 100ms×4 并发把快照刷新从「瞬时 60 连发」平滑为 ≈6–8s 拉取，仍在交易时段 30s TTL 预算内。
- **取舍**：按主机而非全局限流（不同上游互不挤占，代价是极端场景总并发 = 主机数×4）；minIntervalMs 约束「启动间隔」而非「完成间隔」（实现简单，慢请求自然被并发上限兜住）；限流参数改动只影响后续排队（在途请求不重排）；未做 429 Retry-After 感知（上游限流多为空数据/拒连而非标准 429，重试退避 + 限流已覆盖）。
- **被否方案**：token bucket 全局限流（无法表达「单上游克制、多上游并行」的实际需要）；在 sources 层各自 sleep（12 处重复实现且重试路径绕过）；只加日志不限流（用户明确要求「调整调用频率并增加频率值配置」）。

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
| AI 选股助手（v1.3.0，v1.5.0 改 SSE 流式） | `POST /api/agent/chat` | 用户配置的 LLM `/chat/completions`（OpenAI 兼容，stream:true）+ 10 个数据工具经 invokeRoute 复用本表全部既有路由（零新增行情上游） | —（LLM 接入见 D14，流式见 D18） | `lib/agent.js#runAgent` + `api.js#handleAgentChat` |
| └ 历史跨日查询（v1.3.0） | 同上（history_overview / history_screen / history_co_limitup 工具） | 本地 JSON 归档 `server/data/`；涨停池/龙虎榜缺失日按 date 参数回补上游（同 ths.md §1 / eastmoney.md §11） | D15 | `lib/agent.js#execHistoryTool` + `lib/history.js` |
| └ 历史归档写入（v1.3.0） | `/api/limitup/pool` `/api/ladder` `/api/dragon-tiger` `/api/hot-rank` 写穿 + 后台采集器（周期取 `config.collection.intervalMinutes`，默认 30min） | 同对应路由上游（复用缓存，无额外请求） | D15 | `api.js#archive/collectHistory` + `lib/collector.js` + `lib/history.js#saveRecordThrottled` |
| └ 历史日期归档直读（v1.6.0） | 同上四路由，`date` 早于今天时优先读 `server/data/` 归档（热榜经新增 `date` 参数；agent 数据工具经 invokeRoute 同样受益） | 无上游（命中零请求；未命中回退对应路由上游，热榜无可回退 → 如实 404） | D19 | `api.js#tryArchive` + `lib/history.js#loadRecordWithMeta` |
| 系统设置（v1.4.0） | `GET/PUT /api/config` | 无（本地配置库 `server/data/config.db`，node:sqlite / JSON 兜底） | —（D16） | `lib/config.js` + `lib/config-store.js` + `views/SettingsView.vue` |
| AI 会话持久化（v1.5.0） | `GET·POST /api/agent/sessions` + `GET·PUT·DELETE /api/agent/sessions/{id}` | 无（本地会话库 `server/data/chat.db`，node:sqlite / JSON 兜底） | —（D17） | `lib/chat-store.js` + `src/chatStore.js` |
| 调用链路看板（v1.5.0） | `GET /api/agent/traces/{id}` | 无（本地 trace 落库，runAgent rounds 记录） | —（D18） | `api.js#handleGetTrace` + `components/TracePanel.vue` |
| 系统提示词与工具清单（v1.5.0） | `GET /api/agent/meta` | 无（进程内 agent 定义） | —（D18） | `lib/agent.js#getAgentMeta` + `components/AgentMetaDialog.vue` |

**secid / fs / f 字段映射**：与接口文档 README 完全一致（`lib/market.js#secIdForStock` 复刻 app 端 `StockRepo.eastMoneyStockSecId`，含北交所前缀）。

## 5. 缓存与限速策略

> v1.4.0 起下表 TTL 为 `cache` 配置组的**默认值**，可在设置页 / `PUT /api/config` 在线调整（保存即生效，已缓存条目按旧 TTL 自然过期）；采集器周期/开关取 `collection` 组，上游超时/重试取 `http` 组（见 D16）。
> v1.6.0 起（D19）：`*` 收盘 TTL 的**实际过期时间封顶到下一交易日开盘**（周一盘前不会命中上周五旧快照）；涨停池/天梯/龙虎榜/热榜的**历史日期**（早于今天）请求优先**归档直读**——命中零上游请求（`meta.fromArchive=true`），工作日空归档回退上游自愈。

| 缓存 key | 交易时段 TTL | 收盘 TTL | 单次 miss 上游请求数 |
|----------|-------------|----------|---------------------|
| `snapshot` | 30s | 24h* | ≈60（6 并发） |
| `indices` | 30s | 24h* | 3 |
| `kline:{code}:{days}` | 60s | 24h* | 1 |
| `sectors:{type}` | 60s | 24h* | 5–6 |
| `bkstocks:{bk}` | 60s | 24h* | 1–4 |
| `limitup:pool:{date}` / `limitup:replay:{date}` | 2min | 24h* | 1–2 / 1（历史日期归档命中为 0） |
| `ladder:{date}`（v1.2.0） | 2min | 24h* | 0（复用涨停池缓存；历史日期归档直读） |
| `limitup:related:{code}:{date}:{days}`（v1.2.0） | 5min | 24h* | 0–≈days+2（全部经池/复盘缓存键，miss 时按对应键计数；历史池归档命中为 0） |
| `dragontiger:{date}`（v1.2.0） | 5min | 1h*（空列表封顶 30min，17:00 发布语义） | 2（东财+同花顺并行；历史日期归档命中为 0） |
| `hotrank`（v1.2.0） | 5min | 24h* | 4（四平台并行；历史日期不走本键，归档直读或 404） |

- 所有上游请求：超时/重试次数/退避基数取 `config.http`（默认 10s / 1 次 / 300ms×attempt），UA/Referer 见 D7；sources 层 12 处调用均走默认参数，配置对全部上游均匀生效。
- **按主机限流（v1.6.1，D20）**：同一上游主机相邻请求启动间隔 ≥ `http.minIntervalMs`（默认 100ms）、并发在途 ≤ `http.maxConcurrent`（默认 4），在 `lib/http.js` 单点生效（含重试）；快照分页/历史回补等突发流量被平滑，防上游隐性频率限制（触发后表现为空数据/拒连）。每次失败尝试均打 `console.warn`（URL/轮次/状态/响应体摘录）。
- 快照个别页失败容忍（跳过该页），东财三主机 20/43/52 顺序 fallback（monitor 端同款）。
- 调试接口：`DELETE /api/cache` 清空缓存（见 api.md）。
- **Agent 工具零新增缓存键（v1.3.0）**：数据工具经 `invokeRoute` 复用本表对应路由的缓存；LLM 请求不缓存（对话语义）。LLM 单次调用超时取 `config.llm.timeoutMs`（默认 90s）。
- **归档不是缓存（v1.3.0）**：`server/data/` 为持久化落盘（重启不丢、永久保存无清理策略），写穿节流窗口取 `config.collection.rewriteIntervalMinutes`（默认 10min）；采集器（`lib/collector.js`）按 `config.collection` 排程（首跑延时默认 5s、周期默认 30min、分项类型开关、龙虎榜采集时点），配置变更自动重排定时器；采集复用路由缓存，不产生额外上游请求（cache miss 时按本表计数）。**v1.6.0 起归档同时是历史日期的第一读取层**（D19 归档直读）：早于今天的四类请求命中归档即返回，不经过 TTL 缓存层与上游。
- **会话/trace 是持久化数据不是缓存（v1.5.0）**：会话/消息/调用链路落 `server/data/chat.db`（JSON 兜底 `chat.json`），不经 TTL 缓存层；会话数上限 100 自动修剪（D17），LLM 流式请求不缓存（对话语义）。

## 6. 已知限制（v1）

1. **非实时推送**：数据为轮询快照（30s 级），非 SSE tick；接口文档中的 `slist/sse`、`trends2/sse` 未接入（v2 候选）。
2. **交易时段判断不含节假日**：仅按周一至五（窗口取 `config.server.tradingStart/End`，默认 09:15–15:05）判断，节假日会误判为「交易中」，影响仅限 TTL 变短。v1.6.0 的「下一交易日开盘」封顶（D19）同样只识别工作日——节假日后的「下一开盘」会被算早，TTL 只会偏短不会偏长（安全方向）。
3. **搜索依赖快照**：服务冷启动后第一次搜索需等全市场快照拉取（实测 ≈1.3s）；新浪兜底源缺 涨跌停价/市值/换手 字段（显示 `-`）。
4. **搜狐兜底 K 线盘中缺当日数据**，且无均价/涨跌停价字段。
5. **涨停中心日期需手动选择**：非交易日默认查询当天会返回空列表（UI 已给出「请选择最近交易日」提示），未实现自动回退到最近交易日。
6. **无鉴权**：服务默认仅绑定本机使用场景，未做访问控制，公网部署需自行加防护。
7. ECharts 全量引入（bundle ≈1.1MB / gzip 381KB），未做按需裁剪。
8. **选股器仅支持快照字段条件**（v1.1.0，v1.2.0 扩充）：涨跌幅/换手率/成交额/振幅/总市值/流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今/板块/ST；不支持历史条件（创新高、连板数、N 日涨幅）。快照处于新浪兜底源时，换手率/振幅/市值/估值类阈值筛选结果为空（UI 显示「兜底源」标签与空态提示，不做静默放行）。
9. **东财 clist/push2his 故障窗口**（2026-11-11 午后起实测）：clist 三主机空响应（curl 退出码 52/502），快照降级新浪，v1.2.0 新增 6 个快照字段（市盈率/市净率/量比/60日/年初至今）为 null、含其阈值的条件筛空；6 个 f 字段映射（f9/f10/f23/f24/f25/f115）的实测值**待补验证**（东财恢复后与已知值比对，如 600000 浦发银行 PE≈5–6、PB≈0.5）。push2his 同窗口故障导致总览指数卡片报错，为既有依赖、与本版本改动无关。
10. **淘股吧人气榜未接入**：tgb.cn 当前网络环境 DNS 解析失败（2026-11-11 实测），热榜为四平台合并；网络环境恢复后再评估接入。
11. **涨停复盘仅 top 20 题材组**：不在任何组的股票题材关联为空（UI 明示「该股未出现在涨停复盘分组中」），非缺陷；龙虎榜席位明细（营业部买卖前五）未展示（v2 候选）。
12. **流式回答无断线续传**（v1.5.0，原「AI 助手非流式输出」已解决）：SSE 为一次性推送（无 Last-Event-ID 续传），网络中断/页面刷新后无法恢复已推送的部分内容；客户端中止时 user 消息落库、assistant 半截回答不落库（D17 断开落库语义），该轮问答在历史中只有提问没有回答。
13. **依赖 function-calling 能力**（v1.3.0）：所配模型须支持 OpenAI 兼容 tools 协议；不支持时模型只能凭提示词直接回答，工具轨迹为空。LLM 未配置时接口返回 503 + 配置指引，前端聊天框显示错误提示。
14. **热榜/龙虎榜归档不可回补历史**（v1.3.0）：热榜上游无日期参数，归档只能从启用当日向前积累（龙虎榜可按 date 回补但仅收盘后有数据）；「最近 N 天热榜前 50」类查询在归档积累满 N 天前只覆盖已有日期——history_overview 工具向 LLM 明示各类归档覆盖范围，提示词要求如实告知数据不足，不编造历史。v1.6.0 的 `GET /api/hot-rank?date={历史日期}`（归档直读）受同一约束：归档缺失返回 404 + 覆盖范围说明（D19）。
15. **会话保留上限与无隔离**（v1.5.0，原「Agent 无会话状态」已解决）：会话最多保留 100 个（超出在新建时自动修剪最旧，级联删消息与 trace，D17）；会话无鉴权/无用户隔离（与限制 6/16 一致，默认本机使用），能访问服务即可读写删所有会话；会话详情一次性加载全量消息（无分页），超长会话响应体积较大。
16. **配置 API 无鉴权**（v1.4.0）：`GET/PUT /api/config` 与其余接口一致不做访问控制（限制 6），能访问服务即可修改配置——GET 侧密钥不回显（仅 `accessTokenSet` 布尔），但 PUT 侧可覆盖 LLM 地址/采集开关等，公网部署必须自行加防护。`server.port` 修改后需重启服务才生效，且 `PORT` 环境变量优先级更高（部署逃生口）。

## 7. v2 候选（未实现，仅记录）

- 分时图 + SSE 实时推送（东财 `trends2/sse`，接口文档 eastmoney.md §3）
- 龙虎榜席位明细（营业部买卖前五，eastmoney.md §11 / ths.md §9 的席位字段）
- 淘股吧人气榜接入（当前 DNS 不可达，见 §6 限制 10）
- 板块历史 K 线（getBKHistory 用法，eastmoney.md §5）
- 自选股（localStorage）与涨跌停触发提醒
- 选股器历史条件：创 N 日新高、连板数、N 日涨幅（需 K 线批量拉取或与同花顺涨停池 join，见 D9 被否方案；v1.3.0 后涨停类历史条件已可由 AI 助手经归档回答）
- 选股结果导出（CSV）与条件收藏
- AI 会话导出（Markdown/CSV）与会话内消息分页加载；SSE 断线续传（Last-Event-ID，见 §6 限制 12）
- 归档数据接入语义检索（若引入研报/公告等非结构化数据，再评估向量库，D15）
