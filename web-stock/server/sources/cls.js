/**
 * 财联社（CLS）数据源：人气榜。
 *
 * 接口出处（docs/stock-data-apis/cls.md §1）：
 * - GET https://api3.cls.cn/v1/hot_stock（sign 为 app 端注解内固定值，无需用户配置）
 *
 * 响应：data 为列表，顺序即排名；stock.StockID 带 sh/sz/bj 市场前缀。
 */

import { fetchJson } from '../lib/http.js';
import { toNumber } from '../lib/util.js';

const HOT_STOCK_URL =
    'https://api3.cls.cn/v1/hot_stock?app=cailianpress&os=android&sv=850&sign=e4d8f886f269874b1578fec645b258fa';

/**
 * 财联社人气榜
 *
 * @returns {Promise<{source: string, stocks: any[]}>}
 */
export async function fetchHotRanking() {
    const json = await fetchJson(HOT_STOCK_URL);
    if (json?.errno !== 0 || !Array.isArray(json.data)) {
        throw new Error(`财联社人气榜响应异常: errno=${json?.errno} msg=${json?.msg}`);
    }
    const stocks = [];
    json.data.forEach((item, index) => {
        const code = String(item?.stock?.StockID ?? '').replace(/^(sh|sz|bj)/i, '');
        if (!/^\d{6}$/.test(code)) {
            return;
        }
        stocks.push({
            code,
            name: item.stock.name ?? null,
            rank: index + 1, // 列表顺序即排名
            rankChange: toNumber(item.ranking_change),
            price: toNumber(item.stock.last),
            pct: toNumber(item.stock.RiseRange), // %
        });
    });
    return { source: 'cls:hot_stock', stocks };
}
