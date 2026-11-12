# web-stock · 股票行情查询 Web

基于 [`docs/stock-data-apis/`](../docs/stock-data-apis/) 接口文档实现的 A 股行情查询 Web 应用：后端为**零第三方依赖**的 Node.js 代理服务，前端为 Vue 3 + Vite + ECharts。

> ⚠️ 本项目数据全部来自公开行情接口（东方财富 / 新浪财经 / 搜狐财经 / 同花顺 / 财联社 / 大智慧），仅用于个人学习研究，请勿用于商业用途或高频请求。

---

## 功能清单（v1.4.0）

| 模块 | 功能 | 数据源 |
|------|------|--------|
| **AI 选股助手**（默认页） | 聊天框自然语言选股/查行情：「帮我筛选涨幅超过5%、换手率大于10%的创业板股票」→ LLM Agent 自动调用数据接口，回答附工具轨迹与可点击股票；支持跨日历史查询（见下节） | 用户配置的 LLM（OpenAI 兼容）+ 本服务全部接口 |
| **总览** | 三大指数（上证/深成/创业板）实时点位与涨跌 | 东财 kline（lmt=1） |
| | 全市场涨跌统计（上涨/下跌/平盘/涨停/跌停/停牌家数） | 东财 clist 全市场快照（新浪兜底） |
| | 涨幅榜 / 跌幅榜 Top20，点击跳转个股 | 同上 |
| **个股查询** | 代码/名称模糊搜索（防抖联想） | 全市场快照 |
| | 实时行情明细：最新价、涨跌、开高低收、量额、换手、振幅、总/流通市值、市盈率TTM/动、市净率、量比、60日涨幅、年初至今、涨停/跌停价、均价、上市日期 | 东财 clist（fltt=2） |
| | 日 K 线图：蜡烛图 + MA5/10/20 + 成交量副图 + 区间缩放，60/120/250/500 日切换 | 东财 push2his（前复权），搜狐 hisHq 兜底 |
| **板块排行** | 行业板块 / 概念板块实时排行，按涨跌幅/换手率/振幅/总市值排序，含涨/跌/平家数 | 东财 clist（m:90+t:2 / t:3） |
| | 板块成份股列表（点击板块展开），成份股可跳转个股 | 东财 clist（fs=b:BKxxxx） |
| **涨停中心** | 按日期查询涨停池：几天几板、涨停类型、涨停原因、首封时间、开板次数、换手率、封单、流通市值；行内「关联」按钮直达关联分析 | 同花顺 limit_up_pool |
| | 涨停复盘：按题材分组的涨停股（可折叠），标注连板数 | 同花顺 block_top |
| | 连板天梯：当日涨停股按连板数分层（最高板在前，层内 N 板 N 天优先、含首封时间） | 同花顺 limit_up_pool 派生 |
| | 关联分析：目标涨停股的题材关联（复盘同组）+ 近 N 日共同涨停统计（搜索/代码输入/池内带入） | 同花顺 limit_up_pool + block_top 派生 |
| **条件选股** | 左栏：筛选结果排序列表（点击加载 K 线）；右上：日 K 线；右下：筛选指标 | 全市场快照（东财，新浪兜底） |
| | 指标：涨跌幅/换手率/成交额/总市值/流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今 区间 + 板块过滤 + 排除 ST + 11 种排序（升/降序）+ 8 个快捷预设 | 同上（复用快照缓存，零额外上游请求） |
| **龙虎榜** | 按日期查询上榜股票：上榜原因、净买/买入/卖出额、游资/机构净买、换手率、流通市值、次日涨幅、营业部标签/概念，9 列可排序 | 东财 datacenter + 同花顺 transaction 合并 |
| **热榜** | 四平台（东财/同花顺/财联社/大智慧）人气合并排行：各平台名次与变化、热度值、人气标签、概念 | 四平台人气榜按代码聚合 |
| **系统设置**（右上角 ⚙） | 在线读写服务端配置：数据采集开关/周期、LLM 模型配置（密钥不回显）、Agent 对话上限、缓存 TTL、服务端口+交易时段、上游 HTTP 超时/重试；配置持久化到数据库，保存即热生效（端口需重启） | 本地配置库（node:sqlite，JSON 兜底） |

自动刷新：总览页每 30s（页面不可见时暂停）；后端按交易时段区分缓存 TTL（TTL 与采集周期均可在设置页调整，详见 [docs/design.md](docs/design.md)）。

## AI 选股助手

首页默认标签页。用自然语言描述需求，后端 Agent（LLM function-calling）自动选择并调用本服务的数据接口完成查询：

- **条件选股**：「筛选涨幅超过 5%、换手率大于 10% 的创业板股票」「低估值高股息的蓝筹股」
- **行情/盘面**：「今天大盘怎么样？哪些板块最热门？」「600000 现在什么价」
- **热榜/龙虎榜/涨停**：「今天热榜前 20」「龙虎榜净买入最多的股票」「5 连板以上的股票有哪些」
- **跨日历史查询**（依赖历史归档，见下）：「最近 3 天有涨停且在热榜前 50 的股票」「和 XXX 关联度最高的共同涨停股票」

回答下方附**工具调用轨迹**（调了哪些接口、命中多少条）与**可点击股票 chips**（跳转个股页）。

### LLM 配置（必需，仅服务端）

Agent 依赖用户自备的 OpenAI 兼容 LLM 服务（需支持 function-calling/tools 协议）。**access_token 只存服务端配置库，不会下发到浏览器**（接口仅返回「是否已配置」布尔值）。

**方式 1（推荐，v1.4.0）**：启动服务后打开右上角 ⚙ 设置页 →「AI 模型」，填写 模型地址 / Access Token / 模型名，保存即时生效（无需重启）。

**方式 2（legacy，仅首跑播种）**：环境变量或配置文件——v1.4.0 起仅在**数据库尚无 llm 配置时**作为种子写入数据库，此后数据库为唯一真相源（设置页可改）：

```bash
# 环境变量
LLM_MODEL_URL=https://api.example.com/v1 \
LLM_ACCESS_TOKEN=sk-xxx \
LLM_MODEL=model-name \
npm start
```

```json
// 或 server/llm.config.json（已 gitignore）
{ "modelUrl": "https://api.example.com/v1", "accessToken": "sk-xxx", "model": "model-name" }
```

`modelUrl` 填 base 地址（自动补全 `/chat/completions`）或完整地址均可。未配置时其他功能不受影响，仅聊天接口返回 503 + 配置指引。验证：`curl http://localhost:8787/api/health` 看 `llmConfigured: true`。

### 历史归档（跨日查询的数据基础）

热榜、龙虎榜、涨停池、连板天梯四类数据自动按日归档到 `server/data/`（JSON，gitignored）：接口被请求时写穿 + 后台按采集周期定时采集一轮（开关/周期/分项类型均可在设置页配置）。涨停池/龙虎榜支持按日期回补历史；**热榜上游无历史接口，归档只能从首次运行起向前积累**——积累不足时助手会如实说明覆盖范围，不会编造历史数据。详见 [docs/design.md](docs/design.md) D15。

## 系统设置

页面右上角 ⚙ 齿轮按钮进入设置页（v1.4.0），可在线读写服务端全部可调参数：

| 分组 | 可配项 |
|------|--------|
| 数据采集 | 总开关、采集周期（分钟）、启动首跑延时、归档写穿节流窗口、龙虎榜采集时点（小时）、四类数据（涨停池/连板天梯/热榜/龙虎榜）分项开关 |
| AI 模型 | 启用开关、模型地址、Access Token（密钥）、模型名、请求超时、temperature、maxTokens |
| Agent 对话 | 工具调用最大轮数、消息条数上限、单条字数上限 |
| 缓存 TTL | 10 个缓存键的 交易时段/收盘后 双档 TTL（秒） |
| 服务 | 端口、交易时段起止（HH:MM） |
| 上游 HTTP | 请求超时、重试次数、重试退避基数 |

- **存储**：配置持久化在 `server/data/config.db`（Node 内置 `node:sqlite`，需 Node ≥ 22.5；旧版 Node 自动回退 `server/data/config.json`，功能一致，启动日志会打印实际后端）。`server/data/` 已 gitignore，密钥不落仓库。
- **密钥不回显**：`GET /api/config` 永不返回 Access Token 原文，只返回 `accessTokenSet` 布尔；设置页 Token 输入框留空 = 保持不变、填值 = 覆盖、勾选「清除已存 Token」= 删除。
- **生效时机**：除**端口需重启服务**外（`PORT` 环境变量仍优先于数据库，作为部署逃生口），其余配置保存即热生效——采集周期/开关变化自动重排定时器，TTL/HTTP/LLM/Agent 参数下次请求即用新值。
- 也可直接调 API 读写：`GET /api/config` / `PUT /api/config`（部分合并语义 + 逐字段校验，见 [docs/api.md](docs/api.md) §19–§20）。

## 快速开始

```bash
# 1. 启动后端（需 Node >= 18，零依赖，无需 npm install；
#    配置库使用 Node 内置 sqlite 需 >= 22.5，旧版自动回退 JSON 文件，功能一致）
cd server
npm start                 # 默认端口 8787；可用 PORT 环境变量覆盖（优先于设置页端口），
                          # 或设置页改端口后重启生效
                          # AI 选股助手需在设置页配置 LLM（或首跑前设 LLM_* 环境变量播种），
                          # 见「AI 选股助手」节

# 2a. 生产模式：构建前端后由后端统一托管
cd web
npm install
npm run build             # 产物输出到 web/dist，后端自动托管
# 浏览器访问 http://localhost:8787

# 2b. 开发模式：Vite dev server（已配置 /api 代理到 8787）
cd web
npm install
npm run dev               # 浏览器访问 http://localhost:5173
```

验证服务是否正常：

```bash
curl http://localhost:8787/api/health
curl "http://localhost:8787/api/quote?code=600000"
```

## 目录结构

```
web-stock/
├── README.md               # 本文件
├── docs/
│   ├── design.md           # 需求范围、架构设计、技术决策、数据源映射（可回溯）
│   ├── api.md              # 后端 REST 接口文档（请求/响应/错误码/示例）
│   └── changelog.md        # 变更记录与验证记录
├── server/                 # Node.js 后端（零第三方依赖，ESM）
│   ├── index.js            # 入口：配置初始化 + HTTP 服务 + 静态托管 + API 路由分发 + 采集器启动
│   ├── api.js              # /api/* 路由：校验 → 缓存(config.cache) → 数据源 → 统一响应（+归档写穿 /api/agent/chat /api/config）
│   ├── data/               # 运行期数据（gitignored）：config.db 配置库 + 历史归档 {limitup,hotrank,dragontiger,ladder}/{yyyyMMdd}.json
│   ├── llm.config.json     # LLM 配置种子（可选 legacy：仅首次运行播种到配置库，含 access_token，gitignored）
│   ├── lib/
│   │   ├── config-store.js # 配置存储：node:sqlite（主）/ JSON 文件（兜底）自动探测（v1.4.0）
│   │   ├── config.js       # 配置中心：6 组默认值/校验/热更新/密钥掩码（v1.4.0）
│   │   ├── collector.js    # 后台历史采集器：按 config.collection 排程、配置变更自动重排（v1.4.0）
│   │   ├── http.js         # 上游请求封装（UA/Referer/超时/重试，参数取 config.http）
│   │   ├── cache.js        # 内存 TTL 缓存（带 in-flight 去重）
│   │   ├── market.js       # 交易时段（窗口取 config.server）、secid 映射、板块归属、涨跌停幅度
│   │   ├── util.js         # 并发控制、数值归一化、时间格式化
│   │   ├── llm.js          # OpenAI 兼容 chat/completions 客户端（配置取 config.llm，v1.3.0）
│   │   ├── agent.js        # Agent 循环：系统提示词 + 13 工具定义 + 结果压缩 + 历史 join（v1.3.0）
│   │   └── history.js      # JSON 历史归档：原子写/节流（窗口取 config.collection）/日期窗口（v1.3.0）
│   └── sources/            # 上游数据源（每个文件对应一个数据源）
│       ├── eastmoney.js    # 东财：快照/K线/板块/成份股/指数/龙虎榜/人气榜
│       ├── sina.js         # 新浪：全市场快照（兜底）
│       ├── sohu.js         # 搜狐：历史日 K（兜底）
│       ├── ths.js          # 同花顺：涨停池/涨停复盘/龙虎榜/热股榜
│       ├── cls.js          # 财联社：热股榜（固定 sign）
│       └── dzh.js          # 大智慧：人气榜
└── web/                    # Vue 3 前端（Vite 构建）
    ├── vite.config.js      # dev 代理 /api → localhost:8787
    └── src/
        ├── App.vue         # 根组件：导航 + 交易状态徽章 + 设置齿轮入口
        ├── api.js          # fetch 封装（响应信封解析，GET/POST/PUT）
        ├── store.js        # 跨视图共享状态（activeTab 默认 chat/selectedCode）
        ├── utils/format.js # 数值格式化（红涨绿跌 class 等）
        ├── components/
        │   ├── KLineChart.vue    # ECharts 蜡烛图组件
        │   ├── LimitUpLadder.vue # 连板天梯（涨停中心子页）
        │   └── LimitUpRelated.vue# 涨停关联分析（涨停中心子页）
        └── views/
            ├── ChatView.vue       # AI 选股助手（默认标签页，v1.3.0）
            ├── OverviewView.vue   # 总览
            ├── StockView.vue      # 个股查询
            ├── SectorView.vue     # 板块排行
            ├── LimitUpView.vue    # 涨停中心（池/复盘/天梯/关联 四子页）
            ├── ScreenerView.vue   # 条件选股（左列表/右上K线/右下指标）
            ├── DragonTigerView.vue# 龙虎榜
            ├── HotRankView.vue    # 热榜
            └── SettingsView.vue   # 系统设置（齿轮入口，6 组配置表单，v1.4.0）
```

## 文档索引（可回溯）

- [docs/design.md](docs/design.md) — 需求范围、架构图、技术决策记录（含每条决策的理由与被否方案）、**功能 → 上游接口 → 接口文档出处**的完整映射表、缓存与限速策略、已知限制
- [docs/api.md](docs/api.md) — 后端 16 个查询接口 + 1 个 AI 对话接口（POST /api/agent/chat）+ 2 个配置接口（GET/PUT /api/config）+ 1 个调试接口的完整文档（参数、响应结构、错误码、curl 示例）
- [docs/changelog.md](docs/changelog.md) — 版本变更记录与每次发布的验证记录（实测数据样例）
- 上游接口文档：[`../docs/stock-data-apis/`](../docs/stock-data-apis/)（本项目实现的唯一依据）
