/**
 * 新浪财经数据源（全市场实时快照的兜底源）。
 *
 * 接口出处（docs/stock-data-apis/sina.md，monitor 端 SinaApi）：
 * - GET quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple
 * - node=hs_a（沪深全部 A 股）、num=6000、page 从 1 起，空页即停止翻页
 * - 请求头：桌面 Chrome UA（client.kt 拦截器同款约定）
 *
 * 字段较东财少（无涨跌停价/市值/换手率等），归一化后缺失字段置 null，
 * 前端按 null 显示 '-'。
 */

import { fetchJson } from '../lib/http.js';
import { toNumber } from '../lib/util.js';

const BASE_URL =
    'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple';
const PAGE_SIZE = 6000;
const MAX_PAGES = 3;
const MIN_FULL_MARKET_COUNT = 4000; // 低于该值视为快照不完整（参考 monitor FULL_MARKET_STOCK_MIN_COUNT 思路）

function marketFromSymbol(symbol) {
    if (String(symbol).startsWith('sh')) {
        return 1;
    }
    return 0; // sz / bj 均归 0（与东财 secid 前缀约定一致）
}

function normalizeSinaItem(item) {
    return {
        code: item.code,
        market: marketFromSymbol(item.symbol),
        name: item.name,
        price: toNumber(item.trade),
        pct: toNumber(item.changepercent),
        change: toNumber(item.pricechange),
        volume: toNumber(item.volume) !== null ? toNumber(item.volume) / 100 : null, // 新浪 volume 为股，统一为手
        amount: toNumber(item.amount), // 元
        amplitude: null,
        turnover: null,
        high: toNumber(item.high),
        low: toNumber(item.low),
        open: toNumber(item.open),
        preClose: toNumber(item.settlement),
        totalMv: null,
        circMv: null,
        listDate: null,
        quoteDate: null,
        ztPrice: null,
        dtPrice: null,
        avgPrice: null,
    };
}

/**
 * 全市场 A 股实时快照（新浪源）
 *
 * @returns {Promise<{source: string, total: number, stocks: any[]}>}
 */
export async function fetchFullSnapshot() {
    const stocks = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${BASE_URL}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_a&_s_r_a=page`;
        const json = await fetchJson(url);
        const items = Array.isArray(json) ? json : [];
        if (items.length === 0) {
            break; // 空页即停止翻页
        }
        for (const item of items) {
            if (item?.code) {
                stocks.push(normalizeSinaItem(item));
            }
        }
        if (items.length < PAGE_SIZE) {
            break;
        }
    }
    if (stocks.length < MIN_FULL_MARKET_COUNT) {
        throw new Error(`新浪快照数量不完整（${stocks.length} < ${MIN_FULL_MARKET_COUNT}）`);
    }
    return { source: 'sina:hs_a', total: stocks.length, stocks };
}
