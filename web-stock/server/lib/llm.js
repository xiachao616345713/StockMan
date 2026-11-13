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
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (!message) {
        throw new LlmError('LLM 响应缺少 choices[0].message（请确认服务为 OpenAI 兼容格式）');
    }
    return {
        role: 'assistant',
        content: message.content ?? '',
        reasoning: message.reasoning_content ?? null,
        finishReason: choice.finish_reason ?? null,
        ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
            ? { tool_calls: message.tool_calls }
            : {}),
        usage: normalizeUsage(payload?.usage),
    };
}

/** usage 归一化（各厂商字段可能缺失，缺失为 null） */
function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }
    return {
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
    };
}

// ---------------------------------------------------------------------------
// 流式调用（SSE，v1.5.0）
// ---------------------------------------------------------------------------

/**
 * 流式调用 chat/completions（stream:true），增量回调 + 聚合返回 assistant 消息。
 *
 * 增量事件（onDelta 回调）：
 *   {type: 'reasoning', text}  思考过程增量（DeepSeek reasoning_content 等，逐字推送）
 *   {type: 'content', text}    正式回答增量
 *
 * 聚合逻辑：
 * - content / reasoning_content 按到达顺序拼接；
 * - tool_calls 按 delta.index 分组聚合（id/name 取首个非空值，arguments 字符串逐段拼接）；
 * - usage 取含该字段的 chunk（DeepSeek/OpenAI 在最后一个 chunk 附带）。
 *
 * @param {object} options 同 chatCompletions，另加：
 * @param {(event: {type: 'reasoning'|'content', text: string}) => void} [options.onDelta] 增量回调
 * @param {AbortSignal} [options.signal] 外部中止信号（客户端断开时中止上游流）
 * @returns {Promise<{role: 'assistant', content: string, reasoning: string|null, finishReason: string|null, tool_calls?: Array<object>, usage: object|null}>}
 * @throws {LlmConfigError} 未配置
 * @throws {LlmError} 调用失败
 */
export async function chatCompletionsStream({ messages, tools = null, temperature, maxTokens, timeoutMs, onDelta, signal }) {
    const config = getLlmConfig();
    if (!config) {
        throw new LlmConfigError(
            'LLM 未配置：请在「设置」页填写模型地址与 Access Token（或设置环境变量 LLM_MODEL_URL / LLM_ACCESS_TOKEN / LLM_MODEL 后重启），详见 README「AI 选股助手」',
        );
    }
    const body = {
        model: config.model,
        messages,
        temperature: temperature ?? config.temperature,
        max_tokens: maxTokens ?? config.maxTokens,
        stream: true,
    };
    if (tools?.length) {
        body.tools = tools;
    }

    // 超时与外部中止合并：任一触发即断开上游流
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs ?? config.timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) {
            controller.abort();
        } else {
            signal.addEventListener('abort', onOuterAbort, { once: true });
        }
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
            signal: controller.signal,
        });
    } catch (error) {
        const abortedByOuter = signal?.aborted;
        const reason = abortedByOuter ? '请求已中止' : controller.signal.aborted && !abortedByOuter
            ? `超时（>${(timeoutMs ?? config.timeoutMs) / 1000}s）`
            : '网络错误';
        throw new LlmError(`LLM 服务连接失败（${reason}）: ${config.modelUrl}`, { cause: error });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
        throw new LlmError(`LLM 服务返回 HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.body) {
        clearTimeout(timer);
        throw new LlmError('LLM 服务未返回流式响应体（请确认服务端点支持 stream:true）');
    }

    let content = '';
    let reasoning = '';
    let usage = null;
    /** 上游截断原因（v1.6.2）：length=token 打满 / content_filter=审查 / stop=正常，空响应排查的关键字段 */
    let finishReason = null;
    /** 坏 chunk 统计（v1.6.1）：网关限流页/心跳注释等会解析失败，成片出现即「返回空」的直接线索 */
    let badChunks = 0;
    let firstBadChunk = '';
    /** @type {Map<number, {id: string, name: string, arguments: string}>} 按 delta.index 聚合 */
    const toolCalls = new Map();

    try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        const handleChunkJson = (json) => {
            let chunk;
            try {
                chunk = JSON.parse(json);
            } catch {
                // 容忍个别坏 chunk（如网关心跳注释行）；数量与首例留日志排查
                badChunks += 1;
                if (!firstBadChunk) {
                    firstBadChunk = json.slice(0, 200);
                }
                return;
            }
            if (chunk?.usage) {
                usage = normalizeUsage(chunk.usage);
            }
            const choice = chunk?.choices?.[0];
            // finish_reason 在最后一个 chunk 携带（该 chunk 的 delta 可能为空对象），须在 delta 判断前捕获
            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }
            const delta = choice?.delta;
            if (!delta) {
                return;
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                onDelta?.({ type: 'reasoning', text: delta.reasoning_content });
            }
            if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                onDelta?.({ type: 'content', text: delta.content });
            }
            if (Array.isArray(delta.tool_calls)) {
                for (const part of delta.tool_calls) {
                    const index = Number(part?.index ?? 0);
                    if (!toolCalls.has(index)) {
                        toolCalls.set(index, { id: '', name: '', arguments: '' });
                    }
                    const acc = toolCalls.get(index);
                    if (part?.id) {
                        acc.id = part.id;
                    }
                    if (part?.function?.name) {
                        acc.name += part.function.name;
                    }
                    if (typeof part?.function?.arguments === 'string') {
                        acc.arguments += part.function.arguments;
                    }
                }
            }
        };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            // SSE 帧以空行分隔；行内以 'data: ' 前缀携带 JSON
            let sepIndex;
            while ((sepIndex = buffer.search(/\r?\n\r?\n/)) !== -1) {
                const frame = buffer.slice(0, sepIndex);
                buffer = buffer.slice(sepIndex + buffer.slice(sepIndex).match(/^\r?\n\r?\n/)[0].length);
                for (const line of frame.split(/\r?\n/)) {
                    const trimmed = line.replace(/^data:\s?/, '');
                    if (line.startsWith('data:') && trimmed !== '[DONE]') {
                        handleChunkJson(trimmed);
                    }
                }
            }
        }
        // 流结束：处理 buffer 中可能残留的最后一帧（无结尾空行的服务端）
        if (buffer.trim()) {
            for (const line of buffer.split(/\r?\n/)) {
                const trimmed = line.replace(/^data:\s?/, '');
                if (line.startsWith('data:') && trimmed !== '[DONE]') {
                    handleChunkJson(trimmed);
                }
            }
        }
    } catch (error) {
        if (signal?.aborted) {
            throw new LlmError('LLM 流式响应已中止（客户端断开）', { cause: error });
        }
        throw new LlmError(`读取 LLM 流式响应失败: ${error.message}`, { cause: error });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
    }

    const calls = [...toolCalls.values()].filter((call) => call.name || call.arguments);
    // 空响应日志（v1.6.1）：对话「返回空导致失败」的排查锚点——
    // content/reasoning/tool_calls/usage 全空通常意味着上游限流、内容审查截断或端点异常
    if (!content && !reasoning && calls.length === 0 && !usage) {
        console.warn(
            `[llm] 流式响应为空（无 content/reasoning/tool_calls/usage）: model=${config.model} url=${completionsUrl(config.modelUrl)}` +
            ` finish_reason=${finishReason ?? 'null'}` +
            (badChunks > 0 ? ` | 坏 chunk ${badChunks} 个，首例: ${firstBadChunk}` : ''),
        );
    } else if (badChunks > 0) {
        console.warn(`[llm] 流式响应含 ${badChunks} 个无法解析的 chunk（已跳过），首例: ${firstBadChunk}`);
    }
    return {
        role: 'assistant',
        content,
        reasoning: reasoning || null,
        finishReason,
        ...(calls.length > 0
            ? {
                  tool_calls: calls.map((call, index) => ({
                      id: call.id || `call_stream_${index}`,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments },
                  })),
              }
            : {}),
        usage,
    };
}
