/**
 * 后端 API 调用封装。
 *
 * 响应信封约定（见 server/api.js 与 docs/api.md）：
 *   成功 { data, meta: { source, fetchedAt, fromCache } }
 *   失败 { error: { status, message } }
 */

/**
 * GET 请求
 *
 * @param {string} path 接口路径，如 /api/quote
 * @param {Record<string, string|number|null|undefined>} [params] 查询参数（空值自动忽略）
 * @returns {Promise<{data: any, meta: object}>}
 * @throws {Error} 携带后端 error.message
 */
export async function apiGet(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }
    const response = await fetch(url.toString());
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error) {
        throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return body;
}

/**
 * POST 请求（JSON 请求体）
 *
 * @param {string} path 接口路径，如 /api/agent/chat
 * @param {object} body 请求体（JSON 序列化后发送）
 * @returns {Promise<{data: any, meta: object}>}
 * @throws {Error} 携带后端 error.message
 */
export async function apiPost(path, body) {
    const response = await fetch(new URL(path, window.location.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return payload;
}

/**
 * PUT 请求（JSON 请求体）
 *
 * @param {string} path 接口路径，如 /api/config
 * @param {object} body 请求体（JSON 序列化后发送）
 * @returns {Promise<{data: any, meta: object}>}
 * @throws {Error} 携带后端 error.message
 */
export async function apiPut(path, body) {
    const response = await fetch(new URL(path, window.location.origin), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return payload;
}
