/**
 * 东方财富数据源。
 *
 * 接口出处（docs/stock-data-apis/eastmoney.md）：
 * - §1 全市场 A 股实时快照 `api/qt/clist/get`（此处改用 fltt=2 直接返回浮点值，省去 ×100 还原）
 * - §5 通用日 K `api/qt/stock/kline/get`（push2his，fqt=1 前复权）
 * - §7 板块实时行情（fs=m:90+t:2/t:3+f:!50）
 * - §6 板块成份股（fs=b:BKxxxx）
 * - §10 人气榜 `dataapi/xuangu/list`（data.eastmoney.com，POPULARITY_RANK Top300）
 * - §11 龙虎榜 `datacenter-web/api/data/v1/get`（RPT_DAILYBILLBOARD_DETAILSNEW）
 *
 * 请求头：Referer https://quote.eastmoney.com/ + 桌面 UA（monitor 端同款，见 README「鉴权/特殊请求头」）
 * 主机：20.push2 为主源，43/52 为 fallback（monitor 端 MarketApiFactory 同款策略）
 */

import { fetchJson } from '../lib/http.js';
import { mapWithConcurrency, toNumber } from '../lib/util.js';

const CLIST_HOSTS = ['20.push2.eastmoney.com', '43.push2.eastmoney.com', '52.push2.eastmoney.com'];
const KLINE_HOST = 'push2his.eastmoney.com';
const DATACENTER_HOST = 'datacenter-web.eastmoney.com';
const XUANGU_URL = 'https://data.eastmoney.com/dataapi/xuangu/list';
const HEADERS = { Referer: 'https://quote.eastmoney.com/' };
const DATA_HEADERS = { Referer: 'https://data.eastmoney.com/' };

/** app 端全市场 A 股 fs 常量（StockService.kt FS） */
const FS_FULL_MARKET = 'm:1+t:2,m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:23,t:81+s:2048';

/**
 * 个股实时行情字段（f 字段含义见 docs/stock-data-apis/README.md 映射表）。
 * v1.2.0 增补估值/活跃度字段（README f 表未收录，含义为东财行情中心列配置同款，
 * 已与 app 端 StockService.kt 请求字段列表交叉印证）：
 *   f9 市盈率(动) · f10 量比 · f23 市净率 · f24 60日涨跌幅% · f25 年初至今涨跌幅% · f115 市盈率(TTM)
 */
const STOCK_FIELDS =
    'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f24,f25,f26,f115,f297,f350,f351,f352';

/** 板块实时行情字段（getRealTimeTradeBK 文档字段 + f104/f105/f106 涨跌平家数） */
const BK_FIELDS = 'f2,f3,f7,f8,f12,f14,f15,f16,f17,f18,f20,f21,f104,f105,f106,f297';

/** 常用指数 secid（1.000001=上证指数，见 README secid 前缀表） */
export const INDICES = [
    { secid: '1.000001', label: '上证指数' },
    { secid: '0.399001', label: '深证成指' },
    { secid: '0.399006', label: '创业板指' },
];

function buildClistUrl(host, params) {
    const query = new URLSearchParams({
        po: '1',
        np: '1',
        ut: 'bd1d9ddb04089700cf9c27f6f7426281',
        fltt: '2',
        invt: '2',
        ...params,
    });
    // fs 参数含 '+'，URLSearchParams 会编码为 %2B；东财两种写法均接受，
    // 但为与 app 端原始 URL 保持一致，这里将 %2B 还原为 '+'
    const qs = query.toString().replaceAll('%2B', '+');
    return `http://${host}/api/qt/clist/get?${qs}`;
}

/**
 * clist 单页请求
 *
 * @param {string} host 主机
 * @param {Record<string,string>} params 查询参数（pn/pz/fs/fields/fid）
 * @returns {Promise<{total: number, diff: any[]}>}
 */
async function fetchClistPage(host, params) {
    const json = await fetchJson(buildClistUrl(host, params), { headers: HEADERS });
    const data = json?.data;
    if (!data || !Array.isArray(data.diff)) {
        throw new Error(`东财 clist 响应缺少 data.diff: ${json?.rc}`);
    }
    return { total: Number(data.total) || 0, diff: data.diff };
}

/** 归一化一条 clist 个股记录（fltt=2 时为浮点原值） */
function normalizeStockItem(item) {
    return {
        code: item.f12,
        market: toNumber(item.f13),
        name: item.f14,
        price: toNumber(item.f2),
        pct: toNumber(item.f3),
        change: toNumber(item.f4),
        volume: toNumber(item.f5), // 手
        amount: toNumber(item.f6), // 元
        amplitude: toNumber(item.f7), // %
        turnover: toNumber(item.f8), // %
        high: toNumber(item.f15),
        low: toNumber(item.f16),
        open: toNumber(item.f17),
        preClose: toNumber(item.f18),
        totalMv: toNumber(item.f20), // 元
        circMv: toNumber(item.f21), // 元
        pe: toNumber(item.f9), // 市盈率（动态）
        peTtm: toNumber(item.f115), // 市盈率（TTM）
        pb: toNumber(item.f23), // 市净率
        volumeRatio: toNumber(item.f10), // 量比
        pct60: toNumber(item.f24), // 60 日涨跌幅 %
        pctYtd: toNumber(item.f25), // 年初至今涨跌幅 %
        listDate: toNumber(item.f26), // yyyyMMdd
        quoteDate: toNumber(item.f297),
        ztPrice: toNumber(item.f350),
        dtPrice: toNumber(item.f351),
        avgPrice: toNumber(item.f352),
    };
}

/**
 * 全市场 A 股实时快照。
 * 先请求第 1 页拿 total，其余页以 6 并发拉取（app 端 getRealTimeStocksDFCF 同款策略），
 * 首页失败时按 monitor 端 fallback 顺序切换主机。
 *
 * 注意：clist 服务端实际每页最多返回 100 条（请求 pz=200 也只给 100），
 * 与 app 端「拉取 pn=1..59」及 monitor 端「pz=100」的约定一致。
 *
 * @returns {Promise<{source: string, total: number, stocks: any[]}>}
 */
export async function fetchFullSnapshot() {
    const pageSize = 100;
    const baseParams = { pz: String(pageSize), fid: 'f3', fields: STOCK_FIELDS, fs: FS_FULL_MARKET };

    // 首页：按主机顺序尝试，确定可用主机
    let host = null;
    let firstPage = null;
    let lastError = null;
    for (const candidate of CLIST_HOSTS) {
        try {
            firstPage = await fetchClistPage(candidate, { ...baseParams, pn: '1' });
            host = candidate;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (!host || !firstPage) {
        throw lastError ?? new Error('东财 clist 全部主机不可用');
    }

    const totalPages = Math.min(Math.ceil(firstPage.total / pageSize), 80);
    const pageNumbers = [];
    for (let pn = 2; pn <= totalPages; pn += 1) {
        pageNumbers.push(pn);
    }
    /** 失败页号（容忍但须留痕：上游限流时页面成片失败，是「返回空」的直接线索） */
    const failedPages = [];
    const restPages = await mapWithConcurrency(pageNumbers, 6, async (pn) => {
        try {
            return await fetchClistPage(host, { ...baseParams, pn: String(pn) });
        } catch (error) {
            failedPages.push(pn);
            console.warn(`[snapshot] 东财第 ${pn}/${totalPages} 页拉取失败（跳过该页）: ${error.message}`);
            return { total: 0, diff: [] }; // 个别页失败容忍，快照仍可用
        }
    });

    const rawItems = [firstPage.diff, ...restPages.map((p) => p.diff)].flat();
    const stocks = rawItems
        .filter((item) => item && item.f12)
        .map(normalizeStockItem);
    if (stocks.length === 0) {
        // 空快照会让下游 screen/search/quote 全部「返回空」：宁可抛错走新浪兜底/回填模型错误
        throw new Error(`东财快照返回空列表（total=${firstPage.total}，失败页 ${failedPages.length} 个，疑似上游限流）`);
    }
    if (failedPages.length > 0) {
        console.warn(
            `[snapshot] 东财快照不完整: ${stocks.length}/${firstPage.total} 只（失败 ${failedPages.length} 页: ${failedPages.slice(0, 10).join(',')}${failedPages.length > 10 ? '…' : ''}）`,
        );
    }
    return { source: `eastmoney:${host}`, total: firstPage.total, stocks };
}

/**
 * 解析 kline 接口返回的 klines 行。
 * fields2=f51..f64 时行格式（docs/stock-data-apis/README.md）：
 * [0]日期 [1]开盘 [2]收盘 [3]最高 [4]最低 [5]成交量(手) [6]成交额(元) [7]振幅% [8]涨跌幅% [9]涨跌额 [10]换手率%
 */
function parseKlineRows(klines) {
    return (klines ?? []).map((line) => {
        const c = String(line).split(',');
        return {
            date: c[0],
            open: toNumber(c[1]),
            close: toNumber(c[2]),
            high: toNumber(c[3]),
            low: toNumber(c[4]),
            volume: toNumber(c[5]),
            amount: toNumber(c[6]),
            amplitude: toNumber(c[7]),
            pct: toNumber(c[8]),
            change: toNumber(c[9]),
            turnover: toNumber(c[10]),
        };
    });
}

/**
 * 日 K 线（前复权）。统一按日期升序返回。
 * 注：文档称 klines 默认降序，但实测该接口按日期升序返回；为保证行为确定，
 * 此处显式排序而非依赖上游顺序。
 *
 * @param {string} secid 东财 secid，如 `1.600000`
 * @param {number} lmt 条数上限
 * @returns {Promise<{code: string, name: string, preClose: number|null, klines: any[]}>}
 */
export async function fetchKline(secid, lmt) {
    const url =
        `https://${KLINE_HOST}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${lmt}` +
        '&end=20500000&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8' +
        '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64&forcect=1';
    const json = await fetchJson(url, { headers: HEADERS });
    const data = json?.data;
    if (!data || !Array.isArray(data.klines)) {
        throw new Error(`东财 kline 响应缺少 data.klines: ${json?.rc}`);
    }
    const klines = parseKlineRows(data.klines);
    klines.sort((a, b) => (a.date < b.date ? -1 : 1));
    return {
        code: data.code,
        name: data.name,
        preClose: toNumber(data.prePrice),
        klines,
    };
}

/**
 * 指数最新一日行情（app 端 getRealTimeIndexByCode 同款：kline lmt=1）
 *
 * @param {{secid: string, label: string}} index 指数定义
 * @returns {Promise<object>}
 */
export async function fetchIndexQuote(index) {
    const { code, name, preClose, klines } = await fetchKline(index.secid, 1);
    const latest = klines[klines.length - 1] ?? {};
    return {
        secid: index.secid,
        code,
        name: name || index.label,
        preClose,
        ...latest,
    };
}

/**
 * 板块实时行情（行业 m:90+t:2 / 概念 m:90+t:3，fltt=2 浮点原值）
 *
 * @param {'industry'|'concept'} type 板块类型
 * @returns {Promise<{source: string, sectors: any[]}>}
 */
export async function fetchSectors(type) {
    const fs = type === 'concept' ? 'm:90+t:3+f:!50' : 'm:90+t:2+f:!50';
    // clist 每页实际最多返回 100 条，行业约 5 页、概念约 6 页（与 app 端页数约定一致）
    const pageSize = 100;
    const maxPages = 8;

    let host = null;
    let firstPage = null;
    let lastError = null;
    for (const candidate of CLIST_HOSTS) {
        try {
            firstPage = await fetchClistPage(candidate, { pn: '1', pz: String(pageSize), fid: 'f3', fields: BK_FIELDS, fs });
            host = candidate;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (!host) {
        throw lastError ?? new Error('东财 clist 全部主机不可用');
    }

    const sectors = [];
    const appendPage = (diff) => {
        for (const item of diff) {
            if (!item?.f12) {
                continue;
            }
            sectors.push({
                code: item.f12, // BKxxxx
                name: item.f14,
                price: toNumber(item.f2),
                pct: toNumber(item.f3),
                amplitude: toNumber(item.f7),
                turnover: toNumber(item.f8),
                high: toNumber(item.f15),
                low: toNumber(item.f16),
                open: toNumber(item.f17),
                preClose: toNumber(item.f18),
                totalMv: toNumber(item.f20),
                circMv: toNumber(item.f21),
                upCount: toNumber(item.f104),
                downCount: toNumber(item.f105),
                flatCount: toNumber(item.f106),
                quoteDate: toNumber(item.f297),
            });
        }
    };

    appendPage(firstPage.diff);
    for (let pn = 2; pn <= maxPages && firstPage.diff.length >= pageSize; pn += 1) {
        const { diff } = await fetchClistPage(host, {
            pn: String(pn),
            pz: String(pageSize),
            fid: 'f3',
            fields: BK_FIELDS,
            fs,
        });
        appendPage(diff);
        if (diff.length < pageSize) {
            break;
        }
    }
    return { source: `eastmoney:${host}`, sectors };
}

/**
 * 板块成份股实时行情（fs=b:BKxxxx，getBKStocks 同源接口，字段用个股实时字段）
 *
 * @param {string} bkCode 板块代码，如 BK0482
 * @returns {Promise<{source: string, stocks: any[]}>}
 */
export async function fetchBkStocks(bkCode) {
    const host = CLIST_HOSTS[0];
    const pageSize = 100; // clist 单页上限
    const maxPages = 10;
    const stocks = [];
    for (let pn = 1; pn <= maxPages; pn += 1) {
        const { diff } = await fetchClistPage(host, {
            pn: String(pn),
            pz: String(pageSize),
            fid: 'f3',
            fields: STOCK_FIELDS,
            fs: `b:${bkCode}`,
        });
        for (const item of diff) {
            if (item?.f12) {
                stocks.push(normalizeStockItem(item));
            }
        }
        if (diff.length < pageSize) {
            break;
        }
    }
    return { source: `eastmoney:${host}`, stocks };
}

/** yyyyMMdd → yyyy-MM-dd（datacenter 龙虎榜 filter 日期格式） */
function toIsoDate(date8) {
    return `${date8.slice(0, 4)}-${date8.slice(4, 6)}-${date8.slice(6, 8)}`;
}

/** 龙虎榜 columns（app 端 StockRepo.fetchDragonTigerRank 完整 URL 同款，eastmoney.md §11） */
const DT_COLUMNS =
    'SECURITY_CODE,SECUCODE,SECURITY_NAME_ABBR,TRADE_DATE,EXPLAIN,CLOSE_PRICE,CHANGE_RATE,' +
    'BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,BILLBOARD_DEAL_AMT,ACCUM_AMOUNT,' +
    'DEAL_NET_RATIO,DEAL_AMOUNT_RATIO,TURNOVERRATE,FREE_MARKET_CAP,EXPLANATION,' +
    'D1_CLOSE_ADJCHRATE,D2_CLOSE_ADJCHRATE,D5_CLOSE_ADJCHRATE,D10_CLOSE_ADJCHRATE,SECURITY_TYPE_CODE';

/** 归一化一条龙虎榜明细（一条 = 一个上榜榜单，同一股票当日可能多条） */
function normalizeDtRow(row) {
    return {
        code: row.SECURITY_CODE,
        secucode: row.SECUCODE ?? null,
        name: row.SECURITY_NAME_ABBR ?? null,
        tradeDate: String(row.TRADE_DATE ?? '').slice(0, 10),
        close: toNumber(row.CLOSE_PRICE),
        pct: toNumber(row.CHANGE_RATE), // %
        explanation: row.EXPLANATION ?? null, // 上榜原因（规则描述）
        explain: row.EXPLAIN ?? null, // 摘要，如「1家机构买入，成功率38.65%」
        netAmount: toNumber(row.BILLBOARD_NET_AMT), // 榜单净买额（元）
        buyAmount: toNumber(row.BILLBOARD_BUY_AMT),
        sellAmount: toNumber(row.BILLBOARD_SELL_AMT),
        dealAmount: toNumber(row.BILLBOARD_DEAL_AMT), // 榜单成交额
        totalAmount: toNumber(row.ACCUM_AMOUNT), // 当日总成交额
        netRatio: toNumber(row.DEAL_NET_RATIO), // 净买额占总成交比 %
        dealRatio: toNumber(row.DEAL_AMOUNT_RATIO), // 榜单成交额占总成交比 %
        turnover: toNumber(row.TURNOVERRATE), // 换手率 %
        freeMv: toNumber(row.FREE_MARKET_CAP), // 流通市值（元）
        d1Pct: toNumber(row.D1_CLOSE_ADJCHRATE), // 次日涨跌幅 %（当日榜单为 null）
        d2Pct: toNumber(row.D2_CLOSE_ADJCHRATE),
        d5Pct: toNumber(row.D5_CLOSE_ADJCHRATE),
        d10Pct: toNumber(row.D10_CLOSE_ADJCHRATE),
    };
}

/**
 * 每日龙虎榜明细（datacenter-web RPT_DAILYBILLBOARD_DETAILSNEW，分页取全）。
 * 注意：返回的是「榜单行」，同一股票同日可能因多个榜单出现多行，合并由路由层处理。
 *
 * @param {string} date 交易日 yyyyMMdd
 * @returns {Promise<{source: string, rows: any[]}>}
 */
export async function fetchDragonTiger(date) {
    const iso = toIsoDate(date);
    const pageSize = 100;
    const rows = [];
    let pages = 1;
    for (let pageNumber = 1; pageNumber <= pages && pageNumber <= 20; pageNumber += 1) {
        const query = new URLSearchParams({
            sortColumns: 'SECURITY_CODE,TRADE_DATE',
            sortTypes: '1,-1',
            pageSize: String(pageSize),
            pageNumber: String(pageNumber),
            reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
            columns: DT_COLUMNS,
            source: 'WEB',
            client: 'WEB',
            filter: `(TRADE_DATE<='${iso}')(TRADE_DATE>='${iso}')`,
        });
        const json = await fetchJson(`https://${DATACENTER_HOST}/api/data/v1/get?${query}`, {
            headers: DATA_HEADERS,
        });
        const result = json?.result;
        if (!result || !Array.isArray(result.data)) {
            if (pageNumber === 1) {
                throw new Error(`东财龙虎榜响应缺少 result.data: ${json?.message ?? json?.code ?? 'unknown'}`);
            }
            break;
        }
        pages = Number(result.pages) || 1;
        rows.push(...result.data.map(normalizeDtRow));
    }
    return { source: `eastmoney:${DATACENTER_HOST}`, rows };
}

/**
 * 东财人气榜 Top300（data.eastmoney.com/dataapi/xuangu/list，eastmoney.md §10）。
 * 在 app 端 sty 基础上增补 CHANGE_RATE/VOLUME_RATIO/NEW_PRICE（实测可直接返回）。
 *
 * @returns {Promise<{source: string, stocks: any[]}>}
 */
export async function fetchPopularityRank() {
    const query = new URLSearchParams({
        st: 'POPULARITY_RANK',
        sr: '1',
        ps: '300',
        p: '1',
        sty: 'SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,POPULARITY_RANK,CHANGE_RATE,VOLUME_RATIO,NEW_PRICE',
        filter: '(POPULARITY_RANK>0)(POPULARITY_RANK<=1000)',
        source: 'SELECT_SECURITIES',
        client: 'WEB',
    });
    const json = await fetchJson(`${XUANGU_URL}?${query}`, { headers: DATA_HEADERS });
    const data = json?.result?.data;
    if (!Array.isArray(data)) {
        throw new Error(`东财人气榜响应缺少 result.data: ${json?.message ?? json?.code ?? 'unknown'}`);
    }
    return {
        source: 'eastmoney:xuangu',
        stocks: data.map((item) => ({
            code: item.SECURITY_CODE,
            name: item.SECURITY_NAME_ABBR ?? null,
            rank: toNumber(item.POPULARITY_RANK),
            price: toNumber(item.NEW_PRICE),
            pct: toNumber(item.CHANGE_RATE), // %
            volumeRatio: toNumber(item.VOLUME_RATIO),
        })),
    };
}
