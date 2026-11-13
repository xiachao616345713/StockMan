<script setup>
/**
 * SettingsView：系统设置（v1.4.0）。
 *
 * 读写后端配置中心（GET/PUT /api/config），配置持久化在 server/data/config.db（node:sqlite，
 * 旧 Node 自动回退 JSON），改完即时热生效（服务端口除外，需重启）。决策见 docs/design.md D16。
 *
 * 密钥安全：llm.accessToken 永不下发前端，GET 仅返回 accessTokenSet 布尔；
 * 保存时遵循「缺省=保持不变 / 空串=清除 / 非空=设置」语义（token 用独立 tokenDraft，不与表单其他字段耦合）。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiGet, apiPut } from '../api.js';

/** 采集类型开关的展示标签（键顺序即展示顺序） */
const COLLECTION_TYPES = [
    { key: 'limitup', label: '涨停池' },
    { key: 'ladder', label: '连板天梯' },
    { key: 'hotrank', label: '人气热榜' },
    { key: 'dragontiger', label: '龙虎榜' },
];

/** 缓存 TTL 表格行（键 → 中文名，与 config.js CACHE_KEYS 一致） */
const CACHE_LABELS = [
    { key: 'snapshot', label: '全市场快照' },
    { key: 'indices', label: '三大指数' },
    { key: 'kline', label: '个股 K 线' },
    { key: 'sectors', label: '板块行情' },
    { key: 'bkstocks', label: '板块成份股' },
    { key: 'limitup', label: '涨停池 / 复盘' },
    { key: 'ladder', label: '连板天梯' },
    { key: 'related', label: '涨停关联性' },
    { key: 'dragontiger', label: '龙虎榜' },
    { key: 'hotrank', label: '人气热榜' },
];

/** @type {import('vue').Ref<Record<string, any>>} 表单（GET 返回的脱敏配置副本） */
const form = ref({});
const storeBackend = ref('');
const isLoading = ref(true);
const isSaving = ref(false);
const isSuccess = ref(false);
const errorMessage = ref('');

/** 密钥输入独立于表单：留空且未勾选清除 → 保存时不提交该字段（保持服务端已存值） */
const tokenDraft = ref('');
const isClearToken = ref(false);

/** 服务端是否已存 Token（来自 GET 的 accessTokenSet 派生字段） */
const hasStoredToken = computed(() => form.value?.llm?.accessTokenSet === true);

let successTimer = null;

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const loadConfig = async () => {
    isLoading.value = true;
    errorMessage.value = '';
    isSuccess.value = false;
    try {
        const resp = await apiGet('/api/config');
        form.value = resp.data;
        storeBackend.value = resp.meta?.store?.backend ?? '';
        tokenDraft.value = '';
        isClearToken.value = false;
    } catch (error) {
        errorMessage.value = error.message;
    } finally {
        isLoading.value = false;
    }
};

/** 组装 PUT 请求体：剥离派生只读字段，按密钥语义决定是否携带 accessToken */
const buildPayload = () => {
    const payload = deepClone(form.value);
    if (payload.llm) {
        delete payload.llm.accessTokenSet; // 派生只读，服务端写入时忽略，前端主动剥离更干净
        if (isClearToken.value) {
            payload.llm.accessToken = ''; // 显式清除
        } else if (tokenDraft.value.trim()) {
            payload.llm.accessToken = tokenDraft.value.trim(); // 设置新值
        }
        // 否则不携带 accessToken 字段 → 服务端保持已存值不变
    }
    return payload;
};

const handleSave = async () => {
    isSaving.value = true;
    errorMessage.value = '';
    isSuccess.value = false;
    try {
        const resp = await apiPut('/api/config', buildPayload());
        form.value = resp.data; // 回填服务端归一化后的值（脱敏）
        tokenDraft.value = '';
        isClearToken.value = false;
        isSuccess.value = true;
        if (successTimer) {
            clearTimeout(successTimer);
        }
        successTimer = setTimeout(() => {
            isSuccess.value = false;
        }, 4000);
    } catch (error) {
        errorMessage.value = error.message;
    } finally {
        isSaving.value = false;
    }
};

/** 重置 = 丢弃本地改动，重新从服务端拉取 */
const handleReset = () => {
    loadConfig();
};

onMounted(loadConfig);

onUnmounted(() => {
    if (successTimer) {
        clearTimeout(successTimer);
    }
});
</script>

<template>
    <div class="settings-view">
        <!-- 顶部操作条 -->
        <div class="panel action-bar">
            <div class="action-left">
                <h2 class="action-title">系统设置</h2>
                <span class="sub">
                    配置存储于服务端数据库<span
                        v-if="storeBackend"
                        class="tag tag-accent store-tag"
                    >{{ storeBackend }}</span>
                    · 改动即时生效（服务端口需重启）
                </span>
            </div>
            <div class="btn-group">
                <button
                    class="btn"
                    :disabled="isLoading || isSaving"
                    @click="handleReset"
                >
                    重置
                </button>
                <button
                    class="btn btn-primary"
                    :disabled="isLoading || isSaving"
                    @click="handleSave"
                >
                    {{ isSaving ? '保存中…' : '保存' }}
                </button>
            </div>
        </div>

        <div
            v-if="isSuccess"
            class="banner banner-success"
        >
            ✓ 配置已保存并生效
        </div>
        <div
            v-if="errorMessage"
            class="banner banner-error"
        >
            保存失败：{{ errorMessage }}
        </div>

        <div
            v-if="isLoading"
            class="state-box"
        >
            <span class="loading-spinner" />加载配置…
        </div>

        <template v-else-if="form.collection">
            <!-- 数据采集 -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        数据采集
                        <span class="sub">后台归档采集器（涨停池 / 天梯 / 热榜 / 龙虎榜），改后热重排定时器</span>
                    </h2>
                    <label class="check-item">
                        <input
                            v-model="form.collection.enabled"
                            type="checkbox"
                        >
                        启用采集
                    </label>
                </div>
                <div class="field-grid">
                    <label class="field">
                        <span class="field-name">采集周期 (分)</span>
                        <input
                            v-model.number="form.collection.intervalMinutes"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="1440"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">首跑延时 (秒)</span>
                        <input
                            v-model.number="form.collection.initialDelaySeconds"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="600"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">龙虎榜采集时点 (≥ 时)</span>
                        <input
                            v-model.number="form.collection.dragonTigerAfterHour"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="23"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">归档重写间隔 (分)</span>
                        <input
                            v-model.number="form.collection.rewriteIntervalMinutes"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="1440"
                        >
                    </label>
                </div>
                <div class="check-row">
                    <span class="field-name">采集类型</span>
                    <label
                        v-for="type in COLLECTION_TYPES"
                        :key="type.key"
                        class="check-item"
                    >
                        <input
                            v-model="form.collection.types[type.key]"
                            type="checkbox"
                        >
                        {{ type.label }}
                    </label>
                </div>
            </section>

            <!-- AI 模型 -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        AI 模型
                        <span class="sub">OpenAI 兼容端点（function calling），供 AI 选股助手使用</span>
                    </h2>
                    <label class="check-item">
                        <input
                            v-model="form.llm.enabled"
                            type="checkbox"
                        >
                        启用 LLM
                    </label>
                </div>
                <div class="field-grid">
                    <label class="field field-wide">
                        <span class="field-name">模型地址 (modelUrl)</span>
                        <input
                            v-model="form.llm.modelUrl"
                            class="input text-input"
                            type="text"
                            placeholder="https://api.example.com/v1（自动补全 /chat/completions）"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">模型名 (model)</span>
                        <input
                            v-model="form.llm.model"
                            class="input text-input"
                            type="text"
                            placeholder="如 deepseek-chat"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">超时 (毫秒)</span>
                        <input
                            v-model.number="form.llm.timeoutMs"
                            class="input num-input"
                            type="number"
                            min="5000"
                            max="600000"
                            step="1000"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">temperature</span>
                        <input
                            v-model.number="form.llm.temperature"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="2"
                            step="0.1"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">maxTokens</span>
                        <input
                            v-model.number="form.llm.maxTokens"
                            class="input num-input"
                            type="number"
                            min="256"
                            max="32768"
                            step="256"
                        >
                    </label>
                </div>
                <div class="token-block">
                    <label class="field field-wide">
                        <span class="field-name">Access Token</span>
                        <input
                            v-model="tokenDraft"
                            class="input text-input"
                            type="password"
                            autocomplete="new-password"
                            :placeholder="hasStoredToken ? '已配置（留空保持不变）' : 'sk-...（密钥，保存后不回显）'"
                        >
                    </label>
                    <div class="token-actions">
                        <span
                            v-if="hasStoredToken"
                            class="tag tag-warn"
                        >服务端已存 Token</span>
                        <span
                            v-else
                            class="tag"
                        >未配置 Token</span>
                        <label
                            v-if="hasStoredToken"
                            class="check-item"
                        >
                            <input
                                v-model="isClearToken"
                                type="checkbox"
                            >
                            清除已存 Token
                        </label>
                    </div>
                    <p class="hint">
                        密钥仅存于服务端数据库，接口与页面均不回显原文；留空保存表示保持不变。
                    </p>
                </div>
            </section>

            <!-- Agent 对话 -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        Agent 对话上限
                        <span class="sub">防止 prompt 无限膨胀与工具死循环</span>
                    </h2>
                </div>
                <div class="field-grid">
                    <label class="field">
                        <span class="field-name">最大工具轮数</span>
                        <input
                            v-model.number="form.agent.maxRounds"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="20"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">历史消息上限 (条)</span>
                        <input
                            v-model.number="form.agent.maxMessages"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="200"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">单条内容上限 (字)</span>
                        <input
                            v-model.number="form.agent.maxContent"
                            class="input num-input"
                            type="number"
                            min="100"
                            max="100000"
                            step="100"
                        >
                    </label>
                </div>
            </section>

            <!-- 缓存 TTL -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        缓存 TTL
                        <span class="sub">各接口按交易时段选择的缓存时长（秒）：交易 5–7200 / 收盘 5–86400；收盘缓存最晚在下一交易日开盘时失效</span>
                    </h2>
                </div>
                <div class="table-wrap">
                    <table class="ttl-table">
                        <thead>
                            <tr>
                                <th>缓存项</th>
                                <th>交易时段 (秒)</th>
                                <th>收盘 (秒)</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="item in CACHE_LABELS"
                                :key="item.key"
                            >
                                <td>
                                    <span class="cell-name">{{ item.label }}</span>
                                    <span class="cell-code ttl-key">{{ item.key }}</span>
                                </td>
                                <td>
                                    <input
                                        v-model.number="form.cache[item.key].trading"
                                        class="input num-input"
                                        type="number"
                                        min="5"
                                        max="7200"
                                    >
                                </td>
                                <td>
                                    <input
                                        v-model.number="form.cache[item.key].closed"
                                        class="input num-input"
                                        type="number"
                                        min="5"
                                        max="86400"
                                    >
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <!-- 服务 -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        服务
                        <span class="sub">监听端口与交易时段窗口（影响缓存 TTL 与采集判断）</span>
                    </h2>
                </div>
                <div class="field-grid">
                    <label class="field">
                        <span class="field-name">服务端口</span>
                        <input
                            v-model.number="form.server.port"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="65535"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">交易开始 (HH:MM)</span>
                        <input
                            v-model="form.server.tradingStart"
                            class="input text-input time-input"
                            type="text"
                            placeholder="09:15"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">交易结束 (HH:MM)</span>
                        <input
                            v-model="form.server.tradingEnd"
                            class="input text-input time-input"
                            type="text"
                            placeholder="15:05"
                        >
                    </label>
                </div>
                <p class="hint">
                    端口修改后需重启服务进程方可生效（若以 PORT 环境变量启动，则环境变量优先）。
                </p>
            </section>

            <!-- 上游 HTTP -->
            <section class="panel">
                <div class="panel-title">
                    <h2>
                        上游 HTTP
                        <span class="sub">行情上游请求的超时、重试与调用频率限制（对全部数据源均匀生效）</span>
                    </h2>
                </div>
                <div class="field-grid">
                    <label class="field">
                        <span class="field-name">超时 (毫秒)</span>
                        <input
                            v-model.number="form.http.timeoutMs"
                            class="input num-input"
                            type="number"
                            min="1000"
                            max="120000"
                            step="500"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">重试次数</span>
                        <input
                            v-model.number="form.http.retries"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="5"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">重试退避基数 (毫秒)</span>
                        <input
                            v-model.number="form.http.retryBackoffMs"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="10000"
                            step="50"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">最小请求间隔 (毫秒)</span>
                        <input
                            v-model.number="form.http.minIntervalMs"
                            class="input num-input"
                            type="number"
                            min="0"
                            max="10000"
                            step="10"
                        >
                    </label>
                    <label class="field">
                        <span class="field-name">单主机最大并发</span>
                        <input
                            v-model.number="form.http.maxConcurrent"
                            class="input num-input"
                            type="number"
                            min="1"
                            max="32"
                        >
                    </label>
                </div>
                <p class="hint">
                    频率限制按「上游主机」维度生效：同一主机相邻两次请求的启动间隔不低于「最小请求间隔」，
                    同时在途请求数不超过「单主机最大并发」。上游出现空数据/拒绝连接（疑似限流）时可适当调大间隔、调小并发；
                    调大后全市场快照刷新会变慢（约 60 页分页拉取），请结合快照缓存 TTL 权衡。
                </p>
            </section>
        </template>
    </div>
</template>

<style scoped>
.settings-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

/* 顶部操作条 */
.action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    position: sticky;
    top: 56px;
    z-index: 50;
    background: var(--panel);
}

.action-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.action-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
}

.action-bar .sub {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.store-tag {
    text-transform: uppercase;
}

/* 提示横幅 */
.banner {
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 13px;
    border: 1px solid var(--border);
}

.banner-success {
    color: var(--down);
    border-color: rgba(46, 189, 133, 0.4);
    background: rgba(46, 189, 133, 0.08);
}

.banner-error {
    color: var(--up);
    border-color: rgba(246, 70, 93, 0.4);
    background: rgba(246, 70, 93, 0.08);
}

/* 字段网格 */
.field-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px 18px;
    padding: 4px 0;
}

.field {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
}

.field-wide {
    grid-column: 1 / -1;
}

.field-name {
    width: 130px;
    color: var(--muted);
    flex-shrink: 0;
}

.num-input {
    width: 110px;
    padding: 6px 10px;
}

.text-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
}

.time-input {
    width: 90px;
    flex: none;
    font-family: var(--font-mono);
}

/* 勾选行 */
.check-row {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding: 8px 0 2px;
    border-top: 1px solid var(--border);
    margin-top: 6px;
}

.check-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    cursor: pointer;
    color: var(--text);
}

/* 密钥块 */
.token-block {
    border-top: 1px solid var(--border);
    margin-top: 6px;
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.token-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-left: 138px;
}

.hint {
    font-size: 12px;
    color: var(--muted);
    padding-left: 138px;
}

/* 缓存 TTL 表 */
.ttl-table {
    width: 100%;
    border-collapse: collapse;
}

.ttl-table th {
    padding: 8px 10px;
    text-align: left;
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
}

.ttl-table td {
    padding: 6px 10px;
    text-align: left;
    border-bottom: 1px solid rgba(35, 42, 56, 0.5);
    font-size: 13px;
}

.ttl-key {
    margin-left: 8px;
}

.btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}

.btn-primary:hover {
    filter: brightness(1.1);
}

@media (max-width: 640px) {
    .field-name {
        width: 104px;
    }

    .token-actions,
    .hint {
        padding-left: 0;
    }
}
</style>
