/**
 * 搜狐财经数据源（历史日 K 的兜底源）。
 *
 * 接口出处（docs/stock-data-apis/sohu.md，monitor 端 SohuApi 为历史日 K 首选策略）：
 * - GET https://q.stock.sohu.com/hisHq?code=cn_{code}&start={yyyyMMdd}&end={yyyyMMdd}
 * - 请求头：Referer https://quote.eastmoney.com/ + 桌面 UA（monitor 端同款）
 * - hq 行格式：[0]日期 [1]开盘 [2]收盘 [3]涨跌额 [4]涨跌幅% [5]最低 [6]最高
 *              [7]成交量(手) [8]成交额(万) [9]换手率%
 *
 * 归一化为与东财 kline 相同的行结构；成交额统一为元（×10000）；振幅缺失置 null。
 */

import { fetchJson } from '../lib/http.js';
import { toNumber } from '../lib/util.js';

const HEADERS = { Referer: 'https://quote.eastmoney.com/' };

/** 搜狐的百分比字段带 % 后缀（如 "0.99%"），需去掉后转数值 */
function toPercentNumber(value) {
    if (typeof value === 'string') {
        return toNumber(value.replace('%', ''));
    }
    return toNumber(value);
}

/**
 * 个股历史日 K（升序）
 *
 * @param {string} code 6 位代码
 * @param {string} startYyyymmdd 开始日期
 * @param {string} endYyyymmdd 结束日期
 * @returns {Promise<{code: string, name: string|null, preClose: number|null, klines: any[]}>}
 */
export async function fetchKline(code, startYyyymmdd, endYyyymmdd) {
    const url = `https://q.stock.sohu.com/hisHq?code=cn_${code}&start=${startYyyymmdd}&end=${endYyyymmdd}`;
    const json = await fetchJson(url, { headers: HEADERS });
    const entry = Array.isArray(json) ? json[0] : null;
    if (!entry || entry.status !== 0 || !Array.isArray(entry.hq)) {
        throw new Error(`搜狐 hisHq 响应异常: status=${entry?.status}`);
    }
    const klines = entry.hq.map((row) => ({
        date: row[0],
        open: toNumber(row[1]),
        close: toNumber(row[2]),
        change: toNumber(row[3]),
        pct: toPercentNumber(row[4]),
        low: toNumber(row[5]),
        high: toNumber(row[6]),
        volume: toNumber(row[7]), // 手
        amount: toNumber(row[8]) !== null ? toNumber(row[8]) * 10000 : null, // 万 → 元
        amplitude: null, // 搜狐不返回振幅，下方由相邻行推算
        turnover: toPercentNumber(row[9]),
    }));
    // 接口按日期降序返回，统一排序为升序
    klines.sort((a, b) => (a.date < b.date ? -1 : 1));
    // 用前一日收盘推算振幅%（与东财 kline 字段对齐）
    for (let i = 1; i < klines.length; i += 1) {
        const prevClose = klines[i - 1].close;
        const { high, low } = klines[i];
        if (prevClose && high !== null && low !== null) {
            klines[i].amplitude = Math.round(((high - low) / prevClose) * 10000) / 100;
        }
    }
    const preClose = klines.length >= 2 ? klines[klines.length - 2].close : null;
    return { code, name: null, preClose, klines };
}
