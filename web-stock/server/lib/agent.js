/**
 * AI 选股 Agent：LLM function-calling 循环（v1.3.0）。
 *
 * 流程：用户消息 → LLM（携带工具定义）→ [tool_calls → 执行 → 结果回填]* → 最终文字回答。
 * 工具全部通过调用方注入的 invoke 复用本服务既有 REST 路由（api.js#invokeRoute），
 * 与页面查询共享快照/TTL 缓存，零新增上游接入（决策见 docs/design.md D14）。
 *
 * 依赖注入而非直接 import api.js：避免 api.js ↔ agent.js 的 ESM 循环引用。
 */

import { chatCompletions, getLlmConfig } from './llm.js';
import { getGroup } from './config.js';
import { archiveOverview, loadRecord, recentCalendarDates, recentWeekdayDates } from './history.js';

/** 工具 → 路由映射（label 用于前端调用轨迹展示） */
export const TOOL_ROUTES = {
    screen_stocks: { path: '/api/screen', label: '条件选股' },
    search_stock: { path: '/api/search', label: '股票搜索' },
    get_quote: { path: '/api/quote', label: '个股行情' },
    get_indices: { path: '/api/indices', label: '三大指数' },
    get_market_stats: { path: '/api/stats', label: '全市场统计' },
    get_ranking: { path: '/api/ranking', label: '涨跌幅排行' },
    get_hot_rank: { path: '/api/hot-rank', label: '人气热榜' },
    get_limitup_pool: { path: '/api/limitup/pool', label: '涨停池' },
    get_sectors: { path: '/api/sectors', label: '板块排行' },
    get_dragon_tiger: { path: '/api/dragon-tiger', label: '龙虎榜' },
};

/** 本地历史归档工具（不走 REST 路由，直接查 lib/history.js 归档，label 同前端展示） */
export const HISTORY_TOOLS = {
    history_overview: { label: '归档概览' },
    history_screen: { label: '历史筛选' },
    history_co_limitup: { label: '共同涨停关联' },
};

const num = (description) => ({ type: 'number', description });

/** OpenAI function-calling 工具定义（参数语义与 /api/screen 等路由一一对应，见 docs/api.md） */
const TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'screen_stocks',
            description:
                '条件选股（核心工具）：按指标区间过滤全市场 A 股并排序。' +
                '区间参数均可选，只传用户明确提到的边界（「涨幅超过5%」→ pctMin:5；「跌超3%」→ pctMax:-3）。' +
                '单位：成交额/市值为亿元；涨跌幅/换手率/60日涨幅/年初至今为百分数数值。' +
                '凡「筛选/选股/找/帮我挑 满足条件的股票」类请求优先用本工具。',
            parameters: {
                type: 'object',
                properties: {
                    pctMin: num('涨跌幅最小值 %'),
                    pctMax: num('涨跌幅最大值 %'),
                    turnoverMin: num('换手率最小值 %'),
                    turnoverMax: num('换手率最大值 %'),
                    amountMin: num('成交额最小值（亿元）'),
                    amountMax: num('成交额最大值（亿元）'),
                    mvMin: num('总市值最小值（亿元）'),
                    mvMax: num('总市值最大值（亿元）'),
                    circMvMin: num('流通市值最小值（亿元）'),
                    circMvMax: num('流通市值最大值（亿元）'),
                    peMin: num('市盈率TTM最小值（剔除亏损股传 0）'),
                    peMax: num('市盈率TTM最大值（「市盈率低于20」→ 20）'),
                    pbMin: num('市净率最小值'),
                    pbMax: num('市净率最大值'),
                    volumeRatioMin: num('量比最小值'),
                    volumeRatioMax: num('量比最大值'),
                    pct60Min: num('60日涨幅最小值 %'),
                    pct60Max: num('60日涨幅最大值 %'),
                    pctYtdMin: num('年初至今涨幅最小值 %'),
                    pctYtdMax: num('年初至今涨幅最大值 %'),
                    boards: {
                        type: 'array',
                        items: { type: 'string', enum: ['主板', '创业板', '科创板', '北交所'] },
                        description: '板块过滤：主板(60/00开头)、创业板(300/301)、科创板(688)、北交所；不传则不过滤',
                    },
                    excludeSt: { type: 'boolean', description: '排除 ST/风险警示股，默认 true' },
                    sort: {
                        type: 'string',
                        enum: ['pct', 'turnover', 'amount', 'amplitude', 'totalMv', 'circMv', 'pe', 'peTtm', 'pb', 'volumeRatio', 'pct60', 'pctYtd'],
                        description: '排序字段，默认 pct（涨跌幅）',
                    },
                    dir: { type: 'string', enum: ['desc', 'asc'], description: '排序方向，默认 desc；「跌幅榜/最弱」用 asc' },
                    limit: { type: 'integer', description: '返回条数 1–100，默认 30' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_stock',
            description: '股票搜索：按代码前缀或名称关键词找股票，用户提到股票名称而需要代码时使用。',
            parameters: {
                type: 'object',
                properties: { kw: { type: 'string', description: '关键词（代码前缀或名称子串，≤20 字符）' } },
                required: ['kw'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_quote',
            description: '单只股票实时行情明细：价格/涨跌/开高低收/量额/换手/振幅/市值/市盈率/市净率/量比/涨停跌停价等。',
            parameters: {
                type: 'object',
                properties: { code: { type: 'string', description: '6 位股票代码' } },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_indices',
            description: '三大指数（上证指数/深证成指/创业板指）最新行情，问「大盘/指数怎么样」时使用。',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_market_stats',
            description: '全市场涨跌统计：上涨/下跌/平盘/涨停/跌停/停牌家数，问「市场情绪/整体表现」时使用。',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_ranking',
            description: '全市场涨跌幅排行：order=desc 涨幅榜 / asc 跌幅榜。',
            parameters: {
                type: 'object',
                properties: {
                    order: { type: 'string', enum: ['desc', 'asc'], description: 'desc 涨幅榜（默认）/ asc 跌幅榜' },
                    limit: { type: 'integer', description: '条数 1–200，默认 20' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_hot_rank',
            description: '人气热榜：东财/同花顺/财联社/大智慧四平台合并的个股人气排行（各平台名次/人气标签/概念），问「热门股/人气/关注度」时使用。',
            parameters: {
                type: 'object',
                properties: { limit: { type: 'integer', description: '条数 1–300，默认 20' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_limitup_pool',
            description: '涨停池：当日（或指定交易日）涨停股明细，含几天几板/涨停原因/首封时间/开板次数/封单量，问「涨停/连板/最高板/什么题材」时使用。',
            parameters: {
                type: 'object',
                properties: { date: { type: 'string', description: '交易日 yyyyMMdd，缺省为今天' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_sectors',
            description: '板块排行：行业或概念板块实时排行（涨跌幅/换手/涨跌家数），问「哪些板块热/板块涨幅」时使用。',
            parameters: {
                type: 'object',
                properties: { type: { type: 'string', enum: ['industry', 'concept'], description: 'industry 行业（默认）/ concept 概念' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_dragon_tiger',
            description: '龙虎榜：上榜股票的净买卖额/上榜原因/游资机构净买，问「龙虎榜/游资/机构动向」时使用（收盘后约 17:00 发布）。',
            parameters: {
                type: 'object',
                properties: { date: { type: 'string', description: '交易日 yyyyMMdd，缺省为今天' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'history_overview',
            description:
                '查看本地历史归档覆盖情况：涨停池(limitup)/热榜(hotrank)/龙虎榜(dragontiger)/连板天梯(ladder) 各类型已归档天数、最早与最近日期。' +
                '涉及历史/跨日数据的问题先调用本工具确认覆盖范围；热榜与龙虎榜归档只能自系统启用之日起累积，无法回补更早历史。',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'history_screen',
            description:
                '跨日历史筛选（基于本地归档，可组合条件）：找出最近 N 天窗口内满足条件的股票。' +
                '示例：「最近3天有涨停且在热榜前50」→ days:3, hasLimitUp:true, hotRankMax:50；' +
                '「本周涨停过且上过龙虎榜」→ days:7, hasLimitUp:true, hasDragonTiger:true。' +
                '返回命中股票的逐日明细（涨停日期/几天几板/题材、热榜名次/日期、龙虎榜日期/净买额）与归档覆盖日期（缺口需如实告知用户）。',
            parameters: {
                type: 'object',
                properties: {
                    days: { type: 'integer', description: '回看窗口（自然日，含今天），1–60，默认 3' },
                    hasLimitUp: { type: 'boolean', description: '要求窗口内有涨停记录（涨停池归档）' },
                    hotRankMax: { type: 'integer', description: '要求窗口内任一平台热榜名次 ≤ N（如 50 即热榜前 50）' },
                    hasDragonTiger: { type: 'boolean', description: '要求窗口内上过龙虎榜' },
                    limit: { type: 'integer', description: '返回条数，默认 30' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'history_co_limitup',
            description:
                '共同涨停关联度：统计最近 N 个交易日中与目标股票「同一天都涨停」的其他股票，按共同涨停次数降序（关联度最高在前）。' +
                '用户问「与 XX 关联度最高的涨停股 / 跟 XX 一起涨停的股票」时使用。' +
                '涨停池归档缺口会自动向上游回补（最多回看 40 个交易日）；目标股票窗口内无涨停记录时无法计算，需说明并建议扩大 days。',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: '目标股票 6 位代码' },
                    days: { type: 'integer', description: '回看交易日数，3–40，默认 10' },
                    limit: { type: 'integer', description: '返回条数，默认 20' },
                },
                required: ['code'],
            },
        },
    },
];

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
    const beijingDate = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
    }).format(new Date());
    return [
        `你是「股票行情查询」终端的 AI 选股助手，服务中国 A 股投资者。今天是 ${beijingDate}（北京时间）。`,
        '',
        '## 数据原则',
        '1. 一切行情/筛选/统计数据必须通过调用工具实时获取，严禁凭记忆回答行情数值（训练数据已过时）。',
        '2. 工具返回字段为 null 表示数据缺失（停牌/新股/快照兜底源），如实说明，不要编造。',
        '3. 工具返回 error 时，向用户说明原因并给出可执行建议（调整条件、更换日期、稍后重试等）。',
        '',
        '## 历史归档与跨日查询（history_* 工具）',
        '- 系统按交易日归档 涨停池/热榜/龙虎榜/连板天梯；跨日历史问题（如「最近3天有涨停且在热榜前50」「与某股共同涨停关联度最高」）必须用 history_screen / history_co_limitup，不要用单日工具逐日拼凑。',
        '- 热榜/龙虎榜归档自系统启用之日起累积，无法回补更早历史；涨停池可自动回补（最多 40 个交易日）。',
        '- 回答历史问题前先 history_overview 确认归档覆盖，数据有缺口时如实说明（例如「热榜归档仅覆盖 X 天」）。',
        '',
        '## 筛选口径（screen_stocks）',
        '- 「涨幅超过N%」→ pctMin:N；「跌超N%」→ pctMax:-N；「准涨停」→ 主板 pctMin:7 且 pctMax:9.95。',
        '- 「低估值」→ peMin:0（剔亏损）+ 较小 peMax/pbMax；「小市值」→ mvMax（亿元）；「活跃/放量」→ turnoverMin 或 volumeRatioMin。',
        '- 用户未指定板块则不传 boards；未说明时默认排除 ST。',
        '- 条件模糊（如「帮我找强势股」）时采用合理默认口径，并在回答中明确说明所用条件。',
        '',
        '## 回答要求',
        '1. 用中文，先给结论再列明细；列举股票带 代码+名称+关键指标，一般不超过 10 只。',
        '2. 金额单位亿元、比率单位 %，与 A 股行情软件口径一致；红涨绿跌惯例无需在文字中体现。',
        '3. 纯文本输出：用「1. 2. 3.」编号和换行分段，禁止 markdown 语法（表格/星号加粗/反引号），前端不做渲染。',
        '4. 只提供客观数据与口径说明，不做投资建议；筛选类回答结尾附一句「数据仅供参考，不构成投资建议」。',
    ].join('\n');
}

// ---------------------------------------------------------------------------
// 工具结果压缩（控制回填 LLM 的 token 量）与股票 chips 收集
// ---------------------------------------------------------------------------

/** 快照股票的常用展示字段（screen/ranking 共用） */
const STOCK_FIELDS = [
    'code', 'name', 'price', 'pct', 'turnover', 'amount',
    'totalMv', 'circMv', 'peTtm', 'pb', 'volumeRatio', 'amplitude', 'pct60', 'pctYtd', 'board',
];

function pick(obj, keys) {
    const out = {};
    for (const key of keys) {
        if (obj?.[key] !== undefined) {
            out[key] = obj[key];
        }
    }
    return out;
}

/**
 * 工具结果压缩：只保留 LLM 回答所需字段并截断长列表，
 * 防止全量快照数据撑爆上下文（screen limit=100 时原始 JSON > 100KB）。
 */
function compactToolResult(tool, data) {
    switch (tool) {
        case 'screen_stocks':
            return {
                total: data.total,
                shown: Math.min(data.list.length, 50),
                list: data.list.slice(0, 50).map((s) => pick(s, STOCK_FIELDS)),
            };
        case 'search_stock':
            return { list: data.slice(0, 10).map((s) => pick(s, ['code', 'name', 'price', 'pct'])) };
        case 'get_quote':
            return pick(data, [...STOCK_FIELDS, 'change', 'open', 'high', 'low', 'preClose', 'volume', 'ztPrice', 'dtPrice', 'limitPct']);
        case 'get_indices':
            return data.map((i) => pick(i, ['code', 'name', 'close', 'pct', 'change', 'amount', 'date']));
        case 'get_market_stats':
            return data;
        case 'get_ranking':
            return { list: data.slice(0, 30).map((s) => pick(s, ['code', 'name', 'price', 'pct', 'turnover', 'amount'])) };
        case 'get_hot_rank':
            return {
                total: data.total,
                list: data.list.slice(0, 20).map((s) => ({
                    ...pick(s, ['code', 'name', 'price', 'pct', 'dfcfRank', 'thsRank', 'clsRank', 'dzhRank', 'popularityTag']),
                    concepts: (s.concepts ?? []).slice(0, 3),
                })),
            };
        case 'get_limitup_pool':
            return {
                date: data.date,
                tradeStatus: data.summary?.tradeStatus ?? null,
                total: data.list.length,
                list: data.list.slice(0, 40).map((s) =>
                    pick(s, ['code', 'name', 'price', 'pct', 'highDays', 'limitUpType', 'reasonType', 'openNum', 'turnover', 'circMv', 'firstLimitUpTime'])),
            };
        case 'get_sectors':
            return { list: data.slice(0, 20).map((s) => pick(s, ['code', 'name', 'pct', 'turnover', 'totalMv', 'upCount', 'downCount', 'flatCount'])) };
        case 'get_dragon_tiger':
            return {
                date: data.date,
                total: data.list.length,
                list: data.list.slice(0, 20).map((s) => pick(s, ['code', 'name', 'close', 'pct', 'explanation', 'netAmount', 'hotMoneyNet', 'orgNet'])),
            };
        default:
            return data;
    }
}

/** 从压缩结果中收集 6 位代码的 A 股（板块 BK 代码/指数自动排除），供前端渲染可点击 chips */
function collectStocks(payload, sink) {
    const rows = [...(Array.isArray(payload) ? payload : payload?.list ?? []), ...(payload?.coLimit ?? [])];
    for (const row of rows) {
        const code = String(row?.code ?? '');
        if (!/^\d{6}$/.test(code) || sink.has(code) || sink.size >= 60) {
            continue;
        }
        sink.set(code, { code, name: row.name ?? null, price: row.price ?? null, pct: row.pct ?? null });
    }
}

/** 工具调用轨迹摘要（前端气泡内「🔧 条件选股 · 命中 32 只」） */
function summarizeTool(tool, payload) {
    if (payload?.error) {
        return String(payload.error).slice(0, 60);
    }
    switch (tool) {
        case 'screen_stocks':
            return `命中 ${payload.total} 只`;
        case 'search_stock':
        case 'get_ranking':
            return `${payload.list?.length ?? 0} 条结果`;
        case 'get_quote':
            return payload.name ? `${payload.name} ${payload.price ?? ''}` : 'ok';
        case 'get_indices':
            return payload.map((i) => `${i.name} ${i.pct ?? '-'}%`).join(' / ');
        case 'get_market_stats':
            return `涨 ${payload.up} · 跌 ${payload.down} · 涨停 ${payload.limitUp}`;
        case 'get_hot_rank':
            return `人气前 ${payload.list?.length ?? 0}`;
        case 'get_limitup_pool':
            return `${payload.total ?? 0} 只涨停`;
        case 'get_sectors':
            return `${payload.list?.length ?? 0} 个板块`;
        case 'get_dragon_tiger':
            return `${payload.total ?? 0} 只上榜`;
        case 'history_overview':
            return Object.entries(payload.archive ?? {})
                .map(([type, info]) => `${type} ${info.days}天`)
                .join(' / ');
        case 'history_screen':
            return `命中 ${payload.total ?? 0} 只`;
        case 'history_co_limitup':
            return payload.targetLimitUpDays?.length
                ? `目标涨停 ${payload.targetLimitUpDays.length} 天 · 关联 ${payload.coLimit?.length ?? 0} 只`
                : '目标窗口内无涨停';
        default:
            return 'ok';
    }
}

// ---------------------------------------------------------------------------
// 历史归档工具实现（本地文件查询，缺口经 invoke 回补，见 lib/history.js）
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.min(Math.max(Math.trunc(num), min), max);
}

/** history_overview：归档覆盖概览 */
async function execHistoryOverview() {
    return { archive: await archiveOverview() };
}

/**
 * history_screen：跨日组合筛选（涨停 / 热榜名次 / 龙虎榜）。
 * 只依赖已归档数据，缺口日期在 archivedDates 中如实返回，由 LLM 向用户说明。
 */
async function execHistoryScreen(args) {
    const hasLimitUp = args.hasLimitUp === true;
    const hasDragonTiger = args.hasDragonTiger === true;
    const hotRankMax = Number.isFinite(Number(args.hotRankMax)) && args.hotRankMax !== null && args.hotRankMax !== undefined
        ? clampInt(args.hotRankMax, 1, 300, 50)
        : null;
    if (!hasLimitUp && !hasDragonTiger && hotRankMax === null) {
        return { error: '至少指定一个筛选条件：hasLimitUp / hotRankMax / hasDragonTiger' };
    }
    const days = clampInt(args.days, 1, 60, 3);
    const limit = clampInt(args.limit, 1, 100, 30);
    const dates = recentCalendarDates(days); // 降序含今天

    const byCode = new Map();
    const ensure = (code, name) => {
        if (!byCode.has(code)) {
            byCode.set(code, { code, name: name ?? null, limitUpDays: [], hotHits: [], dtDays: [] });
        }
        const entry = byCode.get(code);
        if (entry.name === null && name) {
            entry.name = name;
        }
        return entry;
    };
    const archived = { limitup: [], hotrank: [], dragontiger: [] };

    for (const date of dates) {
        const pool = await loadRecord('limitup', date);
        if (pool?.list?.length) {
            archived.limitup.push(date);
            for (const s of pool.list) {
                ensure(s.code, s.name).limitUpDays.push({ date, highDays: s.highDays ?? null, reasonType: s.reasonType ?? null });
            }
        }
        const hot = await loadRecord('hotrank', date);
        if (hot?.list?.length) {
            archived.hotrank.push(date);
            for (const s of hot.list) {
                const ranks = [s.dfcfRank, s.thsRank, s.clsRank, s.dzhRank].filter((r) => typeof r === 'number');
                if (ranks.length === 0) {
                    continue;
                }
                const rank = Math.min(...ranks);
                if (hotRankMax !== null && rank > hotRankMax) {
                    continue;
                }
                ensure(s.code, s.name).hotHits.push({ date, rank, dfcfRank: s.dfcfRank ?? null, thsRank: s.thsRank ?? null });
            }
        }
        const dt = await loadRecord('dragontiger', date);
        if (dt?.list?.length) {
            archived.dragontiger.push(date);
            for (const s of dt.list) {
                ensure(s.code, s.name).dtDays.push({ date, netAmount: s.netAmount ?? null, explanation: s.explanation ?? null });
            }
        }
    }

    const bestRank = (entry) => (entry.hotHits.length ? Math.min(...entry.hotHits.map((h) => h.rank)) : null);
    const matched = [...byCode.values()].filter((entry) => {
        if (hasLimitUp && entry.limitUpDays.length === 0) {
            return false;
        }
        if (hotRankMax !== null && entry.hotHits.length === 0) {
            return false;
        }
        if (hasDragonTiger && entry.dtDays.length === 0) {
            return false;
        }
        return true;
    });
    matched.sort(
        (a, b) =>
            b.limitUpDays.length - a.limitUpDays.length ||
            (bestRank(a) ?? Number.MAX_SAFE_INTEGER) - (bestRank(b) ?? Number.MAX_SAFE_INTEGER) ||
            b.dtDays.length - a.dtDays.length,
    );

    return {
        window: { days, from: dates[dates.length - 1], to: dates[0] },
        conditions: { hasLimitUp, hotRankMax, hasDragonTiger },
        archivedDates: archived, // 窗口内实际有归档的日期（降序）；缺口须向用户说明
        total: matched.length,
        list: matched.slice(0, limit).map((entry) => ({
            code: entry.code,
            name: entry.name,
            limitUpCount: entry.limitUpDays.length,
            limitUpDays: entry.limitUpDays.slice(0, 5),
            bestHotRank: bestRank(entry),
            hotDays: entry.hotHits.slice(0, 5),
            dragonTigerDays: entry.dtDays.slice(0, 5),
        })),
    };
}

/**
 * history_co_limitup：与目标股票共同涨停的关联度排行。
 * 归档缺口自动经 invoke('/api/limitup/pool') 回补（触发 write-through 归档），批 5 并发、单日失败容忍。
 */
async function execHistoryCoLimitup(args, invoke) {
    const code = String(args.code ?? '');
    if (!/^\d{6}$/.test(code)) {
        return { error: '参数 code 必须为 6 位股票代码' };
    }
    const days = clampInt(args.days, 3, 40, 10);
    const limit = clampInt(args.limit, 1, 60, 20);
    const dates = recentWeekdayDates(days); // 降序含今天（跳过周末，不识别节假日）

    // 归档缺口回补（含今天；空归档文件视为已覆盖，不再重复拉取）
    const missing = [];
    for (const date of dates) {
        if ((await loadRecord('limitup', date)) === null) {
            missing.push(date);
        }
    }
    let backfilled = 0;
    for (let start = 0; start < missing.length; start += 5) {
        const batch = missing.slice(start, start + 5);
        const settled = await Promise.allSettled(batch.map((date) => invoke('/api/limitup/pool', { date })));
        backfilled += settled.filter((r) => r.status === 'fulfilled').length;
    }

    // 统计：目标涨停日 + 同日的其他涨停股
    let targetName = null;
    const targetDays = [];
    const coMap = new Map();
    let archivedDays = 0;
    for (const date of dates) {
        const pool = await loadRecord('limitup', date);
        if (!pool?.list?.length) {
            continue;
        }
        archivedDays += 1;
        const target = pool.list.find((s) => s.code === code);
        if (!target) {
            continue;
        }
        targetName = targetName ?? target.name ?? null;
        targetDays.push({ date, highDays: target.highDays ?? null, reasonType: target.reasonType ?? null });
        for (const s of pool.list) {
            if (s.code === code) {
                continue;
            }
            let entry = coMap.get(s.code);
            if (!entry) {
                // dates 降序遍历：首次出现即最近一次，highDays/reasonType 取最新口径
                entry = { code: s.code, name: s.name ?? null, count: 0, dates: [], highDays: s.highDays ?? null, reasonType: s.reasonType ?? null };
                coMap.set(s.code, entry);
            }
            entry.count += 1;
            entry.dates.push(date);
        }
    }

    if (targetDays.length === 0) {
        return {
            code,
            targetName,
            window: { tradingDays: dates.length, archivedDays, from: dates[dates.length - 1], to: dates[0] },
            targetLimitUpDays: [],
            coLimit: [],
            note: '目标股票窗口内无涨停记录，无法计算共同涨停关联；可扩大 days 或先用 search_stock/get_quote 确认该股近期走势',
        };
    }

    const coLimit = [...coMap.values()]
        .sort((a, b) => b.count - a.count || (a.dates[0] < b.dates[0] ? 1 : -1))
        .slice(0, limit);
    return {
        code,
        targetName,
        window: { tradingDays: dates.length, archivedDays, from: dates[dates.length - 1], to: dates[0], backfilled },
        targetLimitUpDays: targetDays,
        coLimit,
    };
}

/** 历史归档工具分发 */
async function execHistoryTool(name, args, invoke) {
    switch (name) {
        case 'history_overview':
            return execHistoryOverview();
        case 'history_screen':
            return execHistoryScreen(args);
        case 'history_co_limitup':
            return execHistoryCoLimitup(args, invoke);
        default:
            return { error: `未知历史工具: ${name}` };
    }
}

// ---------------------------------------------------------------------------
// Agent 主循环
// ---------------------------------------------------------------------------

/**
 * 执行 Agent：LLM function-calling 循环直至产出最终回答
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} history 对话历史（最后一条须为 user，调用方已校验）
 * @param {(pathname: string, params: Record<string, any>) => Promise<{data: any, meta?: object}>} invoke 内部路由转发（api.js#invokeRoute）
 * @returns {Promise<{reply: string, toolTrace: Array<object>, stocks: Array<object>, model: string, llmRounds: number, truncated: boolean}>}
 */
export async function runAgent(history, invoke) {
    const config = getLlmConfig();
    // LLM 最大交互轮数（防工具死循环；正常问题 1–3 轮）。取自 config.agent.maxRounds，可热改（v1.4.0）。
    const maxRounds = getGroup('agent').maxRounds;
    const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history];
    const toolTrace = [];
    const stockSink = new Map();
    let llmRounds = 0;

    for (let round = 0; round < maxRounds; round += 1) {
        const reply = await chatCompletions({ messages, tools: TOOL_DEFS });
        llmRounds += 1;
        messages.push(reply);

        const calls = reply.tool_calls ?? [];
        if (calls.length === 0) {
            return {
                reply: (reply.content ?? '').trim() || '（模型未返回内容，请重试或换个问法）',
                toolTrace,
                stocks: [...stockSink.values()],
                model: config.model,
                llmRounds,
                truncated: false,
            };
        }

        for (const call of calls) {
            const name = call?.function?.name ?? '';
            const route = TOOL_ROUTES[name];
            const isHistory = Object.prototype.hasOwnProperty.call(HISTORY_TOOLS, name);
            const trace = { tool: name, label: route?.label ?? HISTORY_TOOLS[name]?.label ?? name, args: {}, status: 'ok', summary: '' };

            let args = null;
            try {
                args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
                trace.args = args;
            } catch {
                trace.args = { raw: String(call?.function?.arguments ?? '').slice(0, 200) }; // 参数 JSON 非法
            }

            let payload;
            if (!route && !isHistory) {
                payload = { error: `未知工具: ${name}` };
                trace.status = 'error';
                trace.summary = '未知工具';
            } else if (args === null) {
                payload = { error: '工具参数不是合法 JSON，请重新生成参数后再调用' };
                trace.status = 'error';
                trace.summary = '参数解析失败';
            } else if (isHistory) {
                // 历史归档工具：本地文件查询（缺口经 invoke 回补），返回值已压缩无需再 compact
                try {
                    payload = await execHistoryTool(name, args, invoke);
                    collectStocks(payload, stockSink);
                    trace.summary = summarizeTool(name, payload);
                    if (payload?.error) {
                        trace.status = 'error';
                    }
                } catch (error) {
                    payload = { error: `工具执行失败: ${error.message}` };
                    trace.status = 'error';
                    trace.summary = String(error.message).slice(0, 60);
                }
            } else {
                try {
                    const { data } = await invoke(route.path, args);
                    payload = compactToolResult(name, data);
                    collectStocks(payload, stockSink);
                    trace.summary = summarizeTool(name, payload);
                } catch (error) {
                    // 路由层 ApiError（参数校验 400 等）与上游失败（502）均回填给模型自行修正
                    payload = { error: `工具执行失败: ${error.message}` };
                    trace.status = 'error';
                    trace.summary = String(error.message).slice(0, 60);
                }
            }
            toolTrace.push(trace);
            messages.push({
                role: 'tool',
                tool_call_id: call?.id ?? `call_${round}_${toolTrace.length}`,
                content: JSON.stringify(payload),
            });
        }
    }

    // 达到最大轮数模型仍在调工具：返回已收集信息的中断提示
    return {
        reply: '本次问题涉及的数据调用过多，已中止。请把需求说得更具体一些（例如指明板块、涨跌幅区间、换手率等条件）后重试。',
        toolTrace,
        stocks: [...stockSink.values()],
        model: config.model,
        llmRounds,
        truncated: true,
    };
}
