/**
 * 同花顺（10jqka）数据源：涨停池 / 涨停复盘 / 龙虎榜 / 热股榜。
 *
 * 接口出处（docs/stock-data-apis/ths.md，monitor 端 ThsApi 同款）：
 * - §1 涨停池 GET dataapi/limit_up/limit_up_pool（分页 limit=200）
 * - §3 涨停复盘 GET dataapi/limit_up/block_top（按题材分组）
 * - §6 热股榜 GET dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock
 * - §9 龙虎榜 GET dataapi/transaction/stock/v1/list（含游资/机构净买、概念、营业部标签）
 *
 * 请求头（README「鉴权/特殊请求头」）：
 *   涨停接口 Referer: https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html + 桌面 UA
 */

import { fetchJson } from '../lib/http.js';
import { toNumber, formatClockFromEpochSeconds } from '../lib/util.js';

const BASE = 'https://data.10jqka.com.cn/dataapi/limit_up';
const HEADERS = {
    Referer: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html',
};
const DATA_HEADERS = { Referer: 'https://data.10jqka.com.cn/' };

const POOL_QUERY =
    'field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003' +
    '&filter=HS,GEM2STAR&order_field=330324&order_type=0';

const PAGE_LIMIT = 200;
const MAX_PAGES = 20;

function normalizePoolItem(item) {
    return {
        code: item.code,
        name: item.name,
        price: toNumber(item.latest),
        pct: toNumber(item.change_rate),
        highDays: item.high_days ?? null, // 几天几板，如 "3天2板"
        limitUpType: item.limit_up_type ?? null, // 涨停类型（换手板/一字板等）
        reasonType: item.reason_type ?? null, // 涨停原因（题材）
        openNum: toNumber(item.open_num), // 开板次数
        turnover: toNumber(item.turnover_rate), // 换手率 %
        orderVolume: toNumber(item.order_volume), // 封单量（股）
        circMv: toNumber(item.currency_value), // 流通市值（元）
        firstLimitUpTime: formatClockFromEpochSeconds(item.first_limit_up_time),
        lastLimitUpTime: formatClockFromEpochSeconds(item.last_limit_up_time),
        isAgainLimit: toNumber(item.is_again_limit), // 是否回封
        limitUpSucRate: toNumber(item.limit_up_suc_rate), // 涨停封板率
    };
}

/**
 * 涨停池（循环翻页直到取完，app 端 StockRepo.getLimitUpPool 同款策略）
 *
 * @param {string} date 交易日 yyyyMMdd
 * @returns {Promise<{source: string, date: string, summary: object, list: any[]}>}
 */
export async function fetchLimitUpPool(date) {
    const list = [];
    let summary = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${BASE}/limit_up_pool?${POOL_QUERY}&date=${date}&page=${page}&limit=${PAGE_LIMIT}`;
        const json = await fetchJson(url, { headers: HEADERS });
        if (json?.status_code !== 0) {
            throw new Error(`同花顺涨停池响应异常: status_code=${json?.status_code} status_msg=${json?.status_msg}`);
        }
        const data = json.data ?? {};
        const info = Array.isArray(data.info) ? data.info : [];
        for (const item of info) {
            if (item?.code) {
                list.push(normalizePoolItem(item));
            }
        }
        // trade_status 实际为对象 {id, name, start_time, end_time}，取 name 展示
        const rawTradeStatus = data.trade_status;
        summary = {
            limitUpCount: toNumber(data.limit_up_count) ?? list.length,
            limitDownCount: toNumber(data.limit_down_count),
            tradeStatus:
                rawTradeStatus && typeof rawTradeStatus === 'object'
                    ? rawTradeStatus.name ?? rawTradeStatus.id ?? null
                    : rawTradeStatus ?? null,
            page: data.page ?? null,
        };
        if (info.length < PAGE_LIMIT) {
            break;
        }
    }
    return { source: 'ths:limit_up_pool', date, summary, list };
}

/**
 * block_top 的 high_days 实测为编码整数：高 16 位 = 板数，低 16 位 = 天数
 * （65537=0x10001 → 首板；131074=0x20002 → 2天2板；131075=0x20003 → 3天2板）。
 * 已与同日 limit_up_pool 的 high_days 字符串交叉验证（奥士康 131075 ↔ "3天2板"）。
 * 若上游直接返回 "2天2板" 字符串则原样透传。
 */
function decodeHighDays(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    if (typeof raw === 'string') {
        return raw;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    const boards = Math.floor(value / 65536);
    const days = value % 65536;
    if (boards <= 0 || days <= 0) {
        return null;
    }
    return boards === 1 && days === 1 ? '首板' : `${days}天${boards}板`;
}

/**
 * 涨停复盘（按题材分组的涨停股）
 *
 * @param {string} date 交易日 yyyyMMdd
 * @returns {Promise<{source: string, date: string, groups: any[]}>}
 */
export async function fetchZtReplay(date) {
    const url = `${BASE}/block_top?filter=HS,GEM2STAR&date=${date}`;
    const json = await fetchJson(url, { headers: HEADERS });
    if (json?.status_code !== 0) {
        throw new Error(`同花顺涨停复盘响应异常: status_code=${json?.status_code} status_msg=${json?.status_msg}`);
    }
    const groups = (Array.isArray(json.data) ? json.data : []).map((block) => ({
        code: block.code ?? null,
        name: block.name ?? null, // 题材名
        limitUpNum: toNumber(block.limit_up_num),
        days: block.days ?? null,
        reasonType: block.reason_type ?? null,
        reasonInfo: block.reason_info ?? null,
        stocks: (Array.isArray(block.stock_list) ? block.stock_list : []).map((stock) => ({
            code: stock.code,
            name: stock.name,
            pct: toNumber(stock.change_rate),
            concept: stock.concept ?? null,
            continueNum: toNumber(stock.continue_num), // 连板数
            highDays: decodeHighDays(stock.high_days), // 几天几板（上游为编码整数，见 decodeHighDays）
            firstLimitUpTime: formatClockFromEpochSeconds(stock.first_limit_up_time),
            reasonType: stock.reason_type ?? null,
            reasonInfo: stock.reason_info ?? null,
        })),
    }));
    return { source: 'ths:block_top', date, groups };
}

/** yyyyMMdd → yyyy-MM-dd（同花顺龙虎榜 date 参数格式） */
function toIsoDate(date8) {
    return `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`;
}

/**
 * 归一化一条同花顺龙虎榜记录。
 * 实测：change/net_rate 为小数（0.0712 = 7.12%），需 ×100 转为百分比；
 * 与东财龙虎榜 CHANGE_RATE（已是百分比）不同，见 changelog 实测修正。
 */
function normalizeDtItem(item) {
    const pct = toNumber(item.change);
    const netRate = toNumber(item.net_rate);
    return {
        code: item.stock_code,
        name: item.stock_name ?? null,
        pct: pct === null ? null : pct * 100,
        netAmount: toNumber(item.net_value), // 净买额（元）
        netRatio: netRate === null ? null : netRate * 100, // 净买额占比 %
        buyAmount: toNumber(item.buy_value),
        sellAmount: toNumber(item.sell_value),
        hotMoneyNet: toNumber(item.hot_money_net_value), // 游资净买（元）
        orgNet: toNumber(item.org_net_value), // 机构净买（元）
        limitReason: item.limit_reason ?? null, // 涨停原因（可空）
        concepts: (Array.isArray(item.concept_list) ? item.concept_list : [])
            .map((concept) => concept?.name)
            .filter(Boolean),
        tags: (Array.isArray(item.tags) ? item.tags : []).map((tag) => tag?.name).filter(Boolean),
        rangeDays: toNumber(item.range_days), // 榜单类型：1=当日榜，N=N日榜
        hotRank: toNumber(item.hot_rank),
    };
}

/**
 * 同花顺龙虎榜（transaction/stock/v1/list，ths.md §9）。
 * module=all 时同一股票可能有多行（当日榜 + N日榜，以 range_days 区分），
 * 此处按代码去重，优先保留当日榜（range_days=1）行。
 *
 * @param {string} date 交易日 yyyyMMdd
 * @returns {Promise<{source: string, list: any[]}>}
 */
export async function fetchDragonTigerList(date) {
    const query = new URLSearchParams({
        order_field: 'hot_rank',
        order_type: 'asc',
        date: toIsoDate(date),
        filter: '',
        page: '1',
        size: '500',
        module: 'all',
        order_null_greater: '1',
    });
    const json = await fetchJson(`https://data.10jqka.com.cn/dataapi/transaction/stock/v1/list?${query}`, {
        headers: DATA_HEADERS,
    });
    if (json?.status_code !== 0) {
        throw new Error(`同花顺龙虎榜响应异常: status_code=${json?.status_code} status_msg=${json?.status_msg}`);
    }
    const items = Array.isArray(json.data?.items) ? json.data.items : [];
    const byCode = new Map();
    for (const raw of items) {
        const normalized = normalizeDtItem(raw);
        if (!normalized.code) {
            continue;
        }
        const existing = byCode.get(normalized.code);
        if (!existing || (existing.rangeDays !== 1 && normalized.rangeDays === 1)) {
            byCode.set(normalized.code, normalized);
        }
    }
    return { source: 'ths:transaction', list: [...byCode.values()] };
}

/**
 * 同花顺热股榜（fuyao，ths.md §6，type=hour 小时榜）。
 * analyse 长文本（AI 归因）不透出，仅保留标题，控制响应体积。
 *
 * @returns {Promise<{source: string, stocks: any[]}>}
 */
export async function fetchHotList() {
    const url =
        'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal';
    const json = await fetchJson(url);
    if (json?.status_code !== 0) {
        throw new Error(`同花顺热股榜响应异常: status_code=${json?.status_code} status_msg=${json?.status_msg}`);
    }
    const list = Array.isArray(json.data?.stock_list) ? json.data.stock_list : [];
    return {
        source: 'ths:fuyao',
        stocks: list.map((item) => ({
            code: String(item.code ?? ''),
            name: item.name ?? null,
            rank: toNumber(item.order),
            rankChange: toNumber(item.hot_rank_chg), // 排名变化（正=上升）
            pct: toNumber(item.rise_and_fall), // %
            hotValue: toNumber(item.rate), // 热度值
            popularityTag: item.tag?.popularity_tag ?? null, // 如「12天8板」
            concepts: Array.isArray(item.tag?.concept_tag) ? item.tag.concept_tag : [],
            analyseTitle: item.analyse_title ?? null, // 热点归因标题
        })),
    };
}
