# web-stock 变更记录

本文件记录每个版本的功能变更与**验证记录**（实测命令与结果摘要），保证实现可回溯。

---

## v1.6.2（2026-11-13）

**空回答原因区分：finish_reason 捕获 + 可操作错误提示**：对话连续出现「（模型未返回内容，请重试或换个问法）」。排查（chat.db `agent_traces` 留痕）定位为推理模型的思考过程（reasoning_content）耗尽 maxTokens=2048 预算——5 次失败末轮 completionTokens 全部正好 2048、content 为空、reasoning 长达 3700–4400 字符；上游本已返回 `finish_reason=length` 明示截断，但旧代码丢弃该字段，用户侧与日志只能给笼统提示。本版：① `lib/llm.js` 流式/非流式均捕获 `choices[0].finish_reason` 并透传；② `lib/agent.js` 空回答按 finish_reason 给出**差异化提示**（length→引导调大 maxTokens、content_filter→审查拦截、其余→限流/异常并指路服务端日志）；③ trace 每轮记录 `finishReason`，TracePanel 轮次头部显示告警标签；④ 进程日志补 finish_reason 与当前 maxTokens。另将线上 `config.db` 的 `llm.maxTokens` 2048→8192（本次故障的直接修复）。

### 新增/变更

**后端**
- `lib/llm.js`：`chatCompletionsStream` 聚合最后一个 chunk 的 `finish_reason`（须在 delta 判断前捕获——携带 finish_reason 的 chunk 其 delta 可能为空对象）；`chatCompletions`（非流式）同步捕获；空响应 warn 日志附 `finish_reason`；返回消息对象新增 `finishReason` 字段（null=上游未给）
- `lib/agent.js`：新增 `emptyReplyMessage()`——空回答提示按 finish_reason 区分：`length` →「思考+输出用尽 maxTokens 上限，请在设置→AI 模型调大（推理模型建议 ≥8192）」；`content_filter` →「被上游内容审查拦截」；其余 →「可能上游限流或服务异常，持续失败查看服务端 [llm]/[agent] 告警」。空回答 warn 日志补 `finish_reason` 与生效 `maxTokens`；`trace.rounds` 每轮新增 `finishReason`
- `api.js`：`/api/health` → version 1.6.2

**前端**
- `TracePanel.vue`：轮次头部新增 finish_reason 告警标签（`stop`/`tool_calls` 正常不显示；`length` →「⚠️ 截断：maxTokens 打满」；`content_filter` →「⚠️ 内容审查拦截」；其余原样展示）

**文档**
- api.md §23：trace `rounds` 示例与字段说明补 `finishReason`（含各取值语义）

**配置（数据，非代码）**
- `server/data/config.db`：`llm.maxTokens` 2048 → 8192。推理模型的思考过程与正式回答**共用** max_tokens 预算，2048 对复杂问题必然被思考耗尽导致「返回空」

### 兼容性说明

- `finishReason` 为返回值/trace 的**新增**字段：旧 trace 数据无此字段，TracePanel 空值不渲染标签，正常展示；上游未返回 finish_reason 时为 null，行为退化为原通用提示
- 空回答提示文案变化仅影响用户可见文本，SSE 协议与 done 事件结构不变

### 验证记录（2026-11-13，本机 Node v24.14.0；/tmp/ws-fr-test 隔离副本 + mock SSE 上游端到端，未触碰真实 server/data/ 配置）

| 项目 | 结果 |
|------|------|
| mock SSE 端到端（length / content_filter / 正常 stop / 空 stop 四场景） | 9 pass 0 fail：流式层捕获 finish_reason、content 空时 reasoning 保留、agent 差异化提示（含 maxTokens 引导/审查提示/通用提示含日志指引）、trace 轮次留痕 finishReason、正常回答不受影响 |
| 真实失败 trace 复盘（chat.db `agent_traces` 5 条） | 末轮 completionTokens 均 =2048（打满 maxTokens）、content 长度 0、reasoning 3711–4457 字符——与 length 截断判定一致 |
| `node --check`（llm.js / agent.js / api.js）+ 前端 `vite build` | 通过 |

---

## v1.6.1（2026-11-13）

**上游按主机限流 + 全链路失败日志**（D20）：对话中出现「返回空导致失败」，疑似行情上游对频繁访问有隐性频率限制（触发后返回空数据/拒连），且多处失败被静默容忍、无日志可查。本版：① `lib/http.js` 内置**按主机限流**（同主机相邻请求最小启动间隔 + 并发在途上限），参数入 `config.http` 可在设置页调整热生效；② 补齐失败日志——上游请求逐次尝试留痕、快照分页失败逐页告警、**空快照改为抛错**（转新浪兜底而非向下输出空列表）、LLM 坏 chunk 统计与空响应告警、agent 工具失败/空回答/轮数中断落进程日志、热榜/龙虎榜单平台降级与历史回补失败留痕。

### 新增/变更

**后端**
- `lib/http.js`：
  - 新增每主机限流器（FIFO 队列）：`maxConcurrent`（同主机并发在途上限，默认 4）+ `minIntervalMs`（同主机相邻请求启动最小间隔，默认 100ms）；所有上游请求（含重试）经 `fetchText` 单点过闸，对 sources 层透明；配置使用时读取，改值即生效
  - 每次失败尝试打 `console.warn`：URL、尝试轮次、失败原因（网络错误/超时/HTTP 状态 + 响应体摘录 200 字符——限流/风控页常在响应体说明原因）；网络错误**下钻 cause 链**取真实错误码（undici 的 message 恒为「fetch failed」，不钻无法区分 `UND_ERR_SOCKET` 上游断连与 `ECONNREFUSED` 本机不通）；JSON 解析失败同样留摘录
- `lib/config.js`：`http` 组新增 `minIntervalMs`（默认 100，校验 0–10000）与 `maxConcurrent`（默认 4，校验 1–32）；深合并语义下已有部署自动补默认值
- `sources/eastmoney.js`：`fetchFullSnapshot` 分页失败由静默容忍改为**逐页 warn + 汇总不完整告警**（成功只数/预期 total/失败页号）；**空快照抛错**（「疑似上游限流」），走 api.js 新浪兜底链，不再把空列表写入缓存供下游「返回空」
- `lib/llm.js`：流式响应统计坏 chunk（JSON 解析失败）数量并保留首例摘录；`content/reasoning/tool_calls/usage` 全空时打 warn（含 model/url）——对话「返回空」的底层排查锚点
- `lib/agent.js`：工具执行异常/工具级 error/LLM 空回答（无 content 且无 tool_calls）/达到最大轮数中断，均落 `console.warn`（含轮次、model、耗时、usage、args 摘录）；`history_co_limitup` 归档回补逐日失败留痕（原仅计数）
- `api.js`：`/api/dragon-tiger` 与 `/api/hot-rank` 单平台失败降级时打 warn（原仅写入 meta.platforms）；`/api/limitup/related` 历史回看单日失败留痕；`/api/health` → version 1.6.1

**前端**
- `SettingsView.vue`：「上游 HTTP」面板新增 最小请求间隔（0–10000ms）与 单主机最大并发（1–32）两个输入，附调优提示（疑似限流调大间隔/调小并发；快照刷新变慢与 TTL 的权衡）

**文档**
- design.md：ADR **D20**（按主机限流 + 失败日志：决策/理由/取舍/被否方案）、F11 行、§5 限速策略补限流条目
- api.md：§19 `http` 组示例与字段说明补两字段、§20 校验表补两行
- README：系统设置功能行与可配项表补「调用频率限制」

### 兼容性说明

- 已有部署的 `http` 组经深合并自动补 `minIntervalMs:100`/`maxConcurrent:4` 默认值（D16 部分合并语义），无需手工迁移；如上游确认无限流可把间隔调回 0
- 限流按「主机」归组：东财三 fallback 主机（20/43/52.push2）各自计数，与主机 fallback 语义正交；不同上游互不挤占
- 默认参数下全市场快照（≈60 页）由瞬时 6 并发突发变为 ≤4 并发、≥100ms 间隔的平滑拉取（约 6–8s），仍在交易时段 30s TTL 预算内；sources 层代码零改动

### 验证记录（2026-11-13，本机 Node v24.14.0；限流单测 + /tmp/ws-rate-test 隔离副本端到端 + 真实上游实况，未触碰真实 server/data/）

| 项目 | 结果 |
|------|------|
| 限流生效（本地 mock 服务） | ✅ 8 个并发 `fetchText` 实测 706ms（默认间隔 100ms，理论下界 700ms），全部成功返回 |
| 失败日志 | ✅ 404 请求逐次尝试打 warn：URL + 「第 N/M 次尝试」+ HTTP 状态 + 响应体摘录；最终抛 UpstreamError（cause 保留状态与摘录） |
| 配置默认值 | ✅ `init()` 后 http 组含 `minIntervalMs:100, maxConcurrent:4` |
| 配置校验 | ✅ 合法值（250/2）更新成功；`-1`/`10001`/`0`/`33`/`1.5` 全部 400 拦截（中文报错含字段路径与范围）；部分补丁深合并正确（改 timeoutMs 不动限流字段） |
| 隔离副本端到端 | ✅ :9921 独立数据目录启动正常，health 返回 version 1.6.1；`GET/PUT /api/config` 限流字段往返一致 |
| 真实上游失败日志实况 | ✅ 测试期间本机恰逢东财限流：clist 三主机（20/43/52）6 次尝试逐条 warn（`fetch failed \| UND_ERR_SOCKET`，cause 链下钻生效），空快照抛错转新浪兜底返回 5578 只——用户报告的「返回空」场景全链路可追溯 |
| 失败原因二分诊断 | ✅ 5 种请求形态（编码/未编码 × pz100/pz2 × 全字段/2字段 × 多段/单段 fs）**不经限流器**裸 fetch 全部同样失败（`UND_ERR_SOCKET`，83–408ms），而同一小请求数分钟前曾成功（HTTP 200）——确认为**时变的上游 IP 级频率限制**，与 URL 构造/请求大小/限流器无关，佐证「调用频率限制导致失败」的判断 |
| 前端构建 | ✅ `vite build` 成功（js 1204.84kB / gzip 401.50kB） |
| 语法检查 | ✅ `node --check` 服务端 6 个改动文件全部通过 |

测试数据清理：测试服务（:9921）已停止，`/tmp/ws-rate-test`、`/tmp/ws-diag`、`/tmp/test-ratelimit.mjs`、`/tmp/ws-server.log` 已删除；无残留进程。

## v1.6.0（2026-11-12）

**归档直读 + 收盘长缓存**（F13，D19）：涨停池/连板天梯/龙虎榜/人气热榜四类收盘后即为静态终态的数据，历史日期请求**优先读本地归档**（命中零上游请求，`meta.fromArchive`）；热榜新增 `date` 参数（上游无历史接口，归档缺失如实 404）；收盘 TTL 默认调至 24h（龙虎榜 1h、空列表 30min 封顶），**实际过期封顶到下一交易日开盘**（长缓存的正确性前提——否则周一盘前会命中上周五旧快照）。

### 新增

**后端**
- `lib/market.js`：`ttlBySession` 替换为 `secondsUntilNextTradingStart(from?)`——距下一交易日开盘秒数（开盘时刻取 `config.server.tradingStart`，仅识别工作日；上海固定 UTC+8，`Date.UTC(y, m-1, d+advance, startH-8, startM)` 精确计算，`Date.UTC` 自动归一化跨月/跨年）
- `lib/cache.js`：`cached()` 的 `ttlMs` 支持**函数形式** `(value) => ms`——按 producer 结果定 TTL（龙虎榜发布前的空列表封顶 30min）
- `lib/history.js`：新增 `loadRecordWithMeta(type, date8)`（返回 `{data, savedAt}`，供归档直读路由标注落盘时间）；`loadRecord` 保持不变（agent 历史工具兼容）
- `api.js`：
  - `cacheTtl()` 收盘分支改为 `min(closed, secondsUntilNextTradingStart())`——收盘缓存最晚在下一交易日开盘时失效
  - 新增 `tryArchive(type, date8)` 归档直读：早于今天且归档存在 → 返回 `cached()` 兼容形状（`fromArchive:true` + `archiveSavedAt`）；**工作日空归档视为未命中**（盘前/龙虎榜发布前的中途快照，回退上游后写穿覆盖为终态 = 自愈）；周末空归档照常返回（非交易日占位）
  - `getLimitUpPool` 内置归档直读（pool 路由 / ladder 派生 / related 历史回看 / agent 工具四条路径同时受益）；`/api/ladder`、`/api/dragon-tiger` 路由级归档直读（天梯归档缺失时由池归档派生，仍零上游）；归档命中不再重复写穿
  - `/api/hot-rank` 新增可选 `date` 参数：历史日期仅由归档提供（缺失 404 + 覆盖范围说明），今天/缺省走原实时路径；`meta` 增加 `date` 字段；实时 `metaOf` 透传 `fromArchive`/`archiveSavedAt`
  - `/api/health` → version 1.6.0
- `lib/config.js`：`cache.*.closed` 默认 600–1800s → **86400s**（龙虎榜 3600s：17:00 发布语义）；校验范围分档 trading 5–7200 / closed 5–**86400**
- `lib/agent.js`：`get_hot_rank` 工具增加 `date` 参数（历史热榜由归档直读，缺失时向用户如实说明覆盖范围）

**前端**
- `HotRankView.vue`：新增日期选择（同龙虎榜页交互，`type=date`、max 今天）；历史日期命中归档时 meta 行显示「📦 历史归档 · 保存于 …」徽章；归档缺失的 404 文案直接在错误态展示
- `SettingsView.vue`：缓存 TTL 说明更新（交易 5–7200 / 收盘 5–86400，收盘缓存最晚下一交易日开盘失效）；closed 输入框 `max=86400`

**文档**
- design.md：ADR **D19**（归档直读 + 开盘封顶长缓存：决策/理由/取舍/被否方案）、F13 范围行、D6/D15 补 v1.6.0 更新、架构图、映射表 +1 行、§5 TTL 表更新（24h*/1h* + 归档直读注记）、限制 2/14 补充
- api.md：通用约定补 `meta.fromArchive`/`archiveSavedAt` 与开盘封顶说明；§10/§14/§16 归档直读注记；§15 增 `date` 参数 + 404 语义 + curl 示例；§18 归档块补读取路径；§19 默认值更新；§20 校验范围分档
- README：功能清单 v1.6.0、热榜/涨停中心/龙虎榜行补历史查询说明、缓存策略句更新

### 兼容性说明

- **已有部署的 `cache.*.closed` 保持旧值**：配置默认值只填充库中缺失的字段（D16 部分合并语义），升级后如需 24h 长缓存，在设置页把 closed 改为 86400 即可（trading 不受影响）
- `loadRecord`/agent 历史工具/归档文件格式均无变化，旧归档直接可用
- 收盘 TTL 即使配置为 86400，实际过期也不会晚于下一交易日开盘（正确性由服务端保证，与配置无关）

### 验证记录（2026-11-12，本机 Node v24.14.0；/tmp/wsv16 隔离副本 + 伪造历史归档，测试端口 :9920，行情上游真实可达；未触碰真实 server/data/）

| 项目 | 结果 |
|------|------|
| `secondsUntilNextTradingStart` 边界 | ✅ 9 用例全过：工作日盘前（当日开盘 75min）/收盘后（次日 17.25h）/周五晚（周一 65.25h）/周六/周日/刚过开盘（次日）/尾盘 14:59:59/跨月末/跨年 |
| 四类归档直读 | ✅ pool/ladder/dragontiger/hot-rank `?date=20261111` 均返回伪造归档数据，`meta.fromArchive=true` + `archiveSavedAt`，零上游请求 |
| 热榜历史 limit 切片 | ✅ `?date=20261111&limit=1` 返回 1 条、`total:2` 保留全量计数，`meta.date=20261111` |
| 热榜归档缺失 | ✅ `?date=20261101` → 404「上游不提供历史热榜接口，归档自功能启用之日起逐日积累」；未来日期 → 400 |
| 周末空归档 | ✅ `pool?date=20261108`（周日，空 list 归档）照常返回 `fromArchive=true`（非交易日占位） |
| 工作日空归档自愈 | ✅ `pool?date=20261110`（空 list 归档）回退上游 → 返回真实数据 93 只（无 fromArchive），归档文件被写穿覆盖为终态 |
| 配置校验分档 | ✅ `closed=86400` → 200；`closed=86401` → 400「取值范围 5–86400」；`trading=7201` → 400「取值范围 5–7200」；GET 确认 dragontiger 默认 3600 |
| 实时路径回归 | ✅ 今日 hotrank 实时/缓存命中正常，`meta.date=20261112`；今日 pool 写穿归档 `20261112.json` 生成 |
| health | ✅ version 1.6.0 |
| 前端构建 | ✅ `vite build` 成功（js 1203.74kB / gzip 401.11kB） |
| 语法检查 | ✅ `node --check` 服务端 6 个改动文件全部通过 |

测试数据清理：测试服务（:9920）已停止，`/tmp/wsv16`、`/tmp/test-nextopen.mjs` 已删除；无残留进程。

**待补验证**：浏览器走查热榜日期选择与归档徽章（构建通过、交互复用龙虎榜页同款模式）；下一交易日开盘时刻的 TTL 封顶实况（逻辑经 9 用例单测覆盖，建议次日观察盘前首刷 `fromCache:false`）。

---

## v1.5.0（2026-11-12）

AI 助手**会话持久化 + SSE 流式输出 + 全链路可观测**（F12）：对话/消息/调用链路服务端落库（多会话管理，切页/刷新不丢）；`/api/agent/chat` 改为 SSE 流式（思考过程与回答逐字推送、工具进度实时可见、客户端断开即中止）；新增调用链路看板（每轮 LLM 输入输出/tokens/工具参数与结果预览）与系统提示词/工具清单查看页。

### 新增

**后端**
- `lib/chat-store.js`（新）：会话存储层——`node:sqlite`（主，`server/data/chat.db`，`chat_sessions`/`chat_messages`/`agent_traces` 三表 + 索引，ExperimentalWarning 抑制），不可用（Node < 22.5）自动回退 `server/data/chat.json`（tmp+rename 原子写），启动日志打印实际后端（与 config-store 同模式，D16）；会话上限 100、新建时修剪最旧（级联删消息/trace）；`appendMessage`（reasoning/toolTrace/stocks/traceId 随消息落库）、`listMessages(limit)`（取最近 N 条升序返回）、`saveTrace`/`getTrace`
- `lib/llm.js`：新增 `chatCompletionsStream`（`stream:true` SSE 帧解析：`content`/`reasoning_content` 增量逐段回调、`tool_calls` 按 `delta.index` 聚合 id/name/arguments 分片、usage 收集、超时 + 外部 signal 合并的 AbortController）；非流式 `chatCompletions` 补充返回 `reasoning`/`usage`
- `lib/agent.js`：`runAgent(history, invoke, emit, options)` **事件化**——经 emit 逐段推送 `round_start`/`reasoning`/`content`/`tool_call`/`tool_result`；每轮记录 `rounds[]` 调用链路（inputMessages/reasoning/content/usage/durationMs/toolCalls[args/status/summary/durationMs/resultPreview ≤1500 字]）并累计 usage；支持 `options.signal` 中止（aborted 结果不落库）；新增 `getAgentMeta()`（系统提示词全文 + 13 工具定义含参数 JSON Schema）
- `api.js`：`POST /api/agent/chat` 重写为 **SSE 流式**（两阶段错误：流开始前 400/404/503 走 JSON 信封，流开始后走 `error` 事件；请求体由 `messages` 数组改为 `{sessionId, message}`，历史由服务端从会话库加载最近 `agent.maxMessages-1` 条，前端不再携带；用户消息即时落库、首条消息自动作会话标题截 30 字；客户端断开 → AbortController 链中止 LLM 与工具循环，半截回答与 trace 不落库；完成后 trace + assistant 消息落库，`done` 事件带 traceId 不带 rounds——体积大，看板按 traceId 拉取）；新增 7 条路由：`GET/POST /api/agent/sessions`、`GET/PUT/DELETE /api/agent/sessions/{id}`、`GET /api/agent/meta`、`GET /api/agent/traces/{id}`；`/api/health` → version 1.5.0
- `index.js`：启动时 `initChatStore()`，打印会话存储后端与路径

**前端**
- `chatStore.js`（新）：**模块级单例**会话状态（tab 切换组件卸载不丢，根治 v1.3.0「切页回来对话消失」）——sessions/activeSessionId/messages/isStreaming；localStorage 记忆活动会话 id、刷新后恢复；`sendMessage`（乐观推送 + SSE 事件 reducer：reasoning/content 逐字追加、tool_call→tool_result 状态流转、done 收尾汇总）；`stopStreaming`（abort fetch）；建/删/改会话
- `api.js`：新增 `apiPostSse`（fetch + ReadableStream 手工解析 SSE 帧——`EventSource` 不支持 POST；按 `\r?\n\r?\n` 分帧、解析 `event:`/`data:` 行、容忍坏帧）、`apiDelete`
- `ChatView.vue` 重写：左侧会话列表（活动高亮/悬停重命名/删除/＋新会话）+ 右侧聊天区；助手气泡：💭 思考过程（流式逐字显示、可折叠）、工具轨迹标签（running 转圈/ok/error，悬浮显示参数，附摘要与耗时）、流式光标、「停止生成」按钮；消息尾 meta（模型/轮数/耗时/tokens/truncated）+「🔗 调用链路」入口；左栏底部「📋 系统提示词与工具」入口
- `TracePanel.vue`（新）：调用链路看板（右侧抽屉）——汇总条（模型/轮数/总耗时/tokens 入出）+ 每轮卡片：输入消息数/💭 思考/📤 输出/tokens/耗时，每个工具调用的 参数（pretty JSON）/状态/摘要/耗时/可展开返回结果预览——用于评估模型输入输出质量、工具选择与参数正确性
- `AgentMetaDialog.vue`（新）：系统提示词全文 + 13 工具清单（code 名/中文名/数据·历史类型/描述/参数 Schema 折叠展示）

**文档**
- api.md：§18 重写为 SSE 流式（8 类事件表/两阶段错误/断开中止语义/`curl -N` 示例）；新增 §21 会话管理 / §22 Agent 元信息 / §23 调用链路 trace；通用约定补方法例外与 SSE 响应说明
- design.md：ADR **D17**（会话持久化：服务端唯一真相源/sqlite+JSON 兜底/上限修剪/断开落库语义）/ **D18**（SSE 流式 + 可观测：事件协议/流式聚合/res close 断开检测/trace 体积控制）、F12 范围行、架构图与两条数据流更新、映射表 +3 行、限制 12/15 重写、v2 候选更新
- README：功能清单 v1.5.0、AI 助手章节补会话持久化/流式/可观测说明、目录结构（chat-store.js/chatStore.js/TracePanel/AgentMetaDialog/chat.db）、文档索引接口计数

### 实现过程中的实测修正

| # | 发现 | 处理 |
|---|------|------|
| 1 | POST + SSE 下 `req` 的 `'close'` 在请求体读完后即触发（Node ≥18 语义），**不能**用于客户端断开检测——首版实现断开后 Agent 照常跑完并落库；用最小 http 探针（:9912/:9913）实测确认 `res` 的 `'close'` 才对应底层连接终止（正常 `res.end()` 后也触发，需 `writableEnded` 区分） | 断开检测改 `res.on('close')` + `!res.writableEnded` 才 abort；修复后实测断开仅落 user 消息（+1 条） |
| 2 | `EventSource` 不支持 POST（SSE 需携带 JSON body） | 前端 `apiPostSse`：fetch + ReadableStream 手工分帧解析，服务端加 `X-Accel-Buffering: no`（反代关闭缓冲保证逐字推送） |
| 3 | 流式 `tool_calls` 的 id/name/arguments 均可能分片或缺失（mock 故意将 name 拆为 `get_in`+`dices` 两帧验证） | 按 `delta.index` 聚合，id 缺失时兜底生成 `call_stream_N` |

### 验证记录（2026-11-12，本机 Node v24.14.0；mock 流式 LLM :9911 + 测试服务 :9910，行情上游真实可达；全部在 /tmp 副本运行，未触碰真实 server/data/）

| 项目 | 结果 |
|------|------|
| SSE 事件序列 | ✅ session→round_start→reasoning×2→tool_call→tool_result→round_start→reasoning→content×2→done，逐段推送、帧格式正确 |
| 流式 tool_calls 聚合 | ✅ name 分片（`get_in`+`dices`）+ arguments 分片正确聚合为 `get_indices {}` 并成功执行 |
| 真实工具链路 | ✅ get_indices 经 invokeRoute 返回**真实**三大指数数据（仅 LLM 为 mock），流式链路下数据工具复用正常 |
| 会话持久化 | ✅ 首条消息自动标题「今天大盘怎么样？」；messageCount、reasoning、toolTrace、traceId、createdAt 齐全；列表按 updatedAt 降序 |
| 多轮对话 | ✅ 第二轮服务端加载历史（trace inputMessages 2→4），前端不携带历史 |
| 调用链路 trace | ✅ rounds=2：每轮 reasoning/content/usage（1200/88/1288）/durationMs，toolCalls args/status/summary/durationMs/resultPreview 完整；未知 traceId → 404 |
| 客户端断开中止 | ✅ curl 1s 断开 → Agent 中止，库中仅 +1 条（user 消息），assistant 半截回答与 trace 未落库 |
| 会话 CRUD | ✅ 创建（可选 title）/重命名（title 必填 400 校验）/删除（级联：会话详情与 trace 均 404）/未知会话 404/空 message 400 |
| JSON 兜底后端 | ✅ 将 sqlite 路径指向非法目录 → 启动日志「会话存储: json」，SSE 全链路正常，chat.json 落库会话+消息+trace，API 读回一致 |
| 前端构建 | ✅ `vite build` 598 modules 成功（js 1202.83kB / gzip 400.79kB） |
| 语法检查 | ✅ `node --check` 服务端 5 个改动文件全部通过 |

测试数据清理：mock LLM（:9911）、测试服务（:9910）与探针进程已停止，`/tmp/wstest*` 已删除；无残留 node 进程。

**待补验证**：浏览器交互走查（流式逐字渲染观感、TracePanel/AgentMetaDialog 展示、切页/刷新后会话恢复——构建通过、组件逻辑经代码复核）；接入真实 LLM 后的流式对话质量与 token 消耗。

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
