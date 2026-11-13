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

/**
 * DELETE 请求
 *
 * @param {string} path 接口路径，如 /api/agent/sessions/{id}
 * @returns {Promise<{data: any, meta: object}>}
 * @throws {Error} 携带后端 error.message
 */
export async function apiDelete(path) {
    const response = await fetch(new URL(path, window.location.origin), { method: 'DELETE' });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }
    return payload;
}

/**
 * POST 请求并以 SSE 流式消费响应（v1.5.0，/api/agent/chat 专用）。
 *
 * EventSource 不支持 POST，故用 fetch + ReadableStream 手工解析 SSE 帧
 * （帧以空行分隔，帧内 event:/data: 行；data 为 JSON）。
 *
 * @param {string} path 接口路径
 * @param {object} body 请求体
 * @param {(event: string, data: any) => void} onEvent 事件回调（event 为 SSE 事件名）
 * @param {AbortSignal} [signal] 中止信号（组件卸载/用户停止时断开流）
 * @returns {Promise<void>} 流正常结束（收到服务端 end）后 resolve
 * @throws {Error} 流开始前的 HTTP/业务错误，或流中收到 error 事件
 */
export async function apiPostSse(path, body, onEvent, signal) {
    const response = await fetch(new URL(path, window.location.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    /** 解析单个 SSE 帧（event:/data: 行），回调 onEvent */
    const handleFrame = (frame) => {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith('event:')) {
                event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).replace(/^ /, ''));
            }
        }
        if (dataLines.length === 0) {
            return;
        }
        let data;
        try {
            data = JSON.parse(dataLines.join('\n'));
        } catch {
            return; // 非法 JSON 帧跳过（防御网关注入的心跳行）
        }
        onEvent(event, data);
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const frame = buffer.slice(0, separator);
            const matched = buffer.slice(separator).match(/^\r?\n\r?\n/)[0];
            buffer = buffer.slice(separator + matched.length);
            if (frame.trim()) {
                handleFrame(frame);
            }
        }
    }
    if (buffer.trim()) {
        handleFrame(buffer);
    }
}
