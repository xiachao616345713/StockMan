/**
 * OpenAI 兼容 LLM 客户端（零第三方依赖，Node 内置 fetch）。
 *
 * 配置来源（v1.4.0）：统一由配置中心 lib/config.js 的 llm 组提供（持久化在数据库，可在设置页读写）。
 * 首次运行时，配置中心会用 LLM_* 环境变量或 server/llm.config.json 播种 llm 组（见 config.js#init），
 * 此后数据库为唯一真相源。token 只在服务端，绝不下发前端（GET /api/config 经 maskSecrets 隐藏）。
 *
 * modelUrl 兼容两种写法（自动补全）：
 *   https://api.example.com/v1                   → 追加 /chat/completions
 *   https://api.example.com/v1/chat/completions  → 原样使用
 *
 * 要求模型服务支持 OpenAI 风格的 function calling（tools/tool_calls），
 * 主流兼容端点（DeepSeek / DashScope / Moonshot / OpenAI 等）均可。
 */

import { getGroup } from './config.js';

/** LLM 未配置（缺 model_url / access_token，或 llm.enabled=false） */
export class LlmConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmConfigError';
    }
}

/** LLM 服务调用失败（网络错误 / 非 2xx / 超时 / 响应结构异常） */
export class LlmError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'LlmError';
    }
}

/**
 * 读取 LLM 配置（来自配置中心 llm 组）。
 * 未启用 / 缺 modelUrl / 缺 accessToken 时返回 null（路由层给出 503 引导提示）。
 *
 * @returns {{modelUrl: string, accessToken: string, model: string, timeoutMs: number, temperature: number, maxTokens: number}|null}
 */
export function getLlmConfig() {
    const config = getGroup('llm');
    const modelUrl = String(config.modelUrl ?? '').trim();
    const accessToken = String(config.accessToken ?? '').trim();
    const model = String(config.model ?? '').trim();
    if (!config.enabled || !modelUrl || !accessToken) {
        return null;
    }
    return {
        modelUrl,
        accessToken,
        model: model || 'default',
        timeoutMs: config.timeoutMs,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
    };
}

/** LLM 是否已配置（路由层给出 503 引导提示用） */
export function isLlmConfigured() {
    return getLlmConfig() !== null;
}

/** model_url → chat/completions 完整地址（已含则原样使用） */
function completionsUrl(modelUrl) {
    const trimmed = modelUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * 调用一次 chat/completions，返回 assistant 消息（可能携带 tool_calls）
 *
 * @param {object} options
 * @param {Array<object>} options.messages OpenAI 格式消息数组（含 system/user/assistant/tool）
 * @param {Array<object>|null} [options.tools] 工具定义（function calling schema）
 * @param {number} [options.temperature] 缺省取 config.llm.temperature
 * @param {number} [options.maxTokens] 缺省取 config.llm.maxTokens
 * @param {number} [options.timeoutMs] 缺省取 config.llm.timeoutMs
 * @returns {Promise<{role: 'assistant', content: string, tool_calls?: Array<object>}>}
 * @throws {LlmConfigError} 未配置
 * @throws {LlmError} 调用失败
 */
export async function chatCompletions({ messages, tools = null, temperature, maxTokens, timeoutMs }) {
    const config = getLlmConfig();
    if (!config) {
        throw new LlmConfigError(
            'LLM 未配置：请在「设置」页填写模型地址与 Access Token（或设置环境变量 LLM_MODEL_URL / LLM_ACCESS_TOKEN / LLM_MODEL 后重启），详见 README「AI 选股助手」',
        );
    }
    const effectiveTemperature = temperature ?? config.temperature;
    const effectiveMaxTokens = maxTokens ?? config.maxTokens;
    const effectiveTimeout = timeoutMs ?? config.timeoutMs;

    const body = { model: config.model, messages, temperature: effectiveTemperature, max_tokens: effectiveMaxTokens };
    if (tools?.length) {
        body.tools = tools;
    }

    let response;
    try {
        response = await fetch(completionsUrl(config.modelUrl), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.accessToken}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(effectiveTimeout),
        });
    } catch (error) {
        const reason = error?.name === 'TimeoutError' ? `超时（>${effectiveTimeout / 1000}s）` : '网络错误';
        throw new LlmError(`LLM 服务连接失败（${reason}）: ${config.modelUrl}`, { cause: error });
    }

    const text = await response.text();
    if (!response.ok) {
        // 响应体截取前 300 字符便于排查（如 401 提示 key 无效），不回显任何请求头信息
        throw new LlmError(`LLM 服务返回 HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    let payload;
    try {
        payload = JSON.parse(text);
    } catch (error) {
        throw new LlmError('LLM 响应不是合法 JSON', { cause: error });
    }
    const message = payload?.choices?.[0]?.message;
    if (!message) {
        throw new LlmError('LLM 响应缺少 choices[0].message（请确认服务为 OpenAI 兼容格式）');
    }
    return {
        role: 'assistant',
        content: message.content ?? '',
        ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
            ? { tool_calls: message.tool_calls }
            : {}),
    };
}
