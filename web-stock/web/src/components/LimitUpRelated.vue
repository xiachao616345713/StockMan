<script setup>
/**
 * LimitUpRelated：涨停关联性分析。
 * - 目标股票须在当日涨停池（可从涨停池「关联」按钮带入，也可搜索/手输代码）
 * - 题材关联：涨停复盘（block_top）中包含该股票的分组，同组即同题材
 * - 共同涨停：近 N 个交易日（默认 10）历史涨停池回看，统计与目标同日涨停的股票
 *
 * 数据来自 /api/limitup/related（后端复用涨停池缓存，单日失败容忍）。
 */
import { ref, computed, watch } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, trendClass } from '../utils/format.js';

const props = defineProps({
    /** 交易日 yyyyMMdd */
    date: {
        type: String,
        required: true,
    },
    /** 外部带入的股票代码（涨停池「关联」按钮） */
    initialCode: {
        type: String,
        default: '',
    },
});

const WINDOW_OPTIONS = [5, 10, 20];

const targetCode = ref(props.initialCode);
const windowDays = ref(10);
const relatedData = ref(null);
const isLoading = ref(false);
const errorMessage = ref('');

const keyword = ref('');
const suggestions = ref([]);
const isSuggestOpen = ref(false);

let debounceTimer = null;

const target = computed(() => relatedData.value?.target ?? null);
const themes = computed(() => relatedData.value?.themes ?? null);
const coLimit = computed(() => relatedData.value?.coLimit ?? []);
const targetLimitUpDays = computed(() => relatedData.value?.targetLimitUpDays ?? []);

/** yyyyMMdd → MM-dd */
const shortDate = (date8) => `${String(date8).slice(4, 6)}-${String(date8).slice(6, 8)}`;

const loadData = async () => {
    const code = targetCode.value.trim();
    if (!code || !props.date) {
        return;
    }
    isLoading.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/limitup/related', {
            code,
            date: props.date,
            days: windowDays.value,
        });
        relatedData.value = resp.data;
    } catch (error) {
        errorMessage.value = error.message;
        relatedData.value = null;
    } finally {
        isLoading.value = false;
    }
};

const handleSelectCode = (code) => {
    targetCode.value = code;
    isSuggestOpen.value = false;
    suggestions.value = [];
    keyword.value = '';
    loadData();
};

const handleSubmit = () => {
    // 允许直接输入 6 位代码回车
    if (/^\d{6}$/.test(targetCode.value.trim())) {
        loadData();
    } else if (/^\d{6}$/.test(keyword.value.trim())) {
        handleSelectCode(keyword.value.trim());
    } else {
        // 非纯代码时从建议里挑第一个
        const first = suggestions.value[0];
        if (first) {
            handleSelectCode(first.code);
        }
    }
};

const handleWindow = (days) => {
    windowDays.value = days;
    loadData();
};

const handleStockClick = (code) => {
    openStock(code);
};

// 搜索联想（300ms 防抖）
watch(keyword, (value) => {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    const kw = value.trim();
    if (!kw) {
        suggestions.value = [];
        isSuggestOpen.value = false;
        return;
    }
    debounceTimer = setTimeout(async () => {
        try {
            const resp = await apiGet('/api/search', { kw });
            suggestions.value = resp.data.slice(0, 8);
            isSuggestOpen.value = suggestions.value.length > 0;
        } catch {
            suggestions.value = [];
            isSuggestOpen.value = false;
        }
    }, 300);
});

// 外部带入代码（涨停池「关联」按钮）→ 立即查询
watch(
    () => props.initialCode,
    (code) => {
        if (code && code !== targetCode.value) {
            targetCode.value = code;
            loadData();
        }
    },
);

// 日期变化 / 首次挂载：有代码就查询（initialCode 带入时挂载即触发）
watch(
    () => props.date,
    () => {
        if (targetCode.value.trim()) {
            loadData();
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="related">
        <div class="toolbar">
            <div class="search-box">
                <input
                    v-model="keyword"
                    class="input"
                    type="text"
                    placeholder="搜索股票（名称/代码，须在当日涨停池）"
                    @focus="isSuggestOpen = suggestions.length > 0"
                    @keydown.enter="handleSubmit"
                >
                <div
                    v-if="isSuggestOpen"
                    class="suggest-list"
                >
                    <button
                        v-for="item in suggestions"
                        :key="item.code"
                        class="suggest-item"
                        @click="handleSelectCode(item.code)"
                    >
                        <span class="cell-code">{{ item.code }}</span>
                        <span class="cell-name">{{ item.name }}</span>
                        <span
                            class="num"
                            :class="trendClass(item.pct)"
                        >{{ fmtPct(item.pct) }}</span>
                    </button>
                </div>
            </div>
            <input
                v-model="targetCode"
                class="input code-input"
                type="text"
                maxlength="6"
                placeholder="代码"
                @keydown.enter="handleSubmit"
            >
            <button
                class="btn"
                :disabled="isLoading"
                @click="handleSubmit"
            >
                分析
            </button>
            <div class="btn-group">
                <button
                    v-for="option in WINDOW_OPTIONS"
                    :key="option"
                    class="btn"
                    :class="{ 'is-active': windowDays === option }"
                    @click="handleWindow(option)"
                >
                    近{{ option }}日
                </button>
            </div>
        </div>

        <div
            v-if="isLoading"
            class="state-box"
        >
            <span class="loading-spinner" />分析中（需回看历史涨停池，首次约需数秒）…
        </div>
        <div
            v-else-if="errorMessage"
            class="state-box error"
        >
            {{ errorMessage }}
        </div>
        <div
            v-else-if="!relatedData"
            class="state-box"
        >
            选择一只当日涨停的股票，查看它的题材关联与近 {{ windowDays }} 个交易日的共同涨停统计
        </div>

        <template v-else-if="target">
            <!-- 目标股票卡片 -->
            <div class="target-card">
                <div class="target-head">
                    <span class="cell-code">{{ target.code }}</span>
                    <span class="target-name">{{ target.name }}</span>
                    <span class="tag tag-up">{{ target.highDays ?? '首板' }}</span>
                    <span class="num">{{ fmtPrice(target.price) }}</span>
                    <span
                        class="num"
                        :class="trendClass(target.pct)"
                    >{{ fmtPct(target.pct) }}</span>
                    <span
                        v-if="target.firstLimitUpTime"
                        class="muted"
                    >首封 {{ target.firstLimitUpTime }}</span>
                </div>
                <div class="target-reason">
                    涨停原因：{{ target.reasonType ?? '-' }}
                </div>
                <div class="target-days">
                    <span class="muted">窗口内涨停日：</span>
                    <span
                        v-for="day in targetLimitUpDays"
                        :key="day"
                        class="tag tag-accent day-chip"
                    >{{ shortDate(day) }}</span>
                </div>
            </div>

            <!-- 题材关联 -->
            <div class="section">
                <div class="section-title">题材关联（涨停复盘同组）</div>
                <div
                    v-if="themes === null"
                    class="muted small"
                >
                    涨停复盘数据不可用，题材关联暂缺
                </div>
                <div
                    v-else-if="themes.length === 0"
                    class="muted small"
                >
                    该股未出现在涨停复盘分组中
                </div>
                <div
                    v-else
                    class="theme-list"
                >
                    <div
                        v-for="group in themes"
                        :key="group.code"
                        class="theme-item"
                    >
                        <div class="theme-head">
                            <b>{{ group.name }}</b>
                            <span class="muted">{{ group.limitUpNum }}只涨停</span>
                            <span
                                v-if="group.days"
                                class="muted"
                            >持续{{ group.days }}天</span>
                        </div>
                        <div class="theme-stocks">
                            <button
                                v-for="stock in group.stocks"
                                :key="stock.code"
                                class="stock-chip"
                                :class="{ 'is-target': stock.code === target.code }"
                                :title="`${stock.code} ${stock.highDays ?? ''} ${stock.reasonType ?? ''}`"
                                @click="handleStockClick(stock.code)"
                            >
                                {{ stock.name }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 共同涨停 -->
            <div class="section">
                <div class="section-title">
                    共同涨停统计
                    <span class="muted small">近 {{ relatedData.windowDays }} 个交易日，与目标同日涨停的次数</span>
                </div>
                <div
                    v-if="coLimit.length === 0"
                    class="muted small"
                >
                    窗口内目标股票没有历史涨停记录（或无共同涨停股票）
                </div>
                <div
                    v-else
                    class="table-wrap co-table-wrap"
                >
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>代码 / 名称</th>
                                <th>共同涨停</th>
                                <th>日期</th>
                                <th>几天几板</th>
                                <th>今日在池</th>
                                <th class="reason-col">涨停原因</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="item in coLimit"
                                :key="item.code"
                                class="is-clickable"
                                @click="handleStockClick(item.code)"
                            >
                                <td>
                                    <span class="cell-code">{{ item.code }}</span>
                                    <span class="cell-name">&nbsp;{{ item.name }}</span>
                                </td>
                                <td class="num">
                                    <b :class="item.count >= 2 ? 'up' : ''">{{ item.count }}</b> 次
                                </td>
                                <td class="dates-cell">
                                    <span
                                        v-for="day in item.dates"
                                        :key="day"
                                        class="tag day-chip"
                                    >{{ shortDate(day) }}</span>
                                </td>
                                <td>{{ item.highDays ?? '-' }}</td>
                                <td>
                                    <span
                                        v-if="item.inTodayPool"
                                        class="tag tag-up"
                                    >是</span>
                                    <span
                                        v-else
                                        class="muted"
                                    >-</span>
                                </td>
                                <td
                                    class="reason-col ellipsis"
                                    :title="item.reasonType"
                                >{{ item.reasonType ?? '-' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </template>
    </div>
</template>

<style scoped>
.toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 14px;
}

.search-box {
    position: relative;
    flex: 1;
    min-width: 220px;
    max-width: 340px;
}

.search-box .input {
    width: 100%;
}

.code-input {
    width: 90px;
}

.suggest-list {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 30;
    background: var(--panel, #1b2030);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    overflow: hidden;
}

.suggest-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    color: var(--text-strong);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
}

.suggest-item:hover {
    background: rgba(255, 255, 255, 0.06);
}

.target-card {
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-soft, rgba(255, 255, 255, 0.03));
    margin-bottom: 16px;
}

.target-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 14px;
}

.target-name {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
}

.target-reason {
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
}

.target-days {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 12px;
}

.section {
    margin-bottom: 18px;
}

.section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 8px;
    display: flex;
    align-items: baseline;
    gap: 8px;
}

.theme-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.theme-item {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
}

.theme-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 13px;
    margin-bottom: 8px;
    color: var(--text-strong);
}

.theme-stocks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.stock-chip {
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-strong);
    font-size: 12px;
    cursor: pointer;
}

.stock-chip:hover {
    border-color: var(--accent);
}

.stock-chip.is-target {
    border-color: var(--up);
    color: var(--up);
    font-weight: 700;
}

.day-chip {
    margin: 1px 3px 1px 0;
    font-variant-numeric: tabular-nums;
}

.co-table-wrap {
    max-height: 50vh;
    overflow-y: auto;
}

.dates-cell {
    text-align: left !important;
    white-space: normal !important;
    max-width: 220px;
}

.reason-col {
    max-width: 260px;
}

.ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
}

.muted {
    color: var(--muted);
}

.small {
    font-size: 12px;
    font-weight: 400;
}
</style>
