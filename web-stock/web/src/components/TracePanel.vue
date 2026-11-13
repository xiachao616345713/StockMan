<!--
  TracePanel Component（v1.5.0）

  调用链路看板（右侧抽屉）：按 traceId 拉取 GET /api/agent/traces/{id}，
  逐轮展示一次 Agent 对话的完整执行链路，用于评估：
  - 模型输入输出质量（每轮输入消息数 / 思考过程 / 输出文本 / tokens）
  - 工具选择正确性（每轮选了哪些工具、顺序）
  - 工具参数正确性（原始 args JSON）与执行结果（状态/摘要/耗时/结果预览）

  Props:
  - traceId: 要展示的 trace id（null/空时不加载）
  Events:
  - close: 关闭抽屉
-->
<script setup>
import { ref, watch } from 'vue';
import { apiGet } from '../api.js';

const props = defineProps({
    traceId: { type: String, default: null },
});

const emit = defineEmits(['close']);

/** @type {import('vue').Ref<object|null>} trace 详情 */
const trace = ref(null);
const isLoading = ref(false);
const errorText = ref('');
/** 展开的结果预览集合（key: `${round}-${index}`） */
const expandedPreviews = ref(new Set());

const loadTrace = async (id) => {
    if (!id) {
        trace.value = null;
        return;
    }
    isLoading.value = true;
    errorText.value = '';
    try {
        const { data } = await apiGet(`/api/agent/traces/${id}`);
        trace.value = data;
        expandedPreviews.value = new Set();
    } catch (error) {
        errorText.value = error.message;
        trace.value = null;
    } finally {
        isLoading.value = false;
    }
};

watch(() => props.traceId, loadTrace, { immediate: true });

const handleClose = () => {
    emit('close');
};

const handleTogglePreview = (key) => {
    const next = new Set(expandedPreviews.value);
    if (next.has(key)) {
        next.delete(key);
    } else {
        next.add(key);
    }
    expandedPreviews.value = next;
};

const prettyJson = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};

const fmtMs = (ms) => {
    if (ms === null || ms === undefined) {
        return '-';
    }
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
};

/**
 * finish_reason 异常提示（v1.6.2）：stop/tool_calls 为正常结束不展示；
 * length=token 预算打满（推理模型思考占满配额即「返回空」元凶）、content_filter=上游审查。
 */
const finishReasonWarn = (reason) => {
    if (!reason || reason === 'stop' || reason === 'tool_calls') {
        return '';
    }
    if (reason === 'length') {
        return '⚠️ 截断：maxTokens 打满';
    }
    if (reason === 'content_filter') {
        return '⚠️ 内容审查拦截';
    }
    return `⚠️ finish: ${reason}`;
};

const statusLabel = (status) => {
    if (status === 'ok') {
        return '成功';
    }
    return status === 'running' ? '执行中' : '失败';
};
</script>

<template>
    <div
        class="trace-mask"
        @click="handleClose"
    />
    <aside class="trace-panel">
        <div class="trace-header">
            <h3>🔗 调用链路看板</h3>
            <button
                class="btn btn-icon"
                title="关闭"
                @click="handleClose"
            >
                ✕
            </button>
        </div>

        <div class="trace-body">
            <div
                v-if="isLoading"
                class="trace-empty"
            >
                加载中…
            </div>
            <div
                v-else-if="errorText"
                class="trace-empty is-error"
            >
                {{ errorText }}
            </div>
            <template v-else-if="trace">
                <!-- 总览 -->
                <div class="trace-summary">
                    <div class="summary-item">
                        <span class="summary-label">模型</span>
                        <span class="summary-value">{{ trace.model ?? '-' }}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">LLM 轮数</span>
                        <span class="summary-value">{{ trace.llmRounds ?? '-' }}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">总耗时</span>
                        <span class="summary-value">{{ fmtMs(trace.durationMs) }}</span>
                    </div>
                    <div
                        v-if="trace.usage"
                        class="summary-item"
                    >
                        <span class="summary-label">tokens</span>
                        <span class="summary-value">
                            {{ trace.usage.promptTokens ?? '-' }} 入 / {{ trace.usage.completionTokens ?? '-' }} 出
                        </span>
                    </div>
                    <div
                        v-if="trace.truncated"
                        class="summary-item"
                    >
                        <span class="tag tag-warn">达到轮数上限中止</span>
                    </div>
                </div>

                <!-- 逐轮链路 -->
                <div
                    v-for="round in trace.rounds ?? []"
                    :key="round.round"
                    class="trace-round"
                >
                    <div class="round-header">
                        <span class="round-badge">第 {{ round.round }} 轮</span>
                        <span class="round-stat">LLM {{ fmtMs(round.durationMs) }}</span>
                        <span class="round-stat">输入 {{ round.inputMessages }} 条消息</span>
                        <span
                            v-if="round.usage"
                            class="round-stat"
                        >
                            tokens {{ round.usage.promptTokens ?? '-' }}/{{ round.usage.completionTokens ?? '-' }}
                        </span>
                        <span
                            v-if="finishReasonWarn(round.finishReason)"
                            class="tag tag-warn"
                        >{{ finishReasonWarn(round.finishReason) }}</span>
                    </div>

                    <div
                        v-if="round.reasoning"
                        class="round-section"
                    >
                        <div class="section-title">💭 模型思考</div>
                        <pre class="section-pre is-reasoning">{{ round.reasoning }}</pre>
                    </div>

                    <div
                        v-if="round.content"
                        class="round-section"
                    >
                        <div class="section-title">📤 模型输出{{ round.toolCalls?.length ? '（附带工具调用）' : '（最终回答）' }}</div>
                        <pre class="section-pre">{{ round.content }}</pre>
                    </div>

                    <div
                        v-for="(call, callIndex) in round.toolCalls ?? []"
                        :key="callIndex"
                        class="round-section tool-call"
                    >
                        <div class="section-title">
                            🔧 {{ call.label }}
                            <code class="tool-name">{{ call.tool }}</code>
                            <span
                                class="tag"
                                :class="call.status === 'ok' ? 'tag-accent' : 'tag-warn'"
                            >{{ statusLabel(call.status) }}</span>
                            <span class="round-stat">{{ fmtMs(call.durationMs) }}</span>
                            <span
                                v-if="call.summary"
                                class="round-stat"
                            >· {{ call.summary }}</span>
                        </div>
                        <div class="kv-label">调用参数</div>
                        <pre class="section-pre is-args">{{ prettyJson(call.args) }}</pre>
                        <div class="kv-label">
                            返回结果（回填给模型，预览截断）
                            <button
                                class="link-btn"
                                @click="handleTogglePreview(`${round.round}-${callIndex}`)"
                            >
                                {{ expandedPreviews.has(`${round.round}-${callIndex}`) ? '收起' : '展开/收起原文' }}
                            </button>
                        </div>
                        <pre
                            v-show="expandedPreviews.has(`${round.round}-${callIndex}`)"
                            class="section-pre is-result"
                        >{{ call.resultPreview ?? '（无预览）' }}</pre>
                    </div>
                </div>
            </template>
            <div
                v-else
                class="trace-empty"
            >
                暂无调用链路数据
            </div>
        </div>
    </aside>
</template>

<style scoped>
.trace-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 40;
}

.trace-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(720px, 94vw);
    background: var(--panel);
    border-left: 1px solid var(--border);
    z-index: 41;
    display: flex;
    flex-direction: column;
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.35);
}

.trace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
}

.trace-header h3 {
    margin: 0;
    font-size: 15px;
}

.btn-icon {
    padding: 4px 10px;
    line-height: 1;
}

.trace-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.trace-empty {
    margin: auto;
    color: var(--muted);
    font-size: 13px;
}

.trace-empty.is-error {
    color: var(--up);
}

/* 总览 */
.trace-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 18px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel-2);
}

.summary-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
}

.summary-label {
    color: var(--muted);
}

.summary-value {
    color: var(--text-strong);
    font-family: var(--font-mono, monospace);
}

/* 轮次 */
.trace-round {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.round-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}

.round-badge {
    padding: 2px 10px;
    border-radius: 999px;
    background: rgba(79, 140, 255, 0.16);
    border: 1px solid rgba(79, 140, 255, 0.4);
    color: var(--text-strong);
    font-size: 12px;
    font-weight: 600;
}

.round-stat {
    color: var(--muted);
    font-size: 12px;
    font-family: var(--font-mono, monospace);
}

.round-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.section-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-strong);
}

.tool-name {
    font-size: 11.5px;
    color: var(--muted);
    background: var(--panel-2);
    padding: 1px 6px;
    border-radius: 4px;
}

.kv-label {
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 4px;
    display: flex;
    gap: 8px;
    align-items: center;
}

.link-btn {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 11.5px;
    cursor: pointer;
    padding: 0;
}

.section-pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
    color: var(--text);
}

.section-pre.is-reasoning {
    color: var(--muted);
    border-left: 3px solid rgba(255, 193, 94, 0.6);
}

.section-pre.is-args {
    border-left: 3px solid rgba(79, 140, 255, 0.6);
    font-family: var(--font-mono, monospace);
}

.section-pre.is-result {
    border-left: 3px solid rgba(52, 199, 123, 0.5);
    font-family: var(--font-mono, monospace);
    max-height: 320px;
}
</style>
