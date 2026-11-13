/**
 * 上游 HTTP 请求封装。
 *
 * 统一处理：桌面 Chrome User-Agent（防反爬，见 docs/stock-data-apis/README.md「鉴权/特殊请求头」）、
 * 超时、失败重试、按主机限流。超时/重试次数/退避基数/限流参数默认取自 config.http
 * （可在设置页调整，v1.4.0；限流 v1.6.1，见 docs/design.md D20），
 * 调用方仍可按需传入 options 覆盖单次请求。
 *
 * 限流（v1.6.1）：行情上游对高频访问有隐性频率限制（触发后返回空数据/拒绝连接），
 * 快照分页（≈60 页）与历史回补（批 5 并发）都是突发流量源。按「主机」维度限制：
 * - maxConcurrent：同一主机同时在途请求数上限；
 * - minIntervalMs：同一主机相邻两次请求的启动最小间隔（平滑突发）。
 * 全部上游请求经本模块发出，限流在 acquireSlot 单点生效，对 sources 层透明。
 *
 * 失败日志（v1.6.1）：每次尝试失败（网络错误/非 2xx）都打 console.warn，
 * 含 URL、尝试轮次、HTTP 状态与响应体摘录，便于排查上游限流/空返回。
 */

import { sleep } from './util.js';
import { getGroup } from './config.js';

export const DESKTOP_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 上游请求失败（网络错误 / 非 2xx / JSON 解析失败） */
export class UpstreamError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'UpstreamError';
    }
}

// ---------------------------------------------------------------------------
// 按主机限流（并发上限 + 最小启动间隔，参数取 config.http，热生效）
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, {queue: Array<{resolve: () => void}>, running: number, lastStartAt: number, timer: NodeJS.Timeout|null}>}
 * 每主机一个限流器；进程生命周期内常驻（主机数量有限，无需清理）
 */
const limiters = new Map();

function getLimiter(host) {
    let limiter = limiters.get(host);
    if (!limiter) {
        limiter = { queue: [], running: 0, lastStartAt: 0, timer: null };
        limiters.set(host, limiter);
    }
    return limiter;
}

/** URL → 主机名（解析失败时以原串兜底，保证同 URL 仍归入同一限流器） */
function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return String(url);
    }
}

/**
 * 派发队列：并发未满且距上次启动 ≥ minIntervalMs 时逐个放行；
 * 间隔未到则定时重试，并发满则由 release 触发的 pump 再派发。
 */
function pump(limiter, maxConcurrent, minIntervalMs) {
    if (limiter.timer !== null || limiter.queue.length === 0) {
        return;
    }
    const dispatch = () => {
        limiter.timer = null;
        while (limiter.queue.length > 0 && limiter.running < maxConcurrent) {
            const waitMs = limiter.lastStartAt + minIntervalMs - Date.now();
            if (waitMs > 0) {
                limiter.timer = setTimeout(dispatch, waitMs);
                return;
            }
            limiter.running += 1;
            limiter.lastStartAt = Date.now();
            limiter.queue.shift().resolve();
        }
    };
    dispatch();
}

/**
 * 等待该主机的限流名额。
 *
 * @param {string} url 目标 URL（按 host 归组）
 * @returns {Promise<() => void>} 放行后 resolve，返回值须在请求结束时调用（释放并发名额）
 */
function acquireSlot(url) {
    // 使用时读取配置（勿在模块加载期缓存），设置页改值后下一次请求即生效
    const { maxConcurrent, minIntervalMs } = getGroup('http');
    const limiter = getLimiter(hostOf(url));
    return new Promise((resolve) => {
        limiter.queue.push({ resolve });
        pump(limiter, maxConcurrent, minIntervalMs);
    }).then(() => {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            limiter.running -= 1;
            pump(limiter, maxConcurrent, minIntervalMs);
        };
    });
}

/** 非 2xx 响应体摘录（截 200 字符，日志排查用；限流页/错误页常带说明文字） */
async function bodyExcerpt(response) {
    try {
        return (await response.text()).slice(0, 200);
    } catch {
        return '';
    }
}

/**
 * 失败原因的可读描述：超时单说；网络错误下钻 cause 链——
 * undici 的 fetch 失败 message 恒为「fetch failed」，真实原因（ECONNREFUSED/ENOTFOUND/ECONNRESET 等）在 cause 里，
 * 不打出来就无法区分「上游限流断连」与「本机网络不通」。
 */
function describeError(error, timeoutMs) {
    if (error?.name === 'TimeoutError') {
        return `超时（>${timeoutMs / 1000}s）`;
    }
    const parts = [error?.message ?? String(error)];
    let cause = error?.cause;
    for (let depth = 0; cause && depth < 3; depth += 1) {
        const detail = cause.code ?? cause.message ?? String(cause);
        if (detail && !parts.includes(detail)) {
            parts.push(detail);
        }
        cause = cause.cause;
    }
    return parts.join(' | ');
}

/**
 * GET 请求并返回响应文本
 *
 * @param {string} url 完整 URL
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers] 额外请求头
 * @param {number} [options.timeoutMs] 超时毫秒数（缺省取 config.http.timeoutMs）
 * @param {number} [options.retries] 失败重试次数（不含首次，缺省取 config.http.retries）
 * @param {number} [options.retryBackoffMs] 重试退避基数（缺省取 config.http.retryBackoffMs）
 * @returns {Promise<string>}
 */
export async function fetchText(url, { headers = {}, timeoutMs, retries, retryBackoffMs } = {}) {
    // 使用时读取配置（勿在模块加载期缓存），确保设置页改值后下一次请求即生效
    const httpConfig = getGroup('http');
    const effectiveTimeout = timeoutMs ?? httpConfig.timeoutMs;
    const effectiveRetries = retries ?? httpConfig.retries;
    const effectiveBackoff = retryBackoffMs ?? httpConfig.retryBackoffMs;

    let lastError;
    for (let attempt = 0; attempt <= effectiveRetries; attempt += 1) {
        if (attempt > 0) {
            await sleep(effectiveBackoff * attempt);
        }
        // 每次尝试都过限流闸门（重试同样计入频率，避免重试风暴加剧限流）
        const release = await acquireSlot(url);
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': DESKTOP_UA, Accept: '*/*', ...headers },
                signal: AbortSignal.timeout(effectiveTimeout),
                redirect: 'follow',
            });
            if (!response.ok) {
                // 消息不含 URL（warn 日志与最终包装错误都会带上，避免重复）；
                // 摘录保留：限流/风控页常在响应体里说明原因
                const excerpt = await bodyExcerpt(response);
                throw new UpstreamError(
                    `上游返回 HTTP ${response.status}${excerpt ? ` | 响应摘录: ${excerpt}` : ''}`,
                );
            }
            return await response.text();
        } catch (error) {
            lastError = error;
            console.warn(
                `[http] 上游请求失败（第 ${attempt + 1}/${effectiveRetries + 1} 次尝试）: ${url} → ${describeError(error, effectiveTimeout)}`,
            );
        } finally {
            release();
        }
    }
    throw new UpstreamError(`请求上游失败（已重试 ${effectiveRetries} 次）: ${url}`, { cause: lastError });
}

/**
 * GET 请求并解析 JSON
 *
 * @param {string} url 完整 URL
 * @param {object} [options] 同 fetchText
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
    const text = await fetchText(url, options);
    try {
        return JSON.parse(text);
    } catch (error) {
        console.warn(`[http] 上游响应不是合法 JSON: ${url} | 摘录: ${text.slice(0, 200)}`);
        throw new UpstreamError(`上游响应不是合法 JSON: ${url}`, { cause: error });
    }
}
