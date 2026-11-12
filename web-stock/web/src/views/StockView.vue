<script setup>
/**
 * StockView：个股查询。
 * - 搜索框（代码前缀 / 名称子串，300ms 防抖，基于后端全市场快照）
 * - 实时行情明细（最新价/涨跌/开高低收/量额/换手/振幅/市值/涨跌停价等）
 * - 日 K 线图（东财前复权，搜狐兜底；60/120/250/500 日切换）
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { apiGet } from '../api.js';
import { selectedCode } from '../store.js';
import KLineChart from '../components/KLineChart.vue';
import {
    fmtPrice,
    fmtPct,
    fmtSigned,
    fmtAmount,
    fmtVolume,
    fmtMarketValue,
    fmtRatio,
    fmtDate8,
    fmtClock,
    trendClass,
} from '../utils/format.js';

const DAY_OPTIONS = [60, 120, 250, 500];
const SEARCH_DEBOUNCE_MS = 300;

const searchKeyword = ref('');
const suggestions = ref([]);
const isSuggestionOpen = ref(false);
const isSearching = ref(false);

const quote = ref(null);
const klineData = ref(null);
const klineDays = ref(120);
const isLoadingQuote = ref(false);
const isLoadingKline = ref(false);
const errorMessage = ref('');

let searchTimer = null;
let searchBoxRef = null;

const currentCode = computed(() => quote.value?.code ?? '');

const quoteFields = computed(() => {
    const q = quote.value;
    if (!q) {
        return [];
    }
    return [
        { label: '开盘', value: fmtPrice(q.open), cls: trendClass(q.open !== null && q.preClose !== null ? q.open - q.preClose : null) },
        { label: '昨收', value: fmtPrice(q.preClose), cls: '' },
        { label: '最高', value: fmtPrice(q.high), cls: trendClass(q.high !== null && q.preClose !== null ? q.high - q.preClose : null) },
        { label: '最低', value: fmtPrice(q.low), cls: trendClass(q.low !== null && q.preClose !== null ? q.low - q.preClose : null) },
        { label: '均价', value: fmtPrice(q.avgPrice), cls: '' },
        { label: '涨停价', value: fmtPrice(q.ztPrice), cls: 'up' },
        { label: '跌停价', value: fmtPrice(q.dtPrice), cls: 'down' },
        { label: '成交量', value: fmtVolume(q.volume), cls: '' },
        { label: '成交额', value: fmtAmount(q.amount), cls: '' },
        { label: '换手率', value: q.turnover === null ? '-' : `${q.turnover}%`, cls: '' },
        { label: '振幅', value: q.amplitude === null ? '-' : `${q.amplitude}%`, cls: '' },
        { label: '总市值', value: fmtMarketValue(q.totalMv), cls: '' },
        { label: '流通市值', value: fmtMarketValue(q.circMv), cls: '' },
        { label: '市盈率TTM', value: fmtRatio(q.peTtm), cls: '' },
        { label: '市盈率动', value: fmtRatio(q.pe), cls: '' },
        { label: '市净率', value: fmtRatio(q.pb), cls: '' },
        { label: '量比', value: fmtRatio(q.volumeRatio), cls: '' },
        { label: '60日涨幅', value: fmtPct(q.pct60), cls: trendClass(q.pct60) },
        { label: '年初至今', value: fmtPct(q.pctYtd), cls: trendClass(q.pctYtd) },
        { label: '上市日期', value: fmtDate8(q.listDate), cls: '' },
        { label: '行情日期', value: fmtDate8(q.quoteDate), cls: '' },
    ];
});

const loadQuote = async (code) => {
    isLoadingQuote.value = true;
    try {
        const resp = await apiGet('/api/quote', { code });
        quote.value = resp.data;
        errorMessage.value = '';
    } catch (error) {
        quote.value = null;
        errorMessage.value = error.message;
    } finally {
        isLoadingQuote.value = false;
    }
};

const loadKline = async (code) => {
    isLoadingKline.value = true;
    try {
        const resp = await apiGet('/api/kline', { code, days: klineDays.value });
        klineData.value = resp.data;
    } catch (error) {
        klineData.value = null;
        console.error('加载K线失败:', error);
    } finally {
        isLoadingKline.value = false;
    }
};

const loadStock = (code) => {
    if (!/^\d{6}$/.test(code)) {
        return;
    }
    selectedCode.value = code;
    searchKeyword.value = '';
    suggestions.value = [];
    isSuggestionOpen.value = false;
    loadQuote(code);
    loadKline(code);
};

const runSearch = async () => {
    const kw = searchKeyword.value.trim();
    if (!kw) {
        suggestions.value = [];
        isSuggestionOpen.value = false;
        return;
    }
    isSearching.value = true;
    try {
        const resp = await apiGet('/api/search', { kw });
        suggestions.value = resp.data;
        isSuggestionOpen.value = true;
    } catch (error) {
        suggestions.value = [];
        console.error('搜索失败:', error);
    } finally {
        isSearching.value = false;
    }
};

const handleSearchInput = () => {
    if (searchTimer) {
        clearTimeout(searchTimer);
    }
    searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
};

const handleSearchKeydown = (event) => {
    if (event.key === 'Enter' && suggestions.value.length > 0) {
        loadStock(suggestions.value[0].code);
    }
    if (event.key === 'Escape') {
        isSuggestionOpen.value = false;
    }
};

const handleSuggestionClick = (code) => {
    loadStock(code);
};

const handleDaysChange = (days) => {
    klineDays.value = days;
    if (currentCode.value) {
        loadKline(currentCode.value);
    }
};

const handleRefresh = () => {
    if (currentCode.value) {
        loadQuote(currentCode.value);
        loadKline(currentCode.value);
    }
};

const handleClickOutside = (event) => {
    if (searchBoxRef && !searchBoxRef.contains(event.target)) {
        isSuggestionOpen.value = false;
    }
};

// 其他视图跳转过来时同步加载
watch(selectedCode, (code) => {
    if (code && code !== quote.value?.code) {
        loadStock(code);
    }
});

onMounted(() => {
    document.addEventListener('click', handleClickOutside);
    if (selectedCode.value) {
        loadStock(selectedCode.value);
    }
});

onUnmounted(() => {
    document.removeEventListener('click', handleClickOutside);
    if (searchTimer) {
        clearTimeout(searchTimer);
    }
});
</script>

<template>
    <div class="stock-view">
        <!-- 搜索框 -->
        <div
            ref="searchBoxRef"
            class="search-box"
        >
            <input
                v-model="searchKeyword"
                class="input search-input"
                type="text"
                placeholder="输入股票代码或名称，如 600000 / 浦发银行（回车直达第一个结果）"
                autocomplete="off"
                @input="handleSearchInput"
                @keydown="handleSearchKeydown"
                @focus="isSuggestionOpen = suggestions.length > 0"
            >
            <span
                v-if="isSearching"
                class="loading-spinner search-spinner"
            />
            <ul
                v-if="isSuggestionOpen && suggestions.length > 0"
                class="suggestion-list"
            >
                <li
                    v-for="item in suggestions"
                    :key="item.code"
                    class="suggestion-item"
                    @click="handleSuggestionClick(item.code)"
                >
                    <span class="cell-code">{{ item.code }}</span>
                    <span class="cell-name">{{ item.name }}</span>
                    <span
                        class="num"
                        :class="trendClass(item.pct)"
                    >{{ fmtPrice(item.price) }}</span>
                    <span
                        class="num"
                        :class="trendClass(item.pct)"
                    >{{ fmtPct(item.pct) }}</span>
                </li>
            </ul>
            <div
                v-else-if="isSuggestionOpen && searchKeyword.trim()"
                class="suggestion-empty"
            >
                无匹配结果
            </div>
        </div>

        <!-- 未选择股票 -->
        <div
            v-if="!quote && !isLoadingQuote"
            class="panel state-box"
        >
            <p v-if="errorMessage">
                {{ errorMessage }}
            </p>
            <p v-else>
                请搜索并选择一只股票查看实时行情与日 K 线
            </p>
        </div>
        <div
            v-if="isLoadingQuote && !quote"
            class="panel state-box"
        >
            <span class="loading-spinner" />加载行情中…
        </div>

        <template v-if="quote">
            <!-- 行情头部 -->
            <div class="panel quote-head">
                <div class="quote-title">
                    <h2>{{ quote.name }}</h2>
                    <span class="cell-code">{{ quote.code }}</span>
                    <span class="tag tag-accent">{{ quote.board }}</span>
                    <span
                        v-if="quote.price === null"
                        class="tag tag-warn"
                    >停牌</span>
                    <span
                        v-else-if="quote.ztPrice !== null && quote.price >= quote.ztPrice"
                        class="tag tag-up"
                    >涨停</span>
                    <span
                        v-else-if="quote.dtPrice !== null && quote.price <= quote.dtPrice"
                        class="tag tag-down"
                    >跌停</span>
                </div>
                <div class="quote-price-row">
                    <span
                        class="quote-price num"
                        :class="trendClass(quote.pct)"
                    >{{ fmtPrice(quote.price) }}</span>
                    <span
                        class="quote-change num"
                        :class="trendClass(quote.pct)"
                    >
                        {{ fmtSigned(quote.change) }}&nbsp;&nbsp;{{ fmtPct(quote.pct) }}
                    </span>
                </div>
                <div class="quote-grid">
                    <div
                        v-for="field in quoteFields"
                        :key="field.label"
                        class="quote-field"
                    >
                        <span class="field-label">{{ field.label }}</span>
                        <span
                            class="field-value num"
                            :class="field.cls"
                        >{{ field.value }}</span>
                    </div>
                </div>
                <div class="meta-line quote-meta">
                    <span v-if="isLoadingQuote"><span class="loading-spinner" />刷新中</span>
                    <button
                        class="btn"
                        :disabled="isLoadingQuote"
                        @click="handleRefresh"
                    >
                        刷新行情
                    </button>
                </div>
            </div>

            <!-- 日 K 线 -->
            <div class="panel">
                <div class="panel-title">
                    <h2>
                        日 K 线
                        <span class="sub">前复权 · {{ klineData?.klines?.length ?? 0 }} 个交易日</span>
                    </h2>
                    <div class="panel-title-right">
                        <span
                            v-if="klineData"
                            class="tag"
                        >{{ klineData.source === 'sohu:hisHq' ? '数据源: 搜狐(兜底)' : '数据源: 东财' }}</span>
                        <div class="btn-group">
                            <button
                                v-for="days in DAY_OPTIONS"
                                :key="days"
                                class="btn"
                                :class="{ 'is-active': klineDays === days }"
                                @click="handleDaysChange(days)"
                            >
                                {{ days }}日
                            </button>
                        </div>
                    </div>
                </div>
                <div
                    v-if="isLoadingKline"
                    class="state-box"
                >
                    <span class="loading-spinner" />加载 K 线…
                </div>
                <KLineChart
                    v-else
                    :klines="klineData?.klines ?? []"
                    :stock-name="quote.name"
                    :stock-code="quote.code"
                />
            </div>
        </template>
    </div>
</template>

<style scoped>
.stock-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.search-box {
    position: relative;
}

.search-input {
    width: 100%;
    padding: 12px 40px 12px 16px;
    font-size: 15px;
}

.search-spinner {
    position: absolute;
    right: 14px;
    top: 50%;
    margin-top: -7px;
}

.suggestion-list {
    position: absolute;
    z-index: 50;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    max-height: 360px;
    overflow-y: auto;
    list-style: none;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.suggestion-item {
    display: grid;
    grid-template-columns: 90px 1fr 90px 90px;
    gap: 8px;
    align-items: center;
    padding: 9px 14px;
    cursor: pointer;
    font-size: 13px;
}

.suggestion-item:hover {
    background: rgba(79, 140, 255, 0.1);
}

.suggestion-item .num {
    text-align: right;
}

.suggestion-empty {
    position: absolute;
    z-index: 50;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    padding: 14px;
    text-align: center;
    color: var(--muted);
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
}

.quote-title {
    display: flex;
    align-items: center;
    gap: 10px;
}

.quote-title h2 {
    font-size: 20px;
    color: var(--text-strong);
}

.quote-price-row {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin: 8px 0 14px;
}

.quote-price {
    font-size: 34px;
    font-weight: 700;
}

.quote-change {
    font-size: 16px;
}

.quote-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
}

.quote-field {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 13px;
}

.field-label {
    color: var(--muted);
}

.field-value {
    color: var(--text-strong);
}

.quote-meta {
    margin-top: 12px;
}

.panel-title-right {
    display: flex;
    align-items: center;
    gap: 10px;
}
</style>
