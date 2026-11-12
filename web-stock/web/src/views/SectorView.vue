<script setup>
/**
 * SectorView：板块排行。
 * - 行业板块 / 概念板块切换（东财 clist m:90+t:2 / t:3）
 * - 表格按涨跌幅/换手率/振幅/总市值排序，默认涨跌幅降序
 * - 点击板块行展开成份股列表（fs=b:BKxxxx），成份股可跳转个股页
 */
import { ref, computed, onMounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, fmtMarketValue, fmtClock, trendClass } from '../utils/format.js';

const TYPE_OPTIONS = [
    { key: 'industry', label: '行业板块' },
    { key: 'concept', label: '概念板块' },
];

const SORT_COLUMNS = [
    { key: 'pct', label: '涨跌幅' },
    { key: 'turnover', label: '换手率' },
    { key: 'amplitude', label: '振幅' },
    { key: 'totalMv', label: '总市值' },
];

const sectorType = ref('industry');
const sectors = ref([]);
const isLoading = ref(false);
const errorMessage = ref('');
const lastUpdated = ref('');
const meta = ref(null);

const sortKey = ref('pct');
const isSortDesc = ref(true);

const selectedBk = ref(null); // { code, name }
const bkStocks = ref([]);
const isLoadingBkStocks = ref(false);

const sortedSectors = computed(() => {
    const key = sortKey.value;
    const factor = isSortDesc.value ? -1 : 1;
    return [...sectors.value].sort((a, b) => {
        const av = a[key] ?? -Infinity;
        const bv = b[key] ?? -Infinity;
        return (av - bv) * factor;
    });
});

const loadSectors = async () => {
    isLoading.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/sectors', { type: sectorType.value });
        sectors.value = resp.data;
        meta.value = resp.meta;
        lastUpdated.value = fmtClock(resp.meta?.fetchedAt);
    } catch (error) {
        errorMessage.value = error.message;
        sectors.value = [];
    } finally {
        isLoading.value = false;
    }
};

const handleTypeChange = (type) => {
    if (sectorType.value === type) {
        return;
    }
    sectorType.value = type;
    selectedBk.value = null;
    bkStocks.value = [];
    loadSectors();
};

const handleSort = (key) => {
    if (sortKey.value === key) {
        isSortDesc.value = !isSortDesc.value;
    } else {
        sortKey.value = key;
        isSortDesc.value = true;
    }
};

const handleRowClick = async (sector) => {
    if (selectedBk.value?.code === sector.code) {
        selectedBk.value = null;
        bkStocks.value = [];
        return;
    }
    selectedBk.value = { code: sector.code, name: sector.name };
    isLoadingBkStocks.value = true;
    bkStocks.value = [];
    try {
        const resp = await apiGet('/api/sectors/stocks', { bk: sector.code });
        bkStocks.value = resp.data;
    } catch (error) {
        console.error('加载成份股失败:', error);
        bkStocks.value = [];
    } finally {
        isLoadingBkStocks.value = false;
    }
};

const handleStockClick = (code) => {
    openStock(code);
};

const handleRefresh = () => {
    loadSectors();
};

const sortArrow = (key) => {
    if (sortKey.value !== key) {
        return '';
    }
    return isSortDesc.value ? '▼' : '▲';
};

onMounted(loadSectors);
</script>

<template>
    <div class="sector-view">
        <div class="panel">
            <div class="panel-title">
                <h2>
                    板块排行
                    <span class="sub">共 {{ sectors.length }} 个板块{{ lastUpdated ? ` · 更新于 ${lastUpdated}` : '' }}</span>
                </h2>
                <div class="panel-title-right">
                    <span
                        v-if="meta"
                        class="tag"
                    >{{ meta.source }}</span>
                    <div class="btn-group">
                        <button
                            v-for="option in TYPE_OPTIONS"
                            :key="option.key"
                            class="btn"
                            :class="{ 'is-active': sectorType === option.key }"
                            @click="handleTypeChange(option.key)"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <button
                        class="btn"
                        :disabled="isLoading"
                        @click="handleRefresh"
                    >
                        刷新
                    </button>
                </div>
            </div>

            <div
                v-if="isLoading && sectors.length === 0"
                class="state-box"
            >
                <span class="loading-spinner" />加载板块数据…
            </div>
            <div
                v-else-if="errorMessage"
                class="state-box error"
            >
                加载失败：{{ errorMessage }}
            </div>
            <div
                v-else
                class="table-wrap sector-table-wrap"
            >
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>代码 / 名称</th>
                            <th>最新点位</th>
                            <th
                                v-for="column in SORT_COLUMNS"
                                :key="column.key"
                                class="is-sortable"
                                @click="handleSort(column.key)"
                            >
                                {{ column.label }}<span class="sort-arrow">{{ sortArrow(column.key) }}</span>
                            </th>
                            <th>涨/跌/平</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="sector in sortedSectors"
                            :key="sector.code"
                            class="is-clickable"
                            :class="{ 'is-selected': selectedBk?.code === sector.code }"
                            @click="handleRowClick(sector)"
                        >
                            <td>
                                <span class="cell-code">{{ sector.code }}</span>
                                <span class="cell-name">&nbsp;{{ sector.name }}</span>
                            </td>
                            <td class="num">{{ fmtPrice(sector.price) }}</td>
                            <td
                                class="num"
                                :class="trendClass(sector.pct)"
                            >{{ fmtPct(sector.pct) }}</td>
                            <td class="num">{{ sector.turnover === null ? '-' : `${sector.turnover}%` }}</td>
                            <td class="num">{{ sector.amplitude === null ? '-' : `${sector.amplitude}%` }}</td>
                            <td class="num">{{ fmtMarketValue(sector.totalMv) }}</td>
                            <td class="num">
                                <span class="up">{{ sector.upCount ?? '-' }}</span> /
                                <span class="down">{{ sector.downCount ?? '-' }}</span> /
                                <span class="flat">{{ sector.flatCount ?? '-' }}</span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- 成份股面板 -->
        <div
            v-if="selectedBk"
            class="panel"
        >
            <div class="panel-title">
                <h2>
                    {{ selectedBk.name }} 成份股
                    <span class="sub">{{ selectedBk.code }} · 共 {{ bkStocks.length }} 只 · 按涨跌幅排序 · 点击跳转个股</span>
                </h2>
            </div>
            <div
                v-if="isLoadingBkStocks"
                class="state-box"
            >
                <span class="loading-spinner" />加载成份股…
            </div>
            <div
                v-else-if="bkStocks.length === 0"
                class="state-box"
            >
                暂无成份股数据
            </div>
            <div
                v-else
                class="table-wrap"
            >
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>代码 / 名称</th>
                            <th>最新价</th>
                            <th>涨跌幅</th>
                            <th>开盘</th>
                            <th>最高</th>
                            <th>最低</th>
                            <th>换手率</th>
                            <th>流通市值</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="stock in bkStocks"
                            :key="stock.code"
                            class="is-clickable"
                            @click="handleStockClick(stock.code)"
                        >
                            <td>
                                <span class="cell-code">{{ stock.code }}</span>
                                <span class="cell-name">&nbsp;{{ stock.name }}</span>
                            </td>
                            <td
                                class="num"
                                :class="trendClass(stock.pct)"
                            >{{ fmtPrice(stock.price) }}</td>
                            <td
                                class="num"
                                :class="trendClass(stock.pct)"
                            >{{ fmtPct(stock.pct) }}</td>
                            <td class="num">{{ fmtPrice(stock.open) }}</td>
                            <td class="num">{{ fmtPrice(stock.high) }}</td>
                            <td class="num">{{ fmtPrice(stock.low) }}</td>
                            <td class="num">{{ stock.turnover === null ? '-' : `${stock.turnover}%` }}</td>
                            <td class="num">{{ fmtMarketValue(stock.circMv) }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<style scoped>
.sector-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

/* 板块表内部滚动：保证下方的成份股面板始终在视口内可见 */
.sector-table-wrap {
    max-height: 58vh;
    overflow-y: auto;
}

.panel-title-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
}
</style>
