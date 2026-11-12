/**
 * /api/* 路由层：参数校验 → 缓存 → 数据源调用 → 统一响应包装。
 *
 * 响应信封（详见 docs/api.md）：
 *   成功 { "data": ..., "meta": { "source", "fetchedAt", "fromCache" } }
 *   失败 { "error": { "status", "message" } }
 */

import { cached } from './lib/cache.js';
import { isTradingTime, secIdForStock, boardNameOf, limitPctOf, todayYyyymmdd, ttlBySession } from './lib/market.js';
import { runAgent } from './lib/agent.js';
import { isLlmConfigured, LlmConfigError, LlmError } from './lib/llm.js';
import { saveRecordThrottled } from './lib/history.js';
import { getConfig, getGroup, maskSecrets, update as updateConfig, ConfigError, storeInfo } from './lib/config.js';
import * as eastmoney from './sources/eastmoney.js';
import * as sina from './sources/sina.js';
import * as sohu from './sources/sohu.js';
import * as ths from './sources/ths.js';
import * as cls from './sources/cls.js';
import * as dzh from './sources/dzh.js';

/** 带 HTTP 状态码的业务错误 */
export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

// ---------------------------------------------------------------------------
// 缓存 TTL（config.cache 驱动，v1.4.0）
// ---------------------------------------------------------------------------

/**
 * 按配置选择缓存 TTL：读 config.cache[key]（{trading,closed} 秒），交交易时段判断折算为毫秒。
 * 使用时调用（勿缓存），设置页改值后下一次取数即生效。
 *
 * @param {string} key config.js CACHE_KEYS 之一（snapshot/indices/kline/...）
 * @returns {number} TTL 毫秒
 */
function cacheTtl(key) {
    const entry = getGroup('cache')[key];
    return ttlBySession(entry.trading * 1000, entry.closed * 1000);
}

// ---------------------------------------------------------------------------
// 全市场快照（东财主源 → 新浪兜底），交易时段 30s / 收盘 10min
// ---------------------------------------------------------------------------

async function getSnapshot() {
    return cached('snapshot', cacheTtl('snapshot'), async () => {
        try {
            return await eastmoney.fetchFullSnapshot();
        } catch (eastError) {
            console.warn(`[snapshot] 东财快照失败，切换新浪兜底: ${eastError.message}`);
            return await sina.fetchFullSnapshot();
        }
    });
}

// ---------------------------------------------------------------------------
// 涨停数据共享缓存 getter（涨停池 / 复盘 / 连板天梯 / 涨停关联性 共用，
// 同日期只拉一次上游；缓存 key 与 /api/limitup/pool、/api/limitup/replay 一致）
// ---------------------------------------------------------------------------

function getLimitUpPool(date) {
    return cached(`limitup:pool:${date}`, cacheTtl('limitup'), async () => ths.fetchLimitUpPool(date));
}

function getZtReplay(date) {
    return cached(`limitup:replay:${date}`, cacheTtl('limitup'), async () => ths.fetchZtReplay(date));
}

// ---------------------------------------------------------------------------
// 参数校验工具
// ---------------------------------------------------------------------------

function requireStockCode(params) {
    const code = params.get('code');
    if (!code || !/^\d{6}$/.test(code)) {
        throw new ApiError(400, '参数 code 必须为 6 位数字股票代码');
    }
    return code;
}

function requireBkCode(params) {
    const bk = params.get('bk');
    if (!bk || !/^BK\d{4,6}$/i.test(bk)) {
        throw new ApiError(400, '参数 bk 必须为板块代码（如 BK0482）');
    }
    return bk.toUpperCase();
}

function optionalTradeDate(params) {
    const date = params.get('date') || todayYyyymmdd();
    if (!/^\d{8}$/.test(date)) {
        throw new ApiError(400, '参数 date 必须为 yyyyMMdd 格式');
    }
    if (date > todayYyyymmdd()) {
        throw new ApiError(400, '参数 date 不能晚于今天');
    }
    return date;
}

function clampInt(params, key, defaultValue, min, max) {
    const raw = params.get(key);
    if (raw === null || raw === '') {
        return defaultValue;
    }
    const num = Number(raw);
    if (!Number.isInteger(num)) {
        throw new ApiError(400, `参数 ${key} 必须为整数`);
    }
    return Math.min(Math.max(num, min), max);
}

/** 可选数值参数（空串/缺省 → null；非法数字 → 400） */
function optionalNumber(params, key) {
    const raw = params.get(key);
    if (raw === null || raw === '') {
        return null;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
        throw new ApiError(400, `参数 ${key} 必须为数字`);
    }
    return num;
}

/** /api/screen 支持的板块过滤值（与 lib/market.js#boardNameOf 输出一致） */
const SCREEN_BOARDS = ['主板', '创业板', '科创板', '北交所'];

/** /api/screen 支持的排序字段（均为快照归一化字段） */
const SCREEN_SORT_KEYS = [
    'pct',
    'turnover',
    'amount',
    'amplitude',
    'totalMv',
    'circMv',
    'pe',
    'peTtm',
    'pb',
    'volumeRatio',
    'pct60',
    'pctYtd',
];

/**
 * 涨停池 highDays 字符串 → {days, boards}
 * 「首板」= 1天1板；「N天M板」= N 天内 M 次涨停；无法解析返回 null（按首板处理）。
 */
function parseHighDays(highDays) {
    const text = String(highDays ?? '');
    if (text === '首板') {
        return { days: 1, boards: 1 };
    }
    const match = text.match(/(?:(\d+)天)?(\d+)板/);
    if (!match) {
        return null;
    }
    const boards = Number(match[2]);
    return { days: Number(match[1] ?? boards), boards };
}

/** yyyyMMdd → 前一自然日（UTC 正午锚定，避免时区偏移） */
function shiftDate8(date8, deltaDays) {
    const base = Date.UTC(Number(date8.slice(0, 4)), Number(date8.slice(4, 6)) - 1, Number(date8.slice(6, 8)), 12);
    const shifted = new Date(base + deltaDays * 86_400_000);
    return shifted.toISOString().slice(0, 10).replaceAll('-', '');
}

function metaOf(result, extra = {}) {
    return {
        source: result.value?.source ?? 'unknown',
        fetchedAt: new Date().toISOString(),
        fromCache: result.fromCache,
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// 历史归档 write-through（v1.3.0，见 lib/history.js 与 docs/design.md D15）
// ---------------------------------------------------------------------------

/**
 * 路由数据落盘归档（fire-and-forget，失败仅告警不影响接口响应）。
 * 空列表也归档（节假日/盘前占位，防止 Agent 历史查询反复回补拉取）；
 * 同日数据变化由 saveRecordThrottled 的 10min 节流窗口覆盖（采集器周期刷新）。
 *
 * @param {string} type limitup | hotrank | dragontiger | ladder
 * @param {string} date8 交易日 yyyyMMdd（热榜为抓取日）
 * @param {any} data 路由 data
 */
function archive(type, date8, data) {
    saveRecordThrottled(type, date8, data).catch((error) => {
        console.warn(`[history] 归档 ${type}:${date8} 失败: ${error.message}`);
    });
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

/** @type {Record<string, (params: URLSearchParams) => Promise<{data: any, meta?: object}>>} */
const routes = {
    /** 服务健康状态 */
    '/api/health': async () => ({
        data: {
            ok: true,
            version: '1.4.0',
            isTradingTime: isTradingTime(),
            serverTime: new Date().toISOString(),
            llmConfigured: isLlmConfigured(),
        },
    }),

    /**
     * 全量配置（设置页读取用，v1.4.0）。
     * 密钥脱敏：llm.accessToken 不回显，仅返回 accessTokenSet 布尔（见 config.js#maskSecrets）。
     */
    '/api/config': async () => ({
        data: maskSecrets(getConfig()),
        meta: { source: 'config', fetchedAt: new Date().toISOString(), fromCache: false, store: storeInfo() },
    }),

    /** 三大指数最新行情（东财 kline lmt=1，app 端 getRealTimeIndexByCode 同款） */
    '/api/indices': async () => {
        const result = await cached('indices', cacheTtl('indices'), async () => {
            const quotes = await Promise.all(eastmoney.INDICES.map((index) => eastmoney.fetchIndexQuote(index)));
            return { source: 'eastmoney:push2his', indices: quotes };
        });
        return { data: result.value.indices, meta: metaOf(result) };
    },

    /** 全市场涨跌统计（基于快照） */
    '/api/stats': async () => {
        const result = await getSnapshot();
        const stocks = result.value.stocks;
        let up = 0;
        let down = 0;
        let flat = 0;
        let suspended = 0;
        let limitUp = 0;
        let limitDown = 0;
        for (const stock of stocks) {
            if (stock.price === null) {
                suspended += 1;
                continue;
            }
            if (stock.pct > 0) {
                up += 1;
            } else if (stock.pct < 0) {
                down += 1;
            } else {
                flat += 1;
            }
            if (stock.ztPrice !== null && stock.price >= stock.ztPrice) {
                limitUp += 1;
            }
            if (stock.dtPrice !== null && stock.price <= stock.dtPrice) {
                limitDown += 1;
            }
        }
        return {
            data: { total: stocks.length, up, down, flat, suspended, limitUp, limitDown },
            meta: metaOf(result),
        };
    },

    /** 涨跌幅排行（order=desc 涨幅榜 / asc 跌幅榜） */
    '/api/ranking': async (params) => {
        const order = params.get('order') === 'asc' ? 'asc' : 'desc';
        const limit = clampInt(params, 'limit', 20, 1, 200);
        const result = await getSnapshot();
        const sorted = [...result.value.stocks]
            .filter((stock) => stock.pct !== null)
            .sort((a, b) => (order === 'desc' ? b.pct - a.pct : a.pct - b.pct));
        return { data: sorted.slice(0, limit), meta: metaOf(result, { order }) };
    },

    /** 条件选股：快照指标区间过滤 + 排序（选股器模块，见 docs/api.md §13） */
    '/api/screen': async (params) => {
        const pctMin = optionalNumber(params, 'pctMin');
        const pctMax = optionalNumber(params, 'pctMax');
        const turnoverMin = optionalNumber(params, 'turnoverMin');
        const turnoverMax = optionalNumber(params, 'turnoverMax');
        // 成交额/市值参数单位为「亿」，快照字段单位为「元」
        const amountMin = optionalNumber(params, 'amountMin');
        const amountMax = optionalNumber(params, 'amountMax');
        const mvMin = optionalNumber(params, 'mvMin');
        const mvMax = optionalNumber(params, 'mvMax');
        const circMvMin = optionalNumber(params, 'circMvMin');
        const circMvMax = optionalNumber(params, 'circMvMax');
        // 估值与活跃度指标（v1.2.0，东财快照 f9/f115/f23/f10/f24/f25；兜底源为 null）
        const peMin = optionalNumber(params, 'peMin'); // 市盈率 TTM
        const peMax = optionalNumber(params, 'peMax');
        const pbMin = optionalNumber(params, 'pbMin');
        const pbMax = optionalNumber(params, 'pbMax');
        const volumeRatioMin = optionalNumber(params, 'volumeRatioMin');
        const volumeRatioMax = optionalNumber(params, 'volumeRatioMax');
        const pct60Min = optionalNumber(params, 'pct60Min');
        const pct60Max = optionalNumber(params, 'pct60Max');
        const pctYtdMin = optionalNumber(params, 'pctYtdMin');
        const pctYtdMax = optionalNumber(params, 'pctYtdMax');
        const excludeSt = params.get('excludeSt') !== '0';
        const boardsRaw = (params.get('boards') ?? '').trim();
        const boards = boardsRaw ? boardsRaw.split(',') : [];
        for (const board of boards) {
            if (!SCREEN_BOARDS.includes(board)) {
                throw new ApiError(400, `参数 boards 含不支持的板块: ${board}（可选: ${SCREEN_BOARDS.join('/')}）`);
            }
        }
        const sortParam = params.get('sort');
        const sortKey = SCREEN_SORT_KEYS.includes(sortParam) ? sortParam : 'pct';
        const sortDir = params.get('dir') === 'asc' ? 'asc' : 'desc';
        const limit = clampInt(params, 'limit', 100, 1, 300);

        const result = await getSnapshot();
        const toYuan = (yi) => (yi === null ? null : yi * 1e8);
        const inRange = (value, min, max) => {
            if (min === null && max === null) {
                return true;
            }
            if (value === null) {
                return false; // 设了阈值但字段缺失（如新浪兜底源无换手率）→ 不入选
            }
            return (min === null || value >= min) && (max === null || value <= max);
        };

        const matched = result.value.stocks.filter((stock) => {
            if (stock.price === null || stock.pct === null) {
                return false; // 停牌不参与选股
            }
            if (excludeSt && String(stock.name ?? '').includes('ST')) {
                return false;
            }
            if (boards.length > 0 && !boards.includes(boardNameOf(stock.code, stock.name))) {
                return false;
            }
            return (
                inRange(stock.pct, pctMin, pctMax) &&
                inRange(stock.turnover, turnoverMin, turnoverMax) &&
                inRange(stock.amount, toYuan(amountMin), toYuan(amountMax)) &&
                inRange(stock.totalMv, toYuan(mvMin), toYuan(mvMax)) &&
                inRange(stock.circMv, toYuan(circMvMin), toYuan(circMvMax)) &&
                inRange(stock.peTtm, peMin, peMax) &&
                inRange(stock.pb, pbMin, pbMax) &&
                inRange(stock.volumeRatio, volumeRatioMin, volumeRatioMax) &&
                inRange(stock.pct60, pct60Min, pct60Max) &&
                inRange(stock.pctYtd, pctYtdMin, pctYtdMax)
            );
        });
        const factor = sortDir === 'desc' ? -1 : 1;
        matched.sort((a, b) => {
            const av = a[sortKey];
            const bv = b[sortKey];
            if (av === null && bv === null) {
                return 0;
            }
            if (av === null) {
                return 1; // 缺失值排最后
            }
            if (bv === null) {
                return -1;
            }
            return (av - bv) * factor;
        });
        const list = matched.slice(0, limit).map((stock) => ({
            ...stock,
            board: boardNameOf(stock.code, stock.name),
        }));
        return {
            data: { total: matched.length, list },
            meta: metaOf(result, { sort: sortKey, dir: sortDir }),
        };
    },

    /** 股票搜索（代码前缀 / 名称子串，基于快照） */
    '/api/search': async (params) => {
        const kw = (params.get('kw') ?? '').trim();
        if (!kw || kw.length > 20) {
            throw new ApiError(400, '参数 kw 不能为空且不超过 20 个字符');
        }
        const result = await getSnapshot();
        const kwLower = kw.toLowerCase();
        const isDigits = /^\d+$/.test(kw);

        const scored = [];
        for (const stock of result.value.stocks) {
            const name = stock.name ?? '';
            let score;
            if (isDigits) {
                if (stock.code === kw) {
                    score = 0;
                } else if (stock.code.startsWith(kw)) {
                    score = 1;
                } else {
                    continue;
                }
            } else if (name === kw) {
                score = 0;
            } else if (name.toLowerCase().startsWith(kwLower)) {
                score = 2;
            } else if (name.toLowerCase().includes(kwLower)) {
                score = 3;
            } else {
                continue;
            }
            scored.push({ score, stock });
        }
        scored.sort((a, b) => a.score - b.score || (b.stock.pct ?? -999) - (a.stock.pct ?? -999));
        return { data: scored.slice(0, 20).map((entry) => entry.stock), meta: metaOf(result, { kw }) };
    },

    /** 单只股票实时行情 */
    '/api/quote': async (params) => {
        const code = requireStockCode(params);
        const result = await getSnapshot();
        const stock = result.value.stocks.find((item) => item.code === code);
        if (!stock) {
            throw new ApiError(404, `快照中未找到股票 ${code}`);
        }
        return {
            data: {
                ...stock,
                board: boardNameOf(stock.code, stock.name),
                limitPct: limitPctOf(stock.code, stock.name),
            },
            meta: metaOf(result),
        };
    },

    /** 个股日 K 线（东财前复权 → 搜狐兜底） */
    '/api/kline': async (params) => {
        const code = requireStockCode(params);
        const days = clampInt(params, 'days', 120, 30, 1200);
        const result = await cached(
            `kline:${code}:${days}`,
            cacheTtl('kline'),
            async () => {
                try {
                    const kline = await eastmoney.fetchKline(secIdForStock(code), days);
                    return { ...kline, source: 'eastmoney:push2his' };
                } catch (eastError) {
                    console.warn(`[kline] 东财失败，切换搜狐兜底 ${code}: ${eastError.message}`);
                    // 回溯日历天数 ≈ 交易日数 × 1.6 + 30（覆盖节假日与周末）
                    const end = new Date();
                    const start = new Date(end.getTime() - Math.ceil(days * 1.6 + 30) * 86400_000);
                    const fmt = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
                    const kline = await sohu.fetchKline(code, fmt(start), fmt(end));
                    return { ...kline, klines: kline.klines.slice(-days), source: 'sohu:hisHq' };
                }
            },
        );
        return { data: result.value, meta: metaOf(result) };
    },

    /** 板块实时行情（type=industry 行业 / concept 概念） */
    '/api/sectors': async (params) => {
        const type = params.get('type') === 'concept' ? 'concept' : 'industry';
        const result = await cached(`sectors:${type}`, cacheTtl('sectors'), async () => {
            return await eastmoney.fetchSectors(type);
        });
        return { data: result.value.sectors, meta: metaOf(result, { type }) };
    },

    /** 板块成份股实时行情 */
    '/api/sectors/stocks': async (params) => {
        const bk = requireBkCode(params);
        const result = await cached(`bkstocks:${bk}`, cacheTtl('bkstocks'), async () => {
            return await eastmoney.fetchBkStocks(bk);
        });
        return { data: result.value.stocks, meta: metaOf(result, { bk }) };
    },

    /** 涨停池（同花顺） */
    '/api/limitup/pool': async (params) => {
        const date = optionalTradeDate(params);
        const result = await getLimitUpPool(date);
        archive('limitup', date, result.value);
        return { data: result.value, meta: metaOf(result) };
    },

    /** 涨停复盘（同花顺，按题材分组） */
    '/api/limitup/replay': async (params) => {
        const date = optionalTradeDate(params);
        const result = await getZtReplay(date);
        return { data: result.value, meta: metaOf(result) };
    },

    /**
     * 连板天梯：当日涨停池按连板数分层（高度板在前）。
     * 复用涨停池缓存，零新增上游请求；层内按 天数少者优先（N板N天最强）、再按首封时间。
     */
    '/api/ladder': async (params) => {
        const date = optionalTradeDate(params);
        const result = await cached(`ladder:${date}`, cacheTtl('ladder'), async () => {
            const poolResult = await getLimitUpPool(date);
            const pool = poolResult.value;
            const tierMap = new Map(); // boards → stocks
            for (const stock of pool.list) {
                const parsed = parseHighDays(stock.highDays);
                const boards = parsed?.boards ?? 1;
                const days = parsed?.days ?? 1;
                if (!tierMap.has(boards)) {
                    tierMap.set(boards, []);
                }
                tierMap.get(boards).push({ ...stock, ladderDays: days });
            }
            const tiers = [...tierMap.entries()]
                .sort((a, b) => b[0] - a[0])
                .map(([boards, stocks]) => {
                    stocks.sort(
                        (a, b) =>
                            a.ladderDays - b.ladderDays ||
                            String(a.firstLimitUpTime ?? '99:99:99').localeCompare(String(b.firstLimitUpTime ?? '99:99:99')),
                    );
                    return { boards, label: boards === 1 ? '首板' : `${boards}连板`, count: stocks.length, stocks };
                });
            return {
                source: pool.source,
                date,
                tradeStatus: pool.summary?.tradeStatus ?? null,
                totalCount: pool.list.length,
                maxBoards: tiers[0]?.boards ?? 0,
                tiers,
            };
        });
        archive('ladder', date, result.value);
        return { data: result.value, meta: metaOf(result) };
    },

    /**
     * 涨停关联性：目标股票（须在当日涨停池）的 题材关联（block_top 同组）+
     * 近 N 个交易日「共同涨停」统计（同一天双双涨停的次数与日期）。
     * 历史涨停池逐日回看（跳过周末，批 5 并发，取满 N 个交易日为止），全部复用池缓存。
     */
    '/api/limitup/related': async (params) => {
        const code = requireStockCode(params);
        const date = optionalTradeDate(params);
        const days = clampInt(params, 'days', 10, 3, 20);
        const result = await cached(`limitup:related:${code}:${date}:${days}`, cacheTtl('related'), async () => {
            const pool = (await getLimitUpPool(date)).value;
            const target = pool.list.find((item) => item.code === code);
            if (!target) {
                throw new ApiError(404, `${code} 在 ${date} 不在涨停池，请更换日期或股票`);
            }

            // 题材关联：包含该股票的涨停复盘分组（block_top 失败可容忍）
            let themes = null;
            try {
                const replay = (await getZtReplay(date)).value;
                themes = replay.groups
                    .filter((group) => (group.stocks ?? []).some((item) => item.code === code))
                    .map((group) => ({
                        code: group.code,
                        name: group.name,
                        days: group.days,
                        limitUpNum: group.limitUpNum,
                        stocks: group.stocks,
                    }));
            } catch (error) {
                console.warn(`[related] 涨停复盘获取失败，题材关联不可用: ${error.message}`);
            }

            // 历史窗口：向前回看，收集 days 个有数据的交易日（跳过周末，批 5 并发）
            const candidates = [];
            for (let i = 1; candidates.length < 45 && i <= 70; i += 1) {
                const candidate = shiftDate8(date, -i);
                const weekday = new Date(
                    `${candidate.slice(0, 4)}-${candidate.slice(4, 6)}-${candidate.slice(6, 8)}T12:00:00Z`,
                ).getUTCDay();
                if (weekday !== 0 && weekday !== 6) {
                    candidates.push(candidate);
                }
            }
            const history = [];
            for (let start = 0; start < candidates.length && history.length < days; start += 5) {
                const batch = candidates.slice(start, start + 5);
                const settled = await Promise.all(
                    batch.map(async (d) => {
                        try {
                            return { date: d, pool: (await getLimitUpPool(d)).value };
                        } catch {
                            return { date: d, pool: null }; // 单日失败容忍，窗口继续
                        }
                    }),
                );
                for (const item of settled) {
                    if (item.pool && item.pool.list.length > 0) {
                        history.push(item);
                    }
                    if (history.length >= days) {
                        break;
                    }
                }
            }

            // 共同涨停统计：仅在目标股票也涨停的历史日里计数
            const coMap = new Map(); // code → {stock, dates[]}
            const targetLimitUpDays = [];
            for (const item of history) {
                const present = item.pool.list.find((stock) => stock.code === code);
                if (!present) {
                    continue;
                }
                targetLimitUpDays.push(item.date);
                for (const stock of item.pool.list) {
                    if (stock.code === code) {
                        continue;
                    }
                    const entry = coMap.get(stock.code) ?? { stock, dates: [] };
                    entry.dates.push(item.date);
                    entry.stock = stock; // 保留最近一次出现时的信息
                    coMap.set(stock.code, entry);
                }
            }
            const todayCodes = new Set(pool.list.map((stock) => stock.code));
            const coLimit = [...coMap.values()]
                .map(({ stock, dates }) => ({
                    code: stock.code,
                    name: stock.name,
                    count: dates.length,
                    dates: dates.sort((a, b) => (a < b ? 1 : -1)),
                    highDays: stock.highDays,
                    reasonType: stock.reasonType,
                    inTodayPool: todayCodes.has(stock.code),
                }))
                .sort((a, b) => b.count - a.count || (b.inTodayPool ? 1 : 0) - (a.inTodayPool ? 1 : 0));

            return {
                source: 'ths:limit_up_pool+block_top',
                date,
                windowDays: days,
                target,
                targetLimitUpDays: [date, ...targetLimitUpDays],
                themes,
                coLimit,
                historyDates: history.map((item) => item.date),
            };
        });
        return { data: result.value, meta: metaOf(result) };
    },

    /**
     * 龙虎榜：东财 datacenter（主源，榜单行按代码合并）+ 同花顺（游资/机构净买、标签、概念）合并。
     * 任一平台失败可降级（platforms 标注）；全部失败 502。排序：净买额降序。
     */
    '/api/dragon-tiger': async (params) => {
        const date = optionalTradeDate(params);
        const result = await cached(`dragontiger:${date}`, cacheTtl('dragontiger'), async () => {
            const [east, thsRes] = await Promise.allSettled([
                eastmoney.fetchDragonTiger(date),
                ths.fetchDragonTigerList(date),
            ]);
            if (east.status === 'rejected' && thsRes.status === 'rejected') {
                throw east.reason ?? thsRes.reason;
            }
            const platformOf = (settled, name) =>
                settled.status === 'fulfilled'
                    ? { ok: true, name }
                    : { ok: false, name, error: settled.reason?.message ?? String(settled.reason) };
            const platforms = [platformOf(east, 'eastmoney'), platformOf(thsRes, 'ths')];

            const thsByCode = new Map((thsRes.status === 'fulfilled' ? thsRes.value.list : []).map((i) => [i.code, i]));
            // 东财同一股票同日可能多个榜单行：按代码分组，主行取榜单成交额更大者，上榜原因合并
            const byCode = new Map();
            for (const row of east.status === 'fulfilled' ? east.value.rows : []) {
                const existing = byCode.get(row.code);
                if (!existing) {
                    byCode.set(row.code, { ...row, explanations: row.explanation ? [row.explanation] : [] });
                    continue;
                }
                if (row.explanation && !existing.explanations.includes(row.explanation)) {
                    existing.explanations.push(row.explanation);
                }
                if ((row.dealAmount ?? -1) > (existing.dealAmount ?? -1)) {
                    byCode.set(row.code, { ...row, explanations: existing.explanations });
                }
            }

            const list = [];
            for (const [code, row] of byCode) {
                const extra = thsByCode.get(code);
                list.push({
                    code,
                    name: row.name,
                    close: row.close,
                    pct: row.pct,
                    explanation: row.explanations.join('；') || null,
                    explain: row.explain,
                    netAmount: row.netAmount,
                    buyAmount: row.buyAmount,
                    sellAmount: row.sellAmount,
                    dealAmount: row.dealAmount,
                    totalAmount: row.totalAmount,
                    netRatio: row.netRatio,
                    dealRatio: row.dealRatio,
                    turnover: row.turnover,
                    freeMv: row.freeMv,
                    d1Pct: row.d1Pct,
                    d2Pct: row.d2Pct,
                    d5Pct: row.d5Pct,
                    d10Pct: row.d10Pct,
                    hotMoneyNet: extra?.hotMoneyNet ?? null,
                    orgNet: extra?.orgNet ?? null,
                    limitReason: extra?.limitReason ?? null,
                    tags: extra?.tags ?? [],
                    concepts: extra?.concepts ?? [],
                });
            }
            if (east.status === 'rejected') {
                // 东财失败：仅用同花顺行（缺 收盘价/买卖额/次日涨幅 等东财独有字段）
                for (const [code, item] of thsByCode) {
                    list.push({
                        code,
                        name: item.name,
                        close: null,
                        pct: item.pct,
                        explanation: item.limitReason,
                        explain: null,
                        netAmount: item.netAmount,
                        buyAmount: item.buyAmount,
                        sellAmount: item.sellAmount,
                        dealAmount: null,
                        totalAmount: null,
                        netRatio: item.netRatio,
                        dealRatio: null,
                        turnover: null,
                        freeMv: null,
                        d1Pct: null,
                        d2Pct: null,
                        d5Pct: null,
                        d10Pct: null,
                        hotMoneyNet: item.hotMoneyNet,
                        orgNet: item.orgNet,
                        limitReason: item.limitReason,
                        tags: item.tags,
                        concepts: item.concepts,
                    });
                }
            }
            list.sort((a, b) => (b.netAmount ?? -Infinity) - (a.netAmount ?? -Infinity));

            const okNames = platforms.filter((p) => p.ok).map((p) => p.name);
            return {
                source: okNames.map((n) => (n === 'eastmoney' ? 'eastmoney:datacenter-web' : 'ths:transaction')).join('+'),
                date,
                platforms,
                list,
            };
        });
        archive('dragontiger', date, result.value);
        return { data: result.value, meta: metaOf(result) };
    },

    /**
     * 热榜：多平台人气榜合并（东财 xuangu / 同花顺 fuyao / 财联社 api3 / 大智慧 imsearch）。
     * 各平台独立容错（platforms 标注 ok/error），全部失败才 502；
     * 合并行按 code 聚合各平台名次与元数据，默认按东财名次升序（缺失排后）。
     * 淘股吧（tgb.cn）当前网络 DNS 不可达，未接入（见 docs/design.md 已知限制）。
     */
    '/api/hot-rank': async (params) => {
        const limit = clampInt(params, 'limit', 100, 1, 300);
        const result = await cached('hotrank', cacheTtl('hotrank'), async () => {
            const [dfcf, thsRes, clsRes, dzhRes] = await Promise.allSettled([
                eastmoney.fetchPopularityRank(),
                ths.fetchHotList(),
                cls.fetchHotRanking(),
                dzh.fetchHotRanking(),
            ]);
            if ([dfcf, thsRes, clsRes, dzhRes].every((r) => r.status === 'rejected')) {
                throw dfcf.reason ?? new Error('人气榜全部平台获取失败');
            }
            const platformOf = (settled, name) =>
                settled.status === 'fulfilled'
                    ? { ok: true, name, count: settled.value.stocks.length }
                    : { ok: false, name, error: settled.reason?.message ?? String(settled.reason) };
            const platforms = [
                platformOf(dfcf, 'dfcf'),
                platformOf(thsRes, 'ths'),
                platformOf(clsRes, 'cls'),
                platformOf(dzhRes, 'dzh'),
            ];

            const byCode = new Map();
            const ensure = (code) => {
                if (!byCode.has(code)) {
                    byCode.set(code, {
                        code,
                        name: null,
                        price: null,
                        pct: null,
                        volumeRatio: null,
                        dfcfRank: null,
                        thsRank: null,
                        clsRank: null,
                        dzhRank: null,
                        thsRankChange: null,
                        clsRankChange: null,
                        thsHotValue: null,
                        dzhHeat: null,
                        popularityTag: null,
                        concepts: [],
                        analyseTitle: null,
                    });
                }
                return byCode.get(code);
            };
            const assignFirst = (target, key, value) => {
                if (target[key] === null && value !== null && value !== undefined) {
                    target[key] = value;
                }
            };
            if (dfcf.status === 'fulfilled') {
                for (const s of dfcf.value.stocks) {
                    const entry = ensure(s.code);
                    assignFirst(entry, 'name', s.name);
                    assignFirst(entry, 'price', s.price);
                    assignFirst(entry, 'pct', s.pct);
                    assignFirst(entry, 'volumeRatio', s.volumeRatio);
                    entry.dfcfRank = s.rank;
                }
            }
            if (thsRes.status === 'fulfilled') {
                for (const s of thsRes.value.stocks) {
                    const entry = ensure(s.code);
                    assignFirst(entry, 'name', s.name);
                    assignFirst(entry, 'pct', s.pct);
                    assignFirst(entry, 'popularityTag', s.popularityTag);
                    assignFirst(entry, 'analyseTitle', s.analyseTitle);
                    if (entry.concepts.length === 0 && s.concepts?.length) {
                        entry.concepts = s.concepts;
                    }
                    entry.thsRank = s.rank;
                    entry.thsRankChange = s.rankChange;
                    entry.thsHotValue = s.hotValue;
                }
            }
            if (clsRes.status === 'fulfilled') {
                for (const s of clsRes.value.stocks) {
                    const entry = ensure(s.code);
                    assignFirst(entry, 'name', s.name);
                    assignFirst(entry, 'price', s.price);
                    assignFirst(entry, 'pct', s.pct);
                    entry.clsRank = s.rank;
                    entry.clsRankChange = s.rankChange;
                }
            }
            if (dzhRes.status === 'fulfilled') {
                for (const s of dzhRes.value.stocks) {
                    const entry = ensure(s.code);
                    entry.dzhRank = s.rank;
                    entry.dzhHeat = s.heat;
                }
            }

            const list = [...byCode.values()].sort(
                (a, b) =>
                    (a.dfcfRank ?? Number.MAX_SAFE_INTEGER) - (b.dfcfRank ?? Number.MAX_SAFE_INTEGER) ||
                    (a.thsRank ?? Number.MAX_SAFE_INTEGER) - (b.thsRank ?? Number.MAX_SAFE_INTEGER),
            );
            return { source: 'hotrank:dfcf+ths+cls+dzh', platforms, total: list.length, list };
        });
        // 热榜无日期参数：按抓取日归档（上游不支持历史回补，见 lib/history.js 头注释）
        archive('hotrank', todayYyyymmdd(), result.value);
        return {
            data: {
                platforms: result.value.platforms,
                total: result.value.total,
                list: result.value.list.slice(0, limit),
            },
            meta: metaOf(result, { limit }),
        };
    },
};

// ---------------------------------------------------------------------------
// 内部路由转发（Agent 工具复用，见 lib/agent.js）
// ---------------------------------------------------------------------------

/** 参数值 → URLSearchParams 字符串（数组逗号连接 / 布尔转 1|0，与 GET 查询串语义一致） */
function stringifyParam(value) {
    if (Array.isArray(value)) {
        return value.join(',');
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    return String(value);
}

/**
 * 进程内调用 GET 路由：与 HTTP 请求走同一套 校验 → 缓存 → 数据源 逻辑。
 * AI Agent 的工具执行入口（lib/agent.js 经依赖注入使用），共享全部缓存。
 *
 * @param {string} pathname 路由路径（如 /api/screen）
 * @param {Record<string, any>} [params] 查询参数（null/undefined/空串自动忽略）
 * @returns {Promise<{data: any, meta?: object}>}
 * @throws {ApiError} 未知路由或参数校验失败
 */
export async function invokeRoute(pathname, params = {}) {
    const handler = routes[pathname];
    if (!handler) {
        throw new ApiError(404, `未知内部路由 ${pathname}`);
    }
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            searchParams.set(key, stringifyParam(value));
        }
    }
    return handler(searchParams);
}

/**
 * 历史归档采集器（由 lib/collector.js 按 config.collection 定时调用）：
 * 复用路由与缓存归档当日 涨停池/连板天梯/热榜/龙虎榜（write-through 落盘）。
 *
 * 配置驱动（v1.4.0，见 config.collection）：
 * - enabled=false 直接跳过整轮；
 * - types.{limitup,ladder,hotrank,dragontiger} 逐项开关，仅采集打开的类型；
 * - 龙虎榜收盘后（约 17:00）才发布，仅在上海时间 ≥ dragonTigerAfterHour 点后采集；
 * - 单项失败互不影响（Promise.allSettled + 告警）。
 */
export async function collectHistory() {
    const collection = getGroup('collection');
    if (!collection.enabled) {
        return; // 采集总开关关闭
    }
    const date = todayYyyymmdd();
    const jobs = [];
    if (collection.types.limitup) {
        jobs.push(['/api/limitup/pool', { date }]);
    }
    if (collection.types.ladder) {
        jobs.push(['/api/ladder', { date }]);
    }
    if (collection.types.hotrank) {
        jobs.push(['/api/hot-rank', {}]);
    }
    if (collection.types.dragontiger) {
        const shHour = Number(
            new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()),
        );
        if (shHour >= collection.dragonTigerAfterHour) {
            jobs.push(['/api/dragon-tiger', { date }]);
        }
    }
    if (jobs.length === 0) {
        return;
    }
    const settled = await Promise.allSettled(jobs.map(([jobPath, params]) => invokeRoute(jobPath, params)));
    settled.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.warn(`[history] 采集失败 ${jobs[index][0]}: ${result.reason?.message ?? result.reason}`);
        }
    });
}

// ---------------------------------------------------------------------------
// POST /api/agent/chat（AI 选股助手，v1.3.0）
// ---------------------------------------------------------------------------

/** 读取 POST JSON 请求体（限 64KB） */
function readJsonBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new ApiError(413, '请求体过大（上限 64KB）'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch {
                reject(new ApiError(400, '请求体必须为合法 JSON'));
            }
        });
        req.on('error', (error) => reject(new ApiError(400, `读取请求体失败: ${error.message}`)));
    });
}

/**
 * AI 选股助手对话：{ messages } → Agent 工具循环 → { reply, toolTrace, stocks }。
 * LLM 配置缺失 → 503（附配置指引）；LLM 调用失败 → 502。
 */
async function handleAgentChat(req) {
    const body = await readJsonBody(req);
    // 对话历史上限（条数 / 单条字符数）取自 config.agent，防止 prompt 无限膨胀（可热改，v1.4.0）
    const { maxMessages, maxContent } = getGroup('agent');
    const rawMessages = body?.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
        throw new ApiError(400, '参数 messages 必须为非空数组');
    }
    if (rawMessages.length > maxMessages) {
        throw new ApiError(400, `messages 最多 ${maxMessages} 条（请在前端截断更早的历史）`);
    }
    const history = [];
    for (const item of rawMessages) {
        if (!item || typeof item !== 'object' || !['user', 'assistant'].includes(item.role)) {
            throw new ApiError(400, 'messages 元素必须为 { role: "user"|"assistant", content: string }');
        }
        if (typeof item.content !== 'string' || !item.content.trim()) {
            throw new ApiError(400, 'messages.content 必须为非空字符串');
        }
        if (item.content.length > maxContent) {
            throw new ApiError(400, `messages.content 单条不超过 ${maxContent} 字符`);
        }
        history.push({ role: item.role, content: item.content.trim() });
    }
    if (history[history.length - 1].role !== 'user') {
        throw new ApiError(400, 'messages 最后一条必须是 user 消息');
    }
    if (!isLlmConfigured()) {
        throw new LlmConfigError(
            'LLM 未配置：请在「设置」页填写模型地址与 Access Token（或设置环境变量 LLM_MODEL_URL / LLM_ACCESS_TOKEN / LLM_MODEL 后重启），详见 README「AI 选股助手」',
        );
    }

    const result = await runAgent(history, invokeRoute);
    return {
        data: {
            reply: result.reply,
            toolTrace: result.toolTrace,
            stocks: result.stocks,
            model: result.model,
            llmRounds: result.llmRounds,
            truncated: result.truncated,
        },
        meta: { source: `llm:${result.model}`, fetchedAt: new Date().toISOString(), fromCache: false },
    };
}

/**
 * 处理 /api/* 请求
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url 已解析的请求 URL
 * @returns {Promise<boolean>} 是否命中 API 路由
 */
export async function handleApiRequest(req, res, url) {
    // POST 目前仅 /api/agent/chat（Agent 对话需请求体，不走查询串路由表）
    if (req.method === 'POST' && url.pathname === '/api/agent/chat') {
        try {
            const { data, meta } = await handleAgentChat(req);
            sendJson(res, 200, { data, meta });
        } catch (error) {
            const status =
                error instanceof ApiError ? error.status
                : error instanceof LlmConfigError ? 503
                : error instanceof LlmError ? 502
                : 500;
            const known = error instanceof ApiError || error instanceof LlmConfigError || error instanceof LlmError;
            const message = known ? error.message : `Agent 执行失败: ${error.message}`;
            if (status >= 500) {
                console.error('[api] /api/agent/chat 失败:', error);
            }
            sendJson(res, status, { error: { status, message } });
        }
        return true;
    }

    // PUT 目前仅 /api/config（配置更新需请求体，不走查询串路由表）
    if (req.method === 'PUT' && url.pathname === '/api/config') {
        try {
            const patch = await readJsonBody(req);
            const data = await updateConfig(patch ?? {});
            sendJson(res, 200, { data, meta: { source: 'config', fetchedAt: new Date().toISOString(), fromCache: false } });
        } catch (error) {
            const status = error instanceof ConfigError ? 400 : error instanceof ApiError ? error.status : 500;
            const known = error instanceof ConfigError || error instanceof ApiError;
            const message = known ? error.message : `配置更新失败: ${error.message}`;
            if (status >= 500) {
                console.error('[api] PUT /api/config 失败:', error);
            }
            sendJson(res, status, { error: { status, message } });
        }
        return true;
    }

    const handler = routes[url.pathname];
    if (!handler) {
        return false;
    }
    if (req.method !== 'GET') {
        sendJson(res, 405, { error: { status: 405, message: '仅支持 GET' } });
        return true;
    }
    try {
        const { data, meta } = await handler(url.searchParams);
        sendJson(res, 200, { data, meta });
    } catch (error) {
        const status = error instanceof ApiError ? error.status : 502;
        const message = error instanceof ApiError ? error.message : `上游数据获取失败: ${error.message}`;
        if (status >= 500) {
            console.error(`[api] ${url.pathname} 失败:`, error);
        }
        sendJson(res, status, { error: { status, message } });
    }
    return true;
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    res.end(payload);
}
