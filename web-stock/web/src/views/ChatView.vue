<script setup>
/**
 * ChatView：AI 选股助手（v1.3.0，默认标签页）。
 *
 * - 聊天流：用户/助手气泡；助手消息附带 工具调用轨迹（🔧 条件选股 · 命中 N 只）与
 *   可点击股票 chips（点击经 store.openStock 跳个股页）
 * - 输入区：Enter 发送 / Shift+Enter 换行；空会话展示常用筛选问题预设
 * - 后端 POST /api/agent/chat：LLM function-calling Agent（决策见 docs/design.md D14），
 *   model_url/access_token 仅配置在服务端，前端不接触任何 LLM 凭据
 */
import { ref, nextTick } from 'vue';
import { apiPost } from '../api.js';
import { openStock } from '../store.js';
import { fmtPct, trendClass } from '../utils/format.js';

/** 每次请求携带的最大历史条数（更早的自动截断，防 prompt 膨胀；后端上限 30） */
const HISTORY_LIMIT = 20;

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

/** @type {import('vue').Ref<Array<{role: string, content: string, toolTrace?: Array, stocks?: Array, isPending?: boolean, isError?: boolean}>>} */
const messages = ref([]);
const draft = ref('');
const isSending = ref(false);
const listEl = ref(null);

const scrollToBottom = async () => {
    await nextTick();
    if (listEl.value) {
        listEl.value.scrollTop = listEl.value.scrollHeight;
    }
};

/**
 * 发送消息（无参数时取输入框内容；预设问题以参数传入）
 *
 * @param {string} [presetText] 引导问题文本
 */
const handleSend = async (presetText) => {
    const text = String(presetText ?? draft.value).trim();
    if (!text || isSending.value) {
        return;
    }
    draft.value = '';
    messages.value.push({ role: 'user', content: text });
    messages.value.push({ role: 'assistant', content: '', isPending: true });
    // 取响应式代理（直接改 push 前的裸对象不会触发视图更新）
    const pending = messages.value[messages.value.length - 1];
    isSending.value = true;
    await scrollToBottom();

    try {
        const history = messages.value
            .filter((msg) => !msg.isPending && !msg.isError)
            .slice(-HISTORY_LIMIT)
            .map((msg) => ({ role: msg.role, content: msg.content }));
        const { data } = await apiPost('/api/agent/chat', { messages: history });
        pending.content = data.reply;
        pending.toolTrace = data.toolTrace ?? [];
        pending.stocks = data.stocks ?? [];
    } catch (error) {
        pending.isError = true;
        pending.content = error.message;
    } finally {
        pending.isPending = false;
        isSending.value = false;
        await scrollToBottom();
    }
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

const handleClear = () => {
    if (!isSending.value) {
        messages.value = [];
    }
};
</script>

<template>
    <div class="chat-view panel">
        <div class="panel-title">
            <h2>
                AI 选股助手
                <span class="sub">用自然语言描述筛选条件，Agent 实时调用行情数据完成选股</span>
            </h2>
            <button
                class="btn"
                :disabled="isSending || messages.length === 0"
                @click="handleClear"
            >
                清空对话
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
                    <div
                        v-if="msg.isPending"
                        class="pending-line"
                    >
                        <span class="loading-spinner" />思考中，正在查询实时行情…
                    </div>
                    <template v-else>
                        <div
                            v-if="msg.toolTrace?.length"
                            class="tool-trace"
                        >
                            <span
                                v-for="(item, traceIndex) in msg.toolTrace"
                                :key="traceIndex"
                                class="tag"
                                :class="item.status === 'ok' ? 'tag-accent' : 'tag-warn'"
                                :title="`工具 ${item.tool} 参数: ${JSON.stringify(item.args)}`"
                            >
                                🔧 {{ item.label }}<template v-if="item.summary"> · {{ item.summary }}</template>
                            </span>
                        </div>
                        <div class="bubble-text">{{ msg.content }}</div>
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
                    </template>
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
                :disabled="isSending"
                @keydown="handleKeydown"
            />
            <button
                class="btn btn-primary send-btn"
                :disabled="isSending || !draft.trim()"
                @click="handleSend()"
            >
                {{ isSending ? '查询中…' : '发送' }}
            </button>
        </div>
    </div>
</template>

<style scoped>
.chat-view {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 170px);
    min-height: 420px;
}

/* 消息流 */
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

.pending-line {
    color: var(--muted);
    font-size: 13px;
}

/* 工具调用轨迹 */
.tool-trace {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
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

    .bubble {
        max-width: 92%;
    }
}
</style>
