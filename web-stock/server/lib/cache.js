/**
 * 内存 TTL 缓存（带上游请求合并）。
 *
 * 目的：
 * 1. 降低对上游接口的请求频率（本项目所有数据均来自公开行情接口，需克制调用）；
 * 2. 并发请求同一 key 时只触发一次上游拉取（in-flight 去重）。
 */

/** @type {Map<string, {expireAt: number, value: any, promise: Promise<any>|null}>} */
const store = new Map();

/**
 * 读取缓存，未命中或过期时调用 producer 拉取并写入缓存
 *
 * @template T
 * @param {string} key 缓存键
 * @param {number | ((value: T) => number)} ttlMs 存活时间（毫秒）；
 *        传函数则按 producer 结果决定（v1.6.0，如龙虎榜发布前的空列表缩短 TTL）
 * @param {() => Promise<T>} producer 数据生产函数
 * @returns {Promise<{value: T, fromCache: boolean}>}
 */
export async function cached(key, ttlMs, producer) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit) {
        if (hit.value !== undefined && hit.expireAt > now) {
            return { value: hit.value, fromCache: true };
        }
        if (hit.promise) {
            // 已有同源请求在途，直接等待其结果
            return { value: await hit.promise, fromCache: true };
        }
    }

    const promise = producer()
        .then((value) => {
            const ttl = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
            store.set(key, { expireAt: Date.now() + ttl, value, promise: null });
            return value;
        })
        .catch((error) => {
            store.delete(key);
            throw error;
        });
    store.set(key, { expireAt: 0, value: undefined, promise });
    return { value: await promise, fromCache: false };
}

/** 清空全部缓存（调试用） */
export function clearCache() {
    store.clear();
}

/** 当前缓存条目数（/api/health 展示用） */
export function cacheSize() {
    return store.size;
}
