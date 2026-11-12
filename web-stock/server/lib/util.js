/**
 * 通用工具函数
 */

/**
 * 以固定并发度对列表执行异步映射（参考 app 端 StockRepo 拆 6 个并行任务拉全市场的做法）
 *
 * @template T,R
 * @param {T[]} items 任务列表
 * @param {number} limit 并发上限
 * @param {(item: T, index: number) => Promise<R>} fn 异步函数
 * @returns {Promise<R[]>} 与 items 顺序一致的结果
 */
export async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 数值归一化：上游可能返回 '-'（停牌/无数据）、字符串数字或 null
 *
 * @param {any} value 原始值
 * @returns {number|null} 数值或 null
 */
export function toNumber(value) {
    if (value === null || value === undefined || value === '-' || value === '') {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * 秒级时间戳 → 上海时区 HH:mm:ss
 *
 * @param {string|number|null} seconds 秒级时间戳
 * @returns {string|null}
 */
export function formatClockFromEpochSeconds(seconds) {
    const num = toNumber(seconds);
    if (num === null || num <= 0) {
        return null;
    }
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(new Date(num * 1000));
}
