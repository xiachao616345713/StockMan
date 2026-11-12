/**
 * 上游 HTTP 请求封装。
 *
 * 统一处理：桌面 Chrome User-Agent（防反爬，见 docs/stock-data-apis/README.md「鉴权/特殊请求头」）、
 * 超时、失败重试。超时/重试次数/退避基数默认取自 config.http（可在设置页调整，v1.4.0），
 * 调用方仍可按需传入 options 覆盖单次请求。
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
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': DESKTOP_UA, Accept: '*/*', ...headers },
                signal: AbortSignal.timeout(effectiveTimeout),
                redirect: 'follow',
            });
            if (!response.ok) {
                throw new UpstreamError(`上游返回 HTTP ${response.status}: ${url}`);
            }
            return await response.text();
        } catch (error) {
            lastError = error;
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
        throw new UpstreamError(`上游响应不是合法 JSON: ${url}`, { cause: error });
    }
}

