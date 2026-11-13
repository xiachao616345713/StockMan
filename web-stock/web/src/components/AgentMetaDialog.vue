<!--
  AgentMetaDialog Component（v1.5.0）

  展示 Agent 的系统提示词全文与可用工具清单（GET /api/agent/meta）：
  - 「系统提示词」页签：buildSystemPrompt() 实时生成的完整提示词（含当天日期）
  - 「可用工具」页签：13 个工具的名称/中文标签/类型（数据工具/历史工具）/描述/参数 schema

  Events:
  - close: 关闭对话框
-->
<script setup>
import { ref, onMounted } from 'vue';
import { apiGet } from '../api.js';

const emit = defineEmits(['close']);

/** @type {import('vue').Ref<{systemPrompt: string, maxRounds: number, tools: Array}|null>} */
const meta = ref(null);
const isLoading = ref(true);
const errorText = ref('');
const activeSection = ref('prompt');

const loadMeta = async () => {
    isLoading.value = true;
    try {
        const { data } = await apiGet('/api/agent/meta');
        meta.value = data;
    } catch (error) {
        errorText.value = error.message;
    } finally {
        isLoading.value = false;
    }
};

onMounted(loadMeta);

const handleClose = () => {
    emit('close');
};

const handleSectionClick = (section) => {
    activeSection.value = section;
};

const prettyJson = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
};
</script>

<template>
    <div
        class="meta-mask"
        @click="handleClose"
    />
    <div
        class="meta-dialog"
        role="dialog"
    >
        <div class="meta-header">
            <h3>📋 系统提示词与可用工具</h3>
            <button
                class="btn btn-icon"
                title="关闭"
                @click="handleClose"
            >
                ✕
            </button>
        </div>

        <div class="meta-tabs">
            <button
                class="meta-tab"
                :class="{ 'is-active': activeSection === 'prompt' }"
                @click="handleSectionClick('prompt')"
            >
                系统提示词
            </button>
            <button
                class="meta-tab"
                :class="{ 'is-active': activeSection === 'tools' }"
                @click="handleSectionClick('tools')"
            >
                可用工具<template v-if="meta"> ({{ meta.tools.length }})</template>
            </button>
        </div>

        <div class="meta-body">
            <div
                v-if="isLoading"
                class="meta-empty"
            >
                加载中…
            </div>
            <div
                v-else-if="errorText"
                class="meta-empty is-error"
            >
                {{ errorText }}
            </div>

            <template v-else-if="meta">
                <!-- 系统提示词全文 -->
                <pre
                    v-if="activeSection === 'prompt'"
                    class="prompt-pre"
                >{{ meta.systemPrompt }}</pre>

                <!-- 工具清单 -->
                <div
                    v-else
                    class="tool-list"
                >
                    <p class="tool-note">最大交互轮数：{{ meta.maxRounds }}（config.agent.maxRounds，设置页可改）</p>
                    <div
                        v-for="tool in meta.tools"
                        :key="tool.name"
                        class="tool-item"
                    >
                        <div class="tool-title">
                            🔧 {{ tool.label }}
                            <code class="tool-name">{{ tool.name }}</code>
                            <span
                                class="tag"
                                :class="tool.kind === 'history' ? 'tag-warn' : 'tag-accent'"
                            >{{ tool.kind === 'history' ? '历史归档' : '数据工具' }}</span>
                        </div>
                        <p class="tool-desc">{{ tool.description }}</p>
                        <details class="tool-params">
                            <summary>参数 schema</summary>
                            <pre class="params-pre">{{ prettyJson(tool.parameters) }}</pre>
                        </details>
                    </div>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.meta-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 50;
}

.meta-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(860px, 94vw);
    max-height: 86vh;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    z-index: 51;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
}

.meta-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
}

.meta-header h3 {
    margin: 0;
    font-size: 15px;
}

.btn-icon {
    padding: 4px 10px;
    line-height: 1;
}

.meta-tabs {
    display: flex;
    gap: 6px;
    padding: 10px 16px 0;
}

.meta-tab {
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    background: var(--panel-2);
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
}

.meta-tab.is-active {
    color: var(--text-strong);
    border-color: var(--accent);
    background: var(--panel);
}

.meta-body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    border-top: 1px solid var(--border);
}

.meta-empty {
    margin: 30px auto;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
}

.meta-empty.is-error {
    color: var(--up);
}

.prompt-pre {
    margin: 0;
    padding: 12px 14px;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
}

.tool-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.tool-note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
}

.tool-item {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    background: var(--panel-2);
}

.tool-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-strong);
}

.tool-name {
    font-size: 11.5px;
    color: var(--muted);
    background: var(--panel);
    padding: 1px 6px;
    border-radius: 4px;
}

.tool-desc {
    margin: 6px 0 0;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text);
}

.tool-params {
    margin-top: 8px;
    font-size: 12px;
}

.tool-params summary {
    cursor: pointer;
    color: var(--accent);
}

.params-pre {
    margin: 6px 0 0;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 11.5px;
    line-height: 1.5;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
}
</style>
