<!--
  ChatView Component（v1.5.0，默认标签页）

  AI 选股助手聊天界面：
  - 左侧会话列表：多会话管理（新建/切换/重命名/删除），状态存于模块级 chatStore.js，
    切换标签页/跳转个股页回来不再丢失（服务端持久化，刷新后自动恢复）
  - 右侧聊天流：SSE 流式渲染——💭 思考过程逐字展示（可折叠）、🔧 工具调用实时轨迹
    （参数悬浮可见、执行中/成功/失败状态与耗时）、回答文本增量输出、可点击股票 chips
  - 可观测入口：每条助手消息「🔗 调用链路」打开 TracePanel 看板；标题栏「📋 提示词与工具」
    打开 AgentMetaDialog（系统提示词全文 + 13 个工具定义）
  - 后端 POST /api/agent/chat（SSE）：LLM function-calling Agent，会话历史由服务端维护
-->
<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { openStock } from '../store.js';
import {
    sessions,
    activeSessionId,
    messages,
    isStreaming,
    initChatStore,
    loadSessions,
    openSession,
    handleCreateSession,
    handleDeleteSession,
    handleRenameSession,
    sendMessage,
    stopStreaming,
} from '../chatStore.js';
import { fmtPct, trendClass } from '../utils/format.js';
import TracePanel from '../components/TracePanel.vue';
import AgentMetaDialog from '../components/AgentMetaDialog.vue';

/** 气泡内股票 chips 的最大展示数量 */
const CHIPS_LIMIT = 24;

/** 空会话时的引导问题（点击直接发送） */
const SUGGESTIONS = [
    '帮我筛选涨幅超过5%、换手率大于10%的创业板股票',
    '找主板准涨停股票（涨幅7%~9.95%），按涨幅排序',
    '今天大盘怎么样？哪些板块最热门？',
    '挑几只市盈率低于15、市净率低于1.5的低估值蓝筹',
    '今天涨停池里连板最高的股票有哪些？',
];

const draft = ref('');
const listEl = ref(null);
const isMetaVisible = ref(false);
/** @type {import('vue').Ref<string|null>} 当前打开的调用链路 trace id（null 关闭看板） */
const activeTraceId = ref(null);

const canSend = computed(() => !isStreaming.value && draft.value.trim().length > 0);

const scrollToBottom = async () => {
    await nextTick();
    const el = listEl.value;
    if (!el) {
        return;
    }
    // 用户上翻超过 120px 时不强制拉回底部（尊重阅读位置）
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) {
        el.scrollTop = el.scrollHeight;
    }
};

/** 强制滚到底（新会话/切换会话/发送时） */
const forceScrollToBottom = async () => {
    await nextTick();
    if (listEl.value) {
        listEl.value.scrollTop = listEl.value.scrollHeight;
    }
};

onMounted(async () => {
    try {
        await initChatStore();
    } catch (error) {
        console.error('会话初始化失败:', error);
    }
    await forceScrollToBottom();
    loadSessions().catch(() => {});
});

// 流式增量期间跟随滚动（消息内容/条数变化均触发）
watch(
    () => messages.value.map((msg) => `${msg.content?.length ?? 0}:${msg.reasoning?.length ?? 0}:${msg.toolTrace?.length ?? 0}`).join('|'),
    () => scrollToBottom(),
);

/**
 * 发送消息（无参数时取输入框内容；预设问题以参数传入）
 *
 * @param {string} [presetText] 引导问题文本
 */
const handleSend = async (presetText) => {
    const text = String(presetText ?? draft.value).trim();
    if (!text || isStreaming.value) {
        return;
    }
    draft.value = '';
    await forceScrollToBottom();
    await sendMessage(text);
};

/** Enter 发送 / Shift+Enter 换行；中文输入法组合期（isComposing）不触发发送 */
const handleKeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleSend();
    }
};

const handleStockClick = (code) => {
    openStock(code);
};

const handleNewChat = async () => {
    if (isStreaming.value) {
        stopStreaming();
    }
    await handleCreateSession();
    await forceScrollToBottom();
};

const handleSessionClick = async (sessionId) => {
    if (sessionId === activeSessionId.value) {
        return;
    }
    if (isStreaming.value) {
        stopStreaming();
    }
    await openSession(sessionId);
    await forceScrollToBottom();
};

const handleSessionDelete = async (event, sessionId) => {
    event.stopPropagation();
    if (!window.confirm('删除该会话及其全部消息？')) {
        return;
    }
    await handleDeleteSession(sessionId);
};

const handleSessionRename = async (event, session) => {
    event.stopPropagation();
    const title = window.prompt('会话新名称（≤60 字符）', session.title);
    if (title && title.trim() && title.trim() !== session.title) {
        await handleRenameSession(session.id, title.trim());
    }
};

const handleStop = () => {
    stopStreaming();
};

const handleToggleThinking = (msg) => {
    msg.isThinkingExpanded = !msg.isThinkingExpanded;
};

const handleOpenTrace = (traceId) => {
    activeTraceId.value = traceId;
};

const handleCloseTrace = () => {
    activeTraceId.value = null;
};

const handleOpenMeta = () => {
    isMetaVisible.value = true;
};

const handleCloseMeta = () => {
    isMetaVisible.value = false;
};

/** 会话时间显示：今天只显示时分，其余显示月-日 */
const fmtSessionTime = (isoText) => {
    if (!isoText) {
        return '';
    }
    const date = new Date(isoText);
    const now = new Date();
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (date.toDateString() === now.toDateString()) {
        return hm;
    }
    return `${date.getMonth() + 1}-${date.getDate()} ${hm}`;
};

const fmtMs = (ms) => {
    if (ms === null || ms === undefined) {
        return '';
    }
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};
</script>

<template>
    <div class="chat-view panel">
        <!-- 左侧：会话列表 -->
        <aside class="session-side">
            <div class="side-header">
                <span class="side-title">会话</span>
                <button
                    class="btn btn-small"
                    title="新建会话"
                    @click="handleNewChat"
                >
                    ＋ 新会话
                </button>
            </div>
            <div class="session-list">
                <div
                    v-if="sessions.length === 0"
                    class="session-empty"
                >
                    暂无历史会话<br>发送消息即自动创建
                </div>
                <div
                    v-for="session in sessions"
                    :key="session.id"
                    class="session-item"
                    :class="{ 'is-active': session.id === activeSessionId }"
                    @click="handleSessionClick(session.id)"
                >
                    <div class="session-main">
                        <span class="session-title">{{ session.title || '新会话' }}</span>
                        <span class="session-time">{{ fmtSessionTime(session.updatedAt) }} · {{ session.messageCount }} 条</span>
                    </div>
                    <div class="session-actions">
                        <button
                            class="icon-btn"
                            title="重命名"
                            @click="handleSessionRename($event, session)"
                        >
                            ✎
                        </button>
                        <button
                            class="icon-btn"
                            title="删除会话"
                            @click="handleSessionDelete($event, session.id)"
                        >
                            🗑
                        </button>
                    </div>
                </div>
            </div>
            <button
                class="btn btn-small meta-entry"
                @click="handleOpenMeta"
            >
                📋 系统提示词与工具
            </button>
        </aside>

        <!-- 右侧：聊天区 -->
        <div class="chat-main">
            <div class="panel-title">
                <h2>
                    AI 选股助手
                    <span class="sub">用自然语言描述筛选条件，Agent 实时调用行情数据完成选股</span>
                </h2>
                <button
                    v-if="isStreaming"
                    class="btn"
                    @click="handleStop"
                >
                    ⏹ 停止生成
                </button>
            </div>

            <div
                ref="listEl"
                class="chat-list"
            >
                <!-- 空会话引导 -->
                <div
                    v-if="messages.length === 0"
                    class="chat-welcome"
                >
                    <p class="welcome-title">👋 你好，我是 AI 选股助手</p>
                    <p class="welcome-sub">直接描述你想要的股票，我会调用实时行情数据帮你筛选。例如（点击即试）：</p>
                    <div class="suggestion-col">
                        <button
                            v-for="text in SUGGESTIONS"
                            :key="text"
                            class="suggestion-item"
                            @click="handleSend(text)"
                        >
                            {{ text }}
                        </button>
                    </div>
                </div>

                <!-- 消息流 -->
                <div
                    v-for="(msg, index) in messages"
                    :key="index"
                    class="chat-msg"
                    :class="`is-${msg.role}`"
                >
                    <div
                        class="bubble"
                        :class="{ 'is-error': msg.isError }"
                    >
                        <!-- 思考过程（流式逐字 / 完成后可折叠回看） -->
                        <div
                            v-if="msg.reasoning"
                            class="thinking-block"
                        >
                            <button
                                class="thinking-toggle"
                                @click="handleToggleThinking(msg)"
                            >
                                <span
                                    v-if="msg.isPending"
                                    class="loading-spinner"
                                />
                                💭 思考过程
                                <span class="thinking-caret">{{ msg.isThinkingExpanded === false ? '▸' : '▾' }}</span>
                            </button>
                            <pre
                                v-show="msg.isThinkingExpanded !== false"
                                class="thinking-text"
                            >{{ msg.reasoning }}</pre>
                        </div>

                        <div
                            v-if="msg.isPending && !msg.reasoning && !msg.content && !msg.toolTrace?.length"
                            class="pending-line"
                        >
                            <span class="loading-spinner" />思考中，正在查询实时行情…
                        </div>

                        <!-- 工具调用轨迹 -->
                        <div
                            v-if="msg.toolTrace?.length"
                            class="tool-trace"
                        >
                            <span
                                v-for="(item, traceIndex) in msg.toolTrace"
                                :key="traceIndex"
                                class="tag"
                                :class="item.status === 'ok' ? 'tag-accent' : item.status === 'running' ? 'tag-run' : 'tag-warn'"
                                :title="`工具 ${item.tool} 参数: ${JSON.stringify(item.args)}`"
                            >
                                <span
                                    v-if="item.status === 'running'"
                                    class="loading-spinner"
                                />
                                🔧 {{ item.label }}<template v-if="item.summary"> · {{ item.summary }}</template><template v-if="item.durationMs"> · {{ fmtMs(item.durationMs) }}</template>
                            </span>
                        </div>

                        <div
                            v-if="msg.content"
                            class="bubble-text"
                        >{{ msg.content }}<span
                            v-if="msg.isPending"
                            class="stream-caret"
                        />
                        </div>

                        <!-- 股票 chips（点击跳个股页） -->
                        <div
                            v-if="msg.stocks?.length"
                            class="stock-chips"
                        >
                            <button
                                v-for="stock in msg.stocks.slice(0, CHIPS_LIMIT)"
                                :key="stock.code"
                                class="stock-chip"
                                :title="`${stock.code} ${stock.name ?? ''} · 点击查看个股`"
                                @click="handleStockClick(stock.code)"
                            >
                                <span class="chip-name">{{ stock.name ?? stock.code }}</span>
                                <span
                                    class="num chip-pct"
                                    :class="trendClass(stock.pct)"
                                >{{ fmtPct(stock.pct) }}</span>
                            </button>
                        </div>

                        <!-- 消息底栏：模型/轮数/耗时/tokens + 调用链路入口 -->
                        <div
                            v-if="!msg.isPending && (msg.meta || msg.traceId)"
                            class="msg-footer"
                        >
                            <span
                                v-if="msg.meta?.model"
                                class="footer-stat"
                            >{{ msg.meta.model }}</span>
                            <span
                                v-if="msg.meta?.llmRounds"
                                class="footer-stat"
                            >{{ msg.meta.llmRounds }} 轮</span>
                            <span
                                v-if="msg.meta?.durationMs"
                                class="footer-stat"
                            >{{ fmtMs(msg.meta.durationMs) }}</span>
                            <span
                                v-if="msg.meta?.usage?.totalTokens"
                                class="footer-stat"
                            >{{ msg.meta.usage.totalTokens }} tokens</span>
                            <span
                                v-if="msg.meta?.truncated"
                                class="tag tag-warn"
                            >轮数上限中止</span>
                            <button
                                v-if="msg.traceId"
                                class="link-btn trace-link"
                                @click="handleOpenTrace(msg.traceId)"
                            >
                                🔗 调用链路
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 输入区 -->
            <div class="chat-input-row">
                <textarea
                    v-model="draft"
                    class="input chat-input"
                    rows="2"
                    placeholder="描述你想筛选的股票，如：涨幅超过5%、成交额大于10亿的主板股票（Enter 发送 / Shift+Enter 换行）"
                    :disabled="isStreaming"
                    @keydown="handleKeydown"
                />
                <button
                    class="btn btn-primary send-btn"
                    :disabled="!canSend"
                    @click="handleSend()"
                >
                    {{ isStreaming ? '生成中…' : '发送' }}
                </button>
            </div>
        </div>

        <!-- 调用链路看板（抽屉） -->
        <TracePanel
            v-if="activeTraceId"
            :trace-id="activeTraceId"
            @close="handleCloseTrace"
        />

        <!-- 系统提示词与工具（对话框） -->
        <AgentMetaDialog
            v-if="isMetaVisible"
            @close="handleCloseMeta"
        />
    </div>
</template>

<style scoped>
.chat-view {
    display: flex;
    gap: 12px;
    height: calc(100vh - 170px);
    min-height: 420px;
}

/* 左侧会话列表 */
.session-side {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    padding: 10px;
}

.side-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}

.side-title {
    font-size: 13px;
    color: var(--muted);
}

.btn-small {
    padding: 4px 10px;
    font-size: 12px;
}

.session-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.session-empty {
    margin: auto;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.8;
}

.session-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
}

.session-item:hover {
    background: var(--panel-2);
}

.session-item.is-active {
    border-color: rgba(79, 140, 255, 0.45);
    background: rgba(79, 140, 255, 0.1);
}

.session-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.session-title {
    font-size: 12.5px;
    color: var(--text-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.session-time {
    font-size: 11px;
    color: var(--muted);
}

.session-actions {
    display: none;
    gap: 2px;
}

.session-item:hover .session-actions {
    display: flex;
}

.icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    color: var(--muted);
    border-radius: 4px;
}

.icon-btn:hover {
    color: var(--text-strong);
    background: var(--panel);
}

.meta-entry {
    flex-shrink: 0;
}

/* 右侧聊天区 */
.chat-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.chat-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 8px 4px;
}

.chat-msg {
    display: flex;
}

.chat-msg.is-user {
    justify-content: flex-end;
}

.chat-msg.is-assistant {
    justify-content: flex-start;
}

.bubble {
    max-width: min(76%, 720px);
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel-2);
}

.is-user .bubble {
    background: rgba(79, 140, 255, 0.14);
    border-color: rgba(79, 140, 255, 0.4);
}

.bubble.is-error {
    border-color: rgba(246, 70, 93, 0.5);
    color: var(--up);
}

.bubble-text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 13.5px;
    line-height: 1.7;
}

.stream-caret {
    display: inline-block;
    width: 7px;
    height: 14px;
    margin-left: 2px;
    vertical-align: -2px;
    background: var(--accent);
    animation: caret-blink 0.9s steps(1) infinite;
}

@keyframes caret-blink {
    50% {
        opacity: 0;
    }
}

.pending-line {
    color: var(--muted);
    font-size: 13px;
}

/* 思考过程 */
.thinking-block {
    margin-bottom: 8px;
    border: 1px solid rgba(255, 193, 94, 0.35);
    border-radius: 8px;
    background: rgba(255, 193, 94, 0.06);
    overflow: hidden;
}

.thinking-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    color: rgba(255, 193, 94, 0.95);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
}

.thinking-caret {
    margin-left: auto;
    color: var(--muted);
}

.thinking-text {
    margin: 0;
    padding: 8px 12px;
    border-top: 1px dashed rgba(255, 193, 94, 0.25);
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow-y: auto;
    font-family: inherit;
}

/* 工具调用轨迹 */
.tool-trace {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
}

.tag-run {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    opacity: 0.85;
}

/* 消息底栏 */
.msg-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed var(--border);
}

.footer-stat {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--font-mono, monospace);
}

.trace-link {
    margin-left: auto;
}

.link-btn {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 11.5px;
    cursor: pointer;
    padding: 0;
}

.link-btn:hover {
    text-decoration: underline;
}

/* 股票 chips（点击跳个股页） */
.stock-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
}

.stock-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s;
}

.stock-chip:hover {
    border-color: var(--accent);
}

.chip-name {
    color: var(--text-strong);
}

.chip-pct {
    font-size: 12px;
}

/* 空会话引导 */
.chat-welcome {
    margin: auto;
    padding: 20px 0;
    text-align: center;
    color: var(--muted);
}

.welcome-title {
    font-size: 16px;
    color: var(--text-strong);
    margin-bottom: 6px;
}

.welcome-sub {
    font-size: 13px;
    margin-bottom: 14px;
}

.suggestion-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(520px, 90%);
    margin: 0 auto;
}

.suggestion-item {
    padding: 9px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-2);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s;
}

.suggestion-item:hover {
    border-color: var(--accent);
    color: var(--text-strong);
}

/* 输入区 */
.chat-input-row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    margin-top: 12px;
}

.chat-input {
    flex: 1;
    resize: none;
    font-family: inherit;
    line-height: 1.6;
}

.send-btn {
    padding: 10px 22px;
}

.btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}

.btn-primary:hover {
    filter: brightness(1.1);
}

@media (max-width: 900px) {
    .chat-view {
        height: calc(100vh - 200px);
    }

    .session-side {
        width: 150px;
    }

    .bubble {
        max-width: 92%;
    }
}
</style>
