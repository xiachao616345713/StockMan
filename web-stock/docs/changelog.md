# web-stock 变更记录

本文件记录每个版本的功能变更与**验证记录**（实测命令与结果摘要），保证实现可回溯。

---

## v1.4.0（2026-11-12）

服务端配置持久化到数据库 + 前端设置页（F11）：数据采集开关/周期、LLM 配置、Agent 对话上限、缓存 TTL、服务端口+交易时段、上游 HTTP 超时/重试共 **6 组配置**在线读写，除端口外保存即热生效。

### 新增

**后端**
- `lib/config-store.js`：配置存储层——`node:sqlite`（主，`server/data/config.db`，表 `app_config(key, value, updated_at)` 一行一组）启动时动态探测（ExperimentalWarning 抑制），不可用（Node < 22.5）自动回退 `server/data/config.json`（tmp+rename 原子写）；启动日志打印实际后端与路径
- `lib/config.js`：配置中心——6 组 schema 与默认值（collection/llm/agent/cache/server/http）、`init()`（defaults ← 库中值深合并 + **首跑播种**：`LLM_*` env / `llm.config.json` 播种 llm 组、`PORT` env 播种 server.port，此后库为唯一真相源）、`getGroup()` 同步热读、`update(patch)`（按组深合并 → 逐字段类型/区间校验 → 仅变更组落库 → 内存态整体替换 → `onChange` 通知）、`maskSecrets()`（删除 accessToken 原文 + `accessTokenSet` 布尔）、`ConfigError`（→ 400）
- `lib/collector.js`：后台历史采集器自 index.js 内联定时器抽出——`start()` 按 `config.collection` 排程（首跑延时/周期），`onChange` 时开关/周期/延时变化自动重排定时器；`enabled=false` 时日志明示已关闭
- `GET /api/config`（掩码全量 + `meta.store` 后端/路径）与 `PUT /api/config`（部分合并语义；**密钥三态**：缺省保持 / `''` 清除 / 非空覆盖；校验失败 400 中文 message 指明字段与范围）
- 全面接入配置热读（使用时 `getGroup()`，不缓存引用）：api.js 10 处 TTL 字面量 → `cacheTtl(key)`（cache 组）；`collectHistory` 读 collection 组（enabled/types 开关、dragonTigerAfterHour 取代字面量 15）；agent 对话上限读 agent 组；llm.js 改读 llm 组（删除运行期 env/file 读取，迁移为首跑播种）；agent.js maxRounds、history.js 节流窗口、market.js 交易时段窗口、http.js 超时/重试/退避分别改读对应组；sources/* **零改动**（12 处 fetchJson 均走默认参数，http 组均匀生效）
- `/api/health` → version 1.4.0

**前端**
- `SettingsView.vue`（新，右上角 ⚙ 齿轮触发、不占导航标签）：6 个 panel（数据采集/AI 模型/Agent 对话/缓存 TTL 表格/服务/上游 HTTP）；sticky 操作栏（存储后端标签 + 重置/保存）、成功（4s 自动隐藏）/失败 banner；Token password 输入（「已配置（留空保持不变）」占位 + 「清除已存 Token」勾选，对应三态语义，原文永不回显）
- `App.vue`：header 右侧 `.header-right`（交易徽章 + 齿轮按钮，`activeTab==='settings'` 高亮），`VIEW_MAP` 渲染设置页；`api.js` 新增 `apiPut`；`main.css` 新增 `.header-right`/`.gear-btn`；`store.js` activeTab 注释补 `settings`

**文档**
- README：新增「系统设置」节（6 组可配项/存储/密钥不回显/生效时机）、LLM 配置改为设置页优先（env/file 仅首跑种子）、功能清单 v1.4.0 + F 行、目录结构（config-store.js/config.js/collector.js/SettingsView.vue/config.db）、快速开始 Node 版本说明（sqlite 需 ≥22.5，旧版 JSON 兜底）
- api.md：新增 §19 GET / §20 PUT `/api/config`（掩码语义/三态/校验规则表/生效时机/curl 示例）；§1/§18 上限改为 config 驱动；通用约定补 PUT 例外、413 范围、400 语义
- design.md：ADR **D16**（node:sqlite+JSON 兜底、6 组 schema、密钥掩码、热生效 vs 端口重启、与 D15 拒绝 sqlite 的语境区分、被否 better-sqlite3/纯 env/localStorage）、F11 范围行、架构图（config-store/config/collector + 配置数据流）、映射表 +1 行、§5 TTL 表标注默认值与 config 驱动、限制 2 更新 + 限制 16（config API 无鉴权）

### 验证记录（2026-11-12，本机 Node v24.14.0，离线沙箱；上游行情接口不可达，配置链路全量实测）

| 项目 | 结果 |
|------|------|
| 启动 | ✅ sqlite 后端；日志打印 `config.db` 路径与采集排程；ExperimentalWarning 未泄漏到控制台 |
| `GET /api/health` | ✅ version `1.4.0`；`llmConfigured` 随 llm 组配置变化 |
| `GET /api/config` | ✅ 6 组齐全；`accessToken` 原文不出现、仅 `accessTokenSet:false`；`meta.store={backend:"sqlite",path:…/data/config.db}` |
| PUT 部分合并 | ✅ `{"collection":{"enabled":false,"intervalMinutes":10},"cache":{"snapshot":{"trading":45}}}` → 200；`snapshot.closed=600` 保持不变（组内深合并） |
| 采集器热重排 | ✅ 保存 `enabled=false` 后日志即时输出「数据采集已关闭（config.collection.enabled = false）」，定时器停止 |
| 校验 400 | ✅ `intervalMinutes:0`→「collection.intervalMinutes 取值范围 1–1440」；`temperature:9`→「llm.temperature 取值范围 0–2」；`modelUrl:ftp://…`→「llm.modelUrl 必须为合法的 http(s) 地址」；`tradingStart:25:00`→「server.tradingStart 必须为 HH:MM（24 小时制，如 09:15）」；未知组 `bogus`→「未知配置组: bogus（可选: collection/llm/agent/cache/server/http）」；`collection.nope`→「collection 含未知字段: nope」；start≥end→「server.tradingStart 必须早于 tradingEnd」 |
| 密钥三态 | ✅ 设 `sk-secret-123` → `accessTokenSet:true` 且 health `llmConfigured:true`；缺省（仅改 model）→ 保持 true；`''` → 清除为 false；全程 GET 不回显原文 |
| 重启持久化 | ✅ `enabled=false`/`intervalMinutes=10`、`snapshot 45/600`、`llm.modelUrl/model` 重启后从库中恢复；采集器读到持久化的 `enabled=false` 不启动 |
| 首跑播种 | ✅ 清库后以 `PORT=8799` 启动 → `server.port=8799` 种子落库；其余组为默认值（http 10000/1/300 等） |
| http 组生效 | ✅ `/api/indices` 走上游重试路径，错误 message「请求上游失败（已重试 1 次）」= `retries:1`（离线沙箱预期失败，证明配置被消费） |
| 前端构建 | ✅ `vite build` 593 modules 成功（css 24.29kB/gzip 4.83kB，js 1188.41kB/gzip 395.93kB） |

测试数据清理：验证用 `config.db`/`config.json` 已删除（下次启动按默认值重建）；归档目录（dragontiger/hotrank/ladder/limitup）未受影响；无残留 node 进程。

**待补验证**：设置页浏览器交互走查（构建通过、组件逻辑经代码复核；本轮 chrome-devtools 不可用）；联网环境复跑采集器全链路（离线沙箱上游不可达，仅验证了配置消费与重试路径）。

---

## v1.3.0（2026-11-12）

新增 AI 选股助手（首页默认聊天标签页 + LLM function-calling Agent）与历史数据归档（支撑跨日查询，如「最近 3 天有涨停且在热榜前 50」「与某股关联度最高的共同涨停股」）。

### 新增

**后端**
- `lib/llm.js`：OpenAI 兼容 chat/completions 客户端（model_url 自动补全 `/chat/completions`、`Authorization: Bearer`、90s 超时、错误含 HTTP 状态+响应摘录）；配置优先级 env（`LLM_MODEL_URL`/`LLM_ACCESS_TOKEN`/`LLM_MODEL`）> `server/llm.config.json`（gitignored），**token 仅存服务端、绝不下发前端**；`LlmConfigError`/`LlmError` 类型化异常
- `POST /api/agent/chat`（唯一 POST 业务接口）：Agent function-calling 循环（≤6 轮，`runAgent(history, invoke)` 依赖注入规避循环导入）；请求校验（1–30 条消息/单条 ≤4000 字/末条须 user → 400，body >64KB → 413）；响应 `reply + toolTrace + stocks + model + llmRounds + truncated`；503=未配置（附指引）、502=LLM 调用失败
- `lib/agent.js`：**13 个工具**——10 个数据工具（screen_stocks/search_stock/get_quote/get_indices/get_market_stats/get_ranking/get_hot_rank/get_limitup_pool/get_sectors/get_dragon_tiger）经 `invokeRoute` 进程内复用既有路由（共享校验与 TTL 缓存，零重复逻辑）；3 个历史工具读本地归档；系统提示词（数据原则/筛选口径/纯文本+免责声明/归档覆盖如实告知）；工具结果压缩（列表截断+字段挑选控 token）；结果收集 ≤60 只 A 股 chips（BK/指数自动排除）
- `lib/history.js` + 归档体系：涨停池/热榜/龙虎榜/连板天梯按日 JSON 归档 `server/data/{limitup,hotrank,dragontiger,ladder}/{yyyyMMdd}.json`（tmp+rename 原子写、10min 节流、损坏容错为缺失）；**写入双通道**：4 路由写穿 + 后台采集器（启动 5s 首跑、每 30min，龙虎榜仅上海 15:00 后）；`history_screen` 跨日 join（有涨停∩热榜名次≤X∩上龙虎榜，涨停天数→最佳名次→龙虎榜天数排序）；`history_co_limitup` 共同涨停关联（缺失归档按 date 参数自动回补、批 5 并发、回补顺带写穿归档）
- `api.js#invokeRoute`：进程内路由调用（参数序列化 boolean→'1'/'0'）；`/api/health` → version 1.3.0 + `llmConfigured` 字段

**前端**
- `ChatView.vue`（新**默认**标签页「AI 助手」）：欢迎语 + 5 个预设问题 chips、用户/助手气泡、工具轨迹标签（🔧 label · summary，title 悬浮显示 args，error 态变色）、股票 chips（名称+涨跌幅着色，点击跳个股页）、Enter 发送/Shift+Enter 换行（中文 IME `isComposing` 防护）、清空对话、错误气泡；**XSS 防护**：回答以 `{{ }}` + `white-space: pre-wrap` 纯文本渲染，不用 v-html
- `store.js`：`activeTab` 默认值 → `'chat'`；`api.js`：新增 `apiPost`（POST JSON、同信封错误处理）；`App.vue`：TABS 首位插入 AI 助手

**其他**
- `.gitignore`（新增）：node_modules / web/dist / `server/llm.config.json`（含 access_token 严禁提交）/ `server/data/`（运行期归档）/ 日志杂项

**文档**
- api.md：新增 §18 agent/chat（LLM 配置两方式/请求表/响应示例/13 工具清单/历史归档行为）；通用约定补 POST 例外、413/503 状态码、502 语义扩展
- design.md：F10 范围行、ADR **D14**（function-calling Agent + invokeRoute 复用 + 配置仅服务端）/ **D15**（JSON 归档而非 sqlite/chroma，含被否理由）、架构图（llm/agent/history/data）、Agent 数据流、映射表 +3 行、§5 归档与缓存关系、限制 12–15（非流式/需 function-calling 模型/热榜不可回补/无会话状态）、v2 候选 +2
- README：新增「AI 选股助手」章节（LLM 配置/能力/数据说明）、功能清单 v1.3.0、目录结构（llm.js/agent.js/history.js/ChatView.vue/data/）

### 验证记录（2026-11-12 午后，交易时段；mock LLM 端到端，测试脚本置于仓库外）

环境：mock OpenAI 兼容服务（:8899，按对话阶段返回 tool_calls/最终回答）+ web-stock（PORT=8790，`LLM_MODEL_URL=http://localhost:8899/v1`）。

| 项目 | 结果 |
|------|------|
| `GET /api/health` | ✅ version 1.3.0；`llmConfigured` 随 env 配置 false↔true |
| 请求校验 | ✅ 空 messages / >30 条 / 末条非 user / 单条超 4000 字 → 400（message 指明字段）；GET /api/agent/chat → 405 |
| LLM 未配置 | ✅ 503，message 含 env 变量名与 `server/llm.config.json` 配置指引 |
| **测试A** 条件选股 | ✅ 「筛选涨幅超过5%、换手率大于10%的创业板股票」→ toolTrace `screen_stocks 命中 12 只`，chips 返回 10 只真实创业板股（300829 金丹科技 +13.65% 等），llmRounds=2；mock 侧收到 `auth=Bearer test-token-123`、`tools=13`、压缩后工具结果（list 截断+字段挑选） |
| **测试B** 跨日历史筛选 | ✅ 「最近3天有涨停且在热榜前50」→ `history_overview`（正确报告 limitup 3 天/hotrank 2 天/dragontiger 1 天/ladder 1 天）→ `history_screen` 命中 15 只；排序正确（2 天涨停+热榜第 8 的合成股居首），热榜第 120 名被正确过滤，其余为当日真实涨停∩热榜前 50；归档缺口在 `archivedDates` 中如实返回 |
| **测试C** 共同涨停关联 | ✅ 目标 300999 → summary「目标涨停 2 天 · 关联 2 只」（共同涨停 2 次者排前）；`window.backfilled=7`——10 交易日窗口内 7 天缺失归档自动从上游按 date 回补并落盘（20261030–20261109），全程 1.6s |
| 归档写穿 | ✅ 涨停池/热榜/天梯请求后 `data/` 即时出现当日文件（20261112：limitup 13KB / hotrank 86KB / ladder 14KB） |
| 采集器 | ✅ 启动 5s 首跑日志正常；龙虎榜 15:00 前正确跳过（测试时 13:35） |
| 回补真实数据 | ✅ `GET /api/limitup/pool?date=20261110/20261111`、`/api/dragon-tiger?date=20261111` → 合成测试归档被真实数据覆盖（93/84/75 条），`grep 测试甲乙丙` 无残留 |
| 前端构建 | ✅ `vite build` 591 modules 成功（ChatView 入 bundle，默认 tab 生效） |

测试数据清理：合成归档（300997/300998/300999）已删除或由真实数据覆盖；mock（:8899）与测试服务（:8790）进程已停止。

**待补验证**：接入真实 LLM（用户配置的 model_url/access_token）后的多轮对话质量与 token 消耗；ChatView 浏览器交互走查（构建已通过，界面行为逻辑经代码复核）。

---

## v1.2.0（2026-11-12）

新增四个功能：龙虎榜、热榜、连板天梯、涨停关联分析；选股器指标扩充（市值/市盈率/市净率/量比等）。

### 新增

**后端**
- `GET /api/dragon-tiger`：东财 datacenter-web 明细（主源：上榜原因/净买/买卖/次日涨幅/换手/流通市值）+ 同花顺 transaction（游资/机构净买/营业部标签/概念）按代码合并；东财多榜单行合并（主行取成交额更大者、原因「；」连接）；`platforms` 单侧降级、全失败 502；缓存 `dragontiger:{date}`（5min/30min）
- `GET /api/hot-rank`：东财 xuangu 人气榜 / 同花顺 fuyao / 财联社 / 大智慧 四平台按代码聚合（各平台名次与变化/热度/人气标签/概念），`limit` 1–300；各平台独立容错、全失败 502；缓存 `hotrank`（5min/10min）
- `GET /api/ladder`：当日涨停池内存按板数分层（复用池缓存，零新增上游）；层序板数降序、层内 N 板 N 天优先再按首封时间；缓存 `ladder:{date}`
- `GET /api/limitup/related`：题材关联（当日复盘同组，复盘失败容忍为 null）+ 近 N 个交易日共同涨停统计（跳过周末、批 5 并发、单日失败容忍）；目标不在当日池 → 404；缓存 `limitup:related:{code}:{date}:{days}`
- `/api/screen` 扩充：新增 流通市值/市盈率TTM/市净率/量比/60日涨幅/年初至今 6 组区间条件与 6 个排序键（共 11 排序键）；快照字段集增补 f9/f10/f23/f24/f25/f115（市盈率动/量比/市净率/60日涨幅/年初至今/市盈率TTM），**仍零新增上游请求**
- `/api/quote`、`/api/search`、`/api/ranking` 快照元素同步携带 6 个新字段
- 健康检查版本号 → 1.2.0

**前端**
- `DragonTigerView.vue`（新标签页「龙虎榜」）：日期选择、平台徽章（东财/同花顺 ok·不可用）、摘要条（上榜 N 只/合计净买/日期）、13 列表格 9 列可排序（null 恒排末尾）、标签/概念 chips（>2 折叠为 +N tooltip）、行点击跳个股、空态提示发布时间
- `HotRankView.vue`（新标签页「热榜」）：条数 50/100/300、平台徽章带收录数、四平台名次列（未收录显示 —）、名次变化 ▲/▼、热度值 tooltip、人气标签/概念 chips
- `LimitUpLadder.vue`（涨停中心子页「连板天梯」）：分层横条（≥5 板红 / ≥3 橙 / 2 黄）、股票 chips 含 N 天与首封 HH:mm、rich tooltip、点击跳个股
- `LimitUpRelated.vue`（涨停中心子页「关联分析」）：搜索联想（300ms 防抖）+ 6 位代码输入 + 窗口 5/10/20 日；目标卡片（窗口内涨停日 chips）、题材分组（目标股红框高亮）、共同涨停表（次数/日期降序 chips/几天几板/今日在池）；404 与空态分别提示
- `LimitUpView.vue`：涨停池/涨停复盘/连板天梯/关联分析 四子页；涨停池表格新增「操作」列「关联」按钮（带入代码并切换子页）
- `ScreenerView.vue`：新增 6 组区间输入（共 10 组）、6 个排序键（共 11）、3 个新预设（低估值蓝筹/放量启动/60日超跌，共 8 个）；降级提示文案列出市盈率/市净率/量比等缺失字段
- `StockView.vue`：行情明细新增 市盈率TTM/市盈率动/市净率/量比/60日涨幅/年初至今 6 字段

**文档**
- api.md：§5 字段、§13 参数/排序更新；新增 §14 龙虎榜 / §15 热榜 / §16 连板天梯 / §17 涨停关联
- design.md：F6–F9 范围行、ADR D10–D13、映射表 +9 行、缓存表 +4 行、限制 8 更新 + 9–11、v2 候选移除龙虎榜/人气榜（已实现）改列席位明细/淘股吧
- README：功能清单 v1.2.0、目录树（cls.js/dzh.js/2 组件/2 视图）、数据源声明补充财联社·大智慧

### 实现过程中的实测修正（与接口文档/上游实际行为的差异）

| # | 发现 | 处理 |
|---|------|------|
| 1 | 同花顺龙虎榜比率字段（涨跌幅/净买占比等）为**小数**（如 0.0998），与涨停池的百分数字符串不同 | `fetchDragonTigerList` 统一 ×100 归一为 % |
| 2 | 同花顺龙虎榜同一股票同响应存在重复行（多榜单/多席位段） | 按代码去重，优先保留主榜行，标签/概念取并集 |
| 3 | 大智慧 `stock/top` 响应为弱类型（result 可能为数组或对象、名次为字符串） | `dzh.js` 类型容忍解析（数组直取 / 对象取 rows，`Number()` 转换，非法行跳过） |
| 4 | 财联社热榜代码带 `sh`/`sz` 前缀 | 剥离 2 字母前缀取 6 位代码 |
| 5 | 东财 xuangu `sty` 字段列表可按文档扩展（增补名称/量比等字段正常返回） | 一次请求取全字段，免二次补行情 |
| 6 | 淘股吧 tgb.cn 当前网络环境 DNS 解析失败 | 热榜不接入 TGB，记录 design.md §6 限制 10 |

### 验证记录（2026-11-11 夜间–11-12 凌晨，收盘后；东财 clist/push2his 仍处故障窗口）

后端 curl：

| 接口 | 结果 |
|------|------|
| `GET /api/dragon-tiger?date=20261111` | ✅ 75 只，platforms 东财✓+同花顺✓，合计净买 27.31 亿；榜首 002384 东山精密 净买 7.22 亿（游资 1.02 亿/机构 4.70 亿/标签 量化基金买…/概念 共封装光学…） |
| `GET /api/hot-rank?limit=100` | ✅ dfcf 300 / ths 100 / cls 29 / dzh 100，合并 307 只；名次变化与热度值齐全 |
| `GET /api/ladder?date=20261111` | ✅ 5 连板→首板各层，totalCount 与涨停池一致，层内 N 板 N 天优先 |
| `GET /api/limitup/related?code=603228&date=20261111&days=10` | ✅ 7 个题材组 + 共同涨停行（dates 降序、inTodayPool 正确） |
| `GET /api/limitup/related?code=600715&…` | ✅ `themes: []`（与 `/api/limitup/replay` 交叉验证：确不在 top20 组，设计行为） |
| `GET /api/limitup/related?code=600000&…` | ✅ 404「不在涨停池」 |
| `GET /api/screen?peMin=0&peMax=15&pbMin=0&pbMax=1.5&mvMin=200&sort=peTtm&dir=asc` | ✅ 200 且 total 0（新浪兜底源市盈率 null 不入选，设计行为） |

浏览器（chrome-devtools 驱动本地 Chrome，视口 1440×900，后端托管生产构建）：

| 步骤 | 结果 |
|------|------|
| 龙虎榜 | ✅ 75 行 13 列完整展示（列宽修复后 table 宽 = 容器宽 1358px，无横向滚动）；平台徽章、排序与 null 末尾、chips +N tooltip、行点击跳个股正常 |
| 热榜 | ✅ 合并 307 展示 100；名次变化 ▲/▼、未收录名次 —、热度 tooltip、人气标签 chips 正常 |
| 连板天梯 | ✅ 分层着色（5 连板红→首板）、chips 含首封时间、rich tooltip、点击跳个股 |
| 关联分析 | ✅ 涨停池「关联」按钮带入代码并切换子页自动查询；603228 题材组目标红框高亮；600000 显示 404 提示 |
| 条件选股 | ✅ 「低估值蓝筹」预设回填（总市值≥200 亿/PE 0~15/PB 0~1.5/排序市盈率升序），兜底源标签 + 命中 0 + 降级提示；10 组区间/11 排序键/8 预设完整渲染 |
| 控制台 | ✅ 新页面操作全程 0 error（总览指数卡片 502 为既有 push2his 故障，见 design.md 限制 9） |

**验证中发现并修复的 2 个布局问题**（已包含在 v1.2.0 内）：

1. 龙虎榜标签列被压缩至 ≈130px（chips 单列堆叠、行高 ≈190px）→ scoped CSS 设 min-width 190px + 允许换行。
2. 修复后表格自然宽 1446px 仍超容器 1358px（标签列藏在横向滚动后）→ 原因列 300→210px、标签列 260→220px，实测 table 宽 = 容器宽（1358=1358）。

**待补验证**：东财 clist 恢复后复核 f9/f10/f23/f24/f25/f115 映射实测值（与已知值比对，如 600000 浦发银行 PE≈5–6、PB≈0.5），并复跑 v1.1.0「中涨幅高换手」预设（换手率/市值阈值路径）。

---

## v1.1.0（2026-11-11）

新增「条件选股」模块（F5）。

### 新增

**后端**
- `GET /api/screen`：基于全市场快照的区间过滤 + 排序（涨跌幅/换手率/成交额亿/总市值亿 区间、boards 板块过滤、excludeSt、sort∈pct/turnover/amount/amplitude/totalMv、dir、limit≤300）；复用快照缓存，**零新增上游请求**（决策 D9）
- 过滤语义：停牌不入选；阈值已设但字段为 null 不入选（不静默放行）；排序 null 值排末尾；boards 非法值 400
- 健康检查版本号 → 1.1.0

**前端**
- `ScreenerView.vue`（新标签页「条件选股」）：左栏筛选结果排序列表（序号/代码名称/最新价/涨跌幅/换手，内部滚动，点击选中高亮）；右上日 K 线（复用 KLineChart，60/120/250 日，可「个股查询打开」）；右下筛选指标面板（4 组区间输入 + 板块复选 + 排除 ST + 排序键 + 升/降序 + 重置/筛选）
- 5 个快捷预设：中涨幅高换手 / 主板准涨停 / 强势股≥9% / 小市值高活跃 / 超跌反弹池；离散条件（预设/排序/板块/ST）变更立即重筛，区间输入需点「筛选」
- 降级提示：快照为新浪兜底源时列表标题显示「兜底源」标签，空态给出「换手率/振幅/市值阈值会筛空」说明

**文档**
- api.md §13（/api/screen 参数/规则/示例）、design.md F5 + 映射表 2 行 + ADR D9 + 限制 8 + v2 候选、README 功能表/目录树同步

### 验证记录（2026-11-11 夜间，东财上游故障期间）

验证时段东财 clist 与 push2his 三主机全部空响应（curl 退出码 52，午后曾正常），快照与指数按设计走兜底链（新浪/搜狐），本轮验证因此**覆盖了降级路径**：

| 步骤 | 结果 |
|------|------|
| `GET /api/screen?pctMin=9&sort=pct&dir=desc&limit=5`（浏览器预设「强势股≥9%」同源参数） | ✅ 命中 119（新浪快照），榜首 688135 利扬芯片 +20.01%（科创板），降序正确 |
| `GET /api/screen?pctMin=3&pctMax=6&turnoverMin=5&turnoverMax=15` | ✅ 返回 200 且 `total:0`——兜底源换手率为 null 按规则不入选；前端空态 + 「兜底源」标签 + 提示文案如实展示（设计行为，非缺陷） |
| `GET /api/screen?boards=Main` | ✅ 400（非法板块值） |
| 选股器 K 线 | ✅ 点击列表首行后蜡烛图渲染（东财 push2his 故障 → 搜狐兜底，与 D5 兜底链一致） |
| 浏览器控制台 | ✅ 选股器操作全程 0 error；仅首屏总览在东财全故障下产生 2 条 502 的 console.error（视图错误处理设计行为，页面显示错误态而非白屏） |
| 构建 | ✅ vite 6 构建通过（js 1144.29kB / gzip 383.79kB） |

**待补验证**：东财恢复后以东财快照复跑「中涨幅高换手」预设（换手率/市值阈值路径），预期 total>0；快照字段路径本身已在 v1.0.0 验证覆盖。

---

## v1.0.0（2026-11-11）

首个版本：基于 `docs/stock-data-apis/` 接口文档实现行情查询 Web 应用。

### 新增

**后端（server/，Node.js ≥18，零第三方依赖）**
- 11 个 REST 接口 + 1 个调试接口（`DELETE /api/cache`），完整定义见 [api.md](api.md)
- 全市场快照：东财 clist（pz=100 × ≈60 页，6 并发，20/43/52 三主机 fallback）→ 新浪 hs_a 兜底
- 日 K 线：东财 push2his（前复权）→ 搜狐 hisHq 兜底（% 后缀清洗、振幅由相邻收盘推算）
- 板块：东财 clist 行业/概念实时 + 成份股下钻（fs=b:BKxxxx）
- 涨停：同花顺 limit_up_pool（翻页聚合）+ block_top（题材分组），携带 Referer/UA
- 内存 TTL 缓存（交易时段/收盘双档 TTL + in-flight 去重）、统一 JSON 响应信封、参数校验（400/404/405/502）
- 静态托管 `web/dist`（SPA fallback、路径穿越防护、MIME/缓存头）

**前端（web/，Vue 3 + Vite 6 + ECharts 5）**
- 总览：三大指数卡片、涨跌统计条、涨幅/跌幅榜 Top20（30s 自动刷新，页面不可见暂停）
- 个股查询：防抖搜索联想（代码/名称）、21 字段行情明细、涨停/跌停/停牌标签、日 K 蜡烛图（MA5/10/20 + 成交量副图 + dataZoom，60/120/250/500 日切换）
- 板块排行：行业/概念切换、涨跌幅/换手率/振幅/总市值四列排序、点击行展开成份股、成份股跳转个股
- 涨停中心：日期选择、涨停池明细表（几天几板/类型/原因/首封时间/开板/换手/封单/流通市值）、涨停复盘题材分组（可折叠，默认展开前 5 组）、股票点击跳转个股
- 全局：暗色行情终端主题（红涨绿跌、等宽数字）、跨视图跳转（模块级 store）、交易状态徽章（/api/health 轮询）

**文档**
- README.md（功能清单/快速开始/目录结构）
- docs/design.md（范围、架构、8 条技术决策 ADR、功能→上游接口映射表、缓存策略、已知限制）
- docs/api.md（12 个接口的参数/响应/示例）
- docs/changelog.md（本文件）

### 实现过程中的实测修正（与接口文档的差异）

| # | 发现 | 处理 |
|---|------|------|
| 1 | 东财 clist 请求 `pz=200` 实际单页最多返回 **100** 条（文档标注 pz=200；与 monitor 端 pz=100、app 端「pn=1..59」互相印证） | 快照按 pz=100 分页，页数上限 80；`fetchFullSnapshot` 注释记录该行为 |
| 2 | 东财 kline `klines` 实测按日期**升序**返回（文档称默认降序） | 不依赖上游顺序，解析后显式按日期升序排序 |
| 3 | 搜狐 hisHq 百分比字段带 `%` 后缀（如 `"0.99%"`，文档未提及） | `toPercentNumber` 去后缀解析 |
| 4 | 搜狐不返回振幅字段 | 由相邻两日收盘推算 `(high-low)/preClose*100` |
| 5 | 同花顺涨停池 `trade_status` 为对象 `{id,name,...}` 而非字符串；`limit_up_count` 可能为 null | summary 归一化：取 `name`；count 缺失时回退为 list 长度 |
| 6 | 东财 clist `fs` 参数中 `+` 需保留字面量（URLSearchParams 会编码为 %2B） | 构建 URL 后将 %2B 还原为 `+`（与 monitor 端「encoded，保留 +」一致） |
| 7 | 同花顺复盘 block_top 的 `high_days` 为**编码整数**（高 16 位=板数、低 16 位=天数，如 131075=0x20003），与涨停池 limit_up_pool 的字符串形式（"3天2板"）不同；ths.md 未提及 | `decodeHighDays` 解码为「N天N板」/「首板」，字符串原样透传；已与同日涨停池交叉验证（奥士康 131075↔"3天2板"、福莱新材 262150↔"6天4板"） |

### 验证记录（2026-11-11，收盘后实测）

后端接口逐一 curl 验证（当日为交易日，数据日期 2026-11-11）：

| 接口 | 结果 |
|------|------|
| `GET /api/health` | ✅ `{"ok":true,"version":"1.0.0","isTradingTime":false}`（16:00 后判为收盘，符合规则） |
| `GET /api/indices` | ✅ 上证 3680.64 +0.46% / 深成 11389.74 +1.32% / 创业板指正常返回 |
| `GET /api/stats` | ✅ `total:5928, up:3538, down:1827, flat:212, suspended:351, limitUp:85, limitDown:3`（修复分页前仅 3000 条且全为上涨股，修复后与全市场数量级一致） |
| `GET /api/quote?code=600000` | ✅ 浦发银行 10.17 -0.29%，21 字段齐全（含 ztPrice 11.22 / dtPrice 9.18 / board 主板） |
| `GET /api/search?kw=600` | ✅ 返回 20 条 600 前缀股票 |
| `GET /api/search?kw=平安` | ✅ 命中「平安电工 001359」等 |
| `GET /api/ranking?order=desc` | ✅ 榜首 920157 宇特光电 +29.99%（北交所 30cm） |
| `GET /api/ranking?order=asc` | ✅ 榜首 688827 C钶锐 -16.33%（新股无涨跌幅限制） |
| `GET /api/kline?code=600000` | ✅ 升序日 K，最后一根 2026-11-11；与 `/api/quote` 当日 OHLC 交叉一致 |
| `GET /api/kline`（搜狐兜底直测） | ✅ 修复 % 解析后 `pct:0.99, turnover:0.14, amplitude:2.38`（amplitude 与东财同日值 2.38 完全一致） |
| `GET /api/sectors?type=industry` | ✅ 496 个行业板块，榜首 BK1295 其他数字媒体 +7.27%（涨/跌/平 2/0/0） |
| `GET /api/sectors?type=concept` | ✅ 531 个概念板块，榜首 CPO概念 +5.83% |
| `GET /api/sectors/stocks?bk=BK0482` | ✅ 60 只成份股 |
| `GET /api/limitup/pool?date=20261110` | ✅ 93 只涨停（tradeStatus「已收盘」），含「2天2板」连板、首封时间 14:56:27、涨停原因等全字段 |
| `GET /api/limitup/replay?date=20261110` | ✅ 20 个题材分组（机器人概念 34 只 / 人工智能 25 只 / 新能源汽车 24 只…） |
| 参数校验 | ✅ `code=abc`→400；不存在代码→502（东财+搜狐均失败后如实报错）；未知路径→404 |
| 缓存 | ✅ 二次请求 `meta.fromCache:true`；快照 miss 时 ≈60 页 6 并发实测 ≈1.3s 完成 |

前端：
- `npm run build` ✅（vite 6.4.6，579 模块，产物 index.html + css 9.93kB + js 1133.94kB/gzip 380.93kB）
- 后端托管 `web/dist` ✅（`GET /` 返回 index.html）
- 浏览器四视图人工走查 + 控制台无报错验证：见下方「浏览器验证」

### 浏览器验证

环境：chrome-devtools 驱动本地 Chrome，视口 1440×900，访问 `http://localhost:8787`（后端托管 `web/dist` 生产构建）；时间 2026-11-11 16:55–17:25（收盘后）。

| 步骤 | 结果 |
|------|------|
| 总览 | ✅ 三指数卡片（上证 3680.64 +0.46% / 深成 11389.74 +1.32% / 创业板指 2572.07 +3.11%）、统计条 5928/3538/1827/212/85/3/351、涨/跌幅榜 Top20 与 curl 结果逐行一致；右上「已收盘」徽章与数据源标签正常 |
| 个股查询 | ✅ 输入 `600000` 防抖联想出「浦发银行 10.17 -0.29%」；点选后行情头部（主板标签）+ 15 字段明细 + 蜡烛图（MA5/10/20、成交量副图、dataZoom）渲染，标注「数据源: 东财」，120 日按钮激活 |
| 板块排行 | ✅ 496 个行业板块、默认涨跌幅降序（榜首 BK1295 其他数字媒体 +7.27%）；点击行后成份股面板展示 BK1295 共 2 只（风语筑 +9.98% / 凡拓数创 +4.55%），面板位于视口内 |
| 涨停中心 | ✅ 涨停池默认今天（2026-11-11）：涨停 84、交易状态「已收盘」，几天几板/首封时间/开板/封单/流通市值/涨停原因齐全；涨停复盘题材分组（新能源汽车 29 只·持续 7 天 / 机器人概念 27 只 / 华为概念 24 只 / 比亚迪概念 23 只），连板徽章「3天3板」「6天4板」等解码正确 |
| 控制台 | ✅ 全程 0 error / 0 warning |

**验证中发现并修复的 2 个问题**（已包含在 v1.0.0 内）：

1. 同花顺 block_top `high_days` 编码整数被透传，复盘连板徽章显示「131075」等原始值 → 新增 `decodeHighDays` 解码（见上表实测修正 #7），修复后徽章与涨停池字符串一致。
2. 板块排行成份股面板原渲染在 496 行长表之下（整页 ≈17000px），点击行无可见反馈 → 板块表改为内部滚动（`max-height: 58vh`），成份股面板恒在视口内（实测面板 top=682px < 视口 882px）。
