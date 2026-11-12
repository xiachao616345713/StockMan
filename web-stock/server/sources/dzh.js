/**
 * 大智慧（DZH）数据源：人气榜。
 *
 * 接口出处（docs/stock-data-apis/others.md §2）：
 * - GET https://imsearch.dzh.com.cn/stock/top（size=300&type=0&time=h 小时榜）
 *
 * 响应为弱类型结构（实测）：result: [ { "SZ300502": 10286.6196 }, ... ]，
 * 每项是单键 Map（带 SH/SZ 市场前缀的代码 → 热度值），列表顺序即排名；无股票名称。
 */

import { fetchJson } from '../lib/http.js';
import { toNumber } from '../lib/util.js';

const TOP_URL = 'https://imsearch.dzh.com.cn/stock/top?size=300&type=0&time=h';

/**
 * 大智慧人气榜
 *
 * @returns {Promise<{source: string, stocks: any[]}>}
 */
export async function fetchHotRanking() {
    const json = await fetchJson(TOP_URL);
    if (!Array.isArray(json?.result)) {
        throw new Error('大智慧人气榜响应缺少 result 数组');
    }
    const stocks = [];
    json.result.forEach((entry, index) => {
        const first = Object.entries(entry ?? {})[0];
        if (!first) {
            return;
        }
        const code = String(first[0]).replace(/^(sh|sz|bj)/i, '');
        if (!/^\d{6}$/.test(code)) {
            return;
        }
        stocks.push({
            code,
            name: null, // 上游不提供名称，由合并层其他平台补齐
            rank: index + 1,
            heat: toNumber(first[1]), // 热度值
        });
    });
    return { source: 'dzh:stock/top', stocks };
}
