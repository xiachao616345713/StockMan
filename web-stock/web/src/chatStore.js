/**
 * AI 助手聊天状态仓库（v1.5.0，模块级单例 ref）。
 *
 * 消息/会话状态从 ChatView 组件内部上移到模块级：App.vue 用 <component :is> 切换标签页会
 * 卸载组件，组件内部状态随之销毁——这是「切页回来对话消失」的根因（决策见 docs/design.md D17）。
 * 服务端为会话唯一真相源（chat-store 落库），本仓库负责：
 * - 会话列表加载/新建/切换/删除/重命名（页面刷新后从服务端恢复）
 * - SSE 流式收发（apiPostSse）：增量更新 reasoning/content/toolTrace，结束后落定消息
 * - activeSessionId 记忆到 localStorage（刷新后回到上次会话）
 */

import { ref } from 'vue';
import { apiGet, apiPost, apiPut, apiDelete, apiPostSse } from './api.js';

/** localStorage 记忆键：刷新后恢复上次打开的会话 */
const ACTIVE_SESSION_KEY = 'web-stock.active-chat-session';

/** @type {import('vue').Ref<Array<{id: string, title: string, createdAt: string, updatedAt: string, messageCount: number}>>} 会话列表（最近更新在前） */
export const sessions = ref([]);

/** 当前会话 id（'' 表示尚未创建，首次发送时惰性创建） */
export const activeSessionId = ref('');

/**
 * 当前会话消息流。
 * @type {import('vue').Ref<Array<{role: string, content: string, reasoning?: string|null, toolTrace?: Array, stocks?: Array, traceId?: string|null, isPending?: boolean, isError?: boolean, isThinkingExpanded?: boolean, meta?: object}>>}
 */
export const messages = ref([]);

/** 是否正在流式接收（发送按钮禁用/停止按钮显示） */
export const isStreaming = ref(false);

/** 会话列表是否已初始化（ChatView 首次挂载时触发 load） */
let isInitialized = false;

/** 当前流式请求的 AbortController（停止生成/组件清理用） */
let streamController = null;

// ---------------------------------------------------------------------------
// 会话管理
// ---------------------------------------------------------------------------

/**
 * 初始化：加载会话列表并恢复上次会话（或其消息）。幂等，ChatView onMounted 调用。
 */
export async function initChatStore() {
    if (isInitialized) {
        return;
    }
    isInitialized = true;
    await loadSessions();
    const remembered = localStorage.getItem(ACTIVE_SESSION_KEY);
    const target = sessions.value.find((s) => s.id === remembered) ?? sessions.value[0];
    if (target) {
        await openSession(target.id);
    }
}

/** 重新加载会话列表 */
export async function loadSessions() {
    const { data } = await apiGet('/api/agent/sessions');
    sessions.value = data.list ?? [];
}

/**
 * 切换会话（拉取消息并记住选择）
 *
 * @param {string} sessionId
 */
export async function openSession(sessionId) {
    const { data } = await apiGet(`/api/agent/sessions/${sessionId}`);
    activeSessionId.value = sessionId;
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    messages.value = (data.messages ?? []).map((msg) => ({
        role: msg.role,
        content: msg.content,
        reasoning: msg.reasoning ?? null,
        toolTrace: msg.toolTrace ?? [],
        stocks: msg.stocks ?? [],
        traceId: msg.traceId ?? null,
    }));
}

/**
 * 新建会话（立即创建并切换；空会话发送首条消息后由服务端命名标题）
 */
export async function handleCreateSession() {
    const { data } = await apiPost('/api/agent/sessions', {});
    await loadSessions();
    activeSessionId.value = data.id;
    localStorage.setItem(ACTIVE_SESSION_KEY, data.id);
    messages.value = [];
}

/**
 * 删除会话（删的是当前会话则切到列表首个）
 *
 * @param {string} sessionId
 */
export async function handleDeleteSession(sessionId) {
    await apiDelete(`/api/agent/sessions/${sessionId}`);
    await loadSessions();
    if (activeSessionId.value === sessionId) {
        const next = sessions.value[0];
        if (next) {
            await openSession(next.id);
        } else {
            activeSessionId.value = '';
            localStorage.removeItem(ACTIVE_SESSION_KEY);
            messages.value = [];
        }
    }
}

/**
 * 重命名会话
 *
 * @param {string} sessionId
 * @param {string} title
 */
export async function handleRenameSession(sessionId, title) {
    await apiPut(`/api/agent/sessions/${sessionId}`, { title });
    await loadSessions();
}

/** 停止当前流式生成（服务端收到断开后中止 Agent 循环，半截回答不落库） */
export function stopStreaming() {
    streamController?.abort();
}

// ---------------------------------------------------------------------------
// 发送消息（SSE 流式）
// ---------------------------------------------------------------------------

/**
 * 发送用户消息并流式接收回答。
 *
 * 无活动会话时先创建；消息即时上屏（用户消息 + 流式占位的助手消息），
 * SSE 事件增量更新 思考过程/回答文本/工具轨迹，done 后落定并刷新会话列表（标题/排序）。
 *
 * @param {string} text 用户输入
 */
export async function sendMessage(text) {
    const content = String(text ?? '').trim();
    if (!content || isStreaming.value) {
        return;
    }

    try {
        if (!activeSessionId.value) {
            const { data } = await apiPost('/api/agent/sessions', {});
            activeSessionId.value = data.id;
            localStorage.setItem(ACTIVE_SESSION_KEY, data.id);
        }

        messages.value.push({ role: 'user', content });
        const pending = {
            role: 'assistant',
            content: '',
            reasoning: '',
            toolTrace: [],
            stocks: [],
            traceId: null,
            isPending: true,
            isError: false,
            isThinkingExpanded: true, // 流式期间默认展开思考过程
            meta: null,
        };
        messages.value.push(pending);
        // 取响应式代理（直接改 push 前的裸对象不会触发视图更新）
        const live = messages.value[messages.value.length - 1];
        isStreaming.value = true;
        streamController = new AbortController();

        await apiPostSse(
            '/api/agent/chat',
            { sessionId: activeSessionId.value, message: content },
            (event, data) => handleSseEvent(live, event, data),
            streamController.signal,
        );
        // 流结束但未收到 done/error（服务端异常断流）：解除 pending，避免界面卡在「思考中」
        if (live.isPending) {
            live.isPending = false;
            if (!live.content) {
                live.isError = true;
                live.content = '连接中断，未收到完整回答，请重试';
            }
        }
    } catch (error) {
        const live = messages.value[messages.value.length - 1];
        if (error.name === 'AbortError') {
            // 用户主动停止：保留已收到的增量内容，标记中止
            if (live?.isPending) {
                live.isPending = false;
                live.content = live.content || '（已停止生成）';
                live.meta = { ...(live.meta ?? {}), aborted: true };
            }
        } else if (live?.isPending) {
            live.isPending = false;
            live.isError = true;
            live.content = error.message;
        }
    } finally {
        isStreaming.value = false;
        streamController = null;
        loadSessions().catch(() => {}); // 刷新标题/排序，失败静默（下次进入再刷）
    }
}

/**
 * SSE 事件 → 增量更新流式占位消息
 *
 * @param {object} live messages 尾部的响应式助手消息
 * @param {string} event 事件名
 * @param {object} data 事件数据
 */
function handleSseEvent(live, event, data) {
    switch (event) {
        case 'session': {
            // 服务端以首条消息命名标题：同步到本地会话列表
            const session = sessions.value.find((s) => s.id === data.sessionId);
            if (session && data.title) {
                session.title = data.title;
            }
            break;
        }
        case 'round_start':
            live.meta = { ...(live.meta ?? {}), round: data.round };
            break;
        case 'reasoning':
            live.reasoning = (live.reasoning ?? '') + data.text;
            break;
        case 'content':
            live.content += data.text;
            break;
        case 'tool_call':
            live.toolTrace.push({
                tool: data.tool,
                label: data.label,
                args: data.args,
                status: 'running',
                summary: '',
                durationMs: 0,
                round: data.round,
                index: data.index,
            });
            break;
        case 'tool_result': {
            const entry = live.toolTrace.find((t) => t.round === data.round && t.index === data.index && t.status === 'running');
            if (entry) {
                entry.status = data.status;
                entry.summary = data.summary;
                entry.durationMs = data.durationMs;
            }
            break;
        }
        case 'done':
            live.content = data.reply;
            live.reasoning = data.reasoning ?? live.reasoning ?? '';
            live.toolTrace = data.toolTrace ?? live.toolTrace;
            live.stocks = data.stocks ?? [];
            live.traceId = data.traceId ?? null;
            live.meta = {
                model: data.model,
                llmRounds: data.llmRounds,
                truncated: data.truncated,
                aborted: data.aborted,
                durationMs: data.durationMs,
                usage: data.usage,
            };
            live.isPending = false;
            live.isThinkingExpanded = false; // 完成后默认收起思考过程
            break;
        case 'error':
            live.isPending = false;
            live.isError = true;
            live.content = data.message;
            break;
        default:
            break;
    }
}
