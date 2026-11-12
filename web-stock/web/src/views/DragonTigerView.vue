<script setup>
/**
 * DragonTigerView：龙虎榜。
 * - 日期选择（默认今天；当日榜单收盘后约 17:00 起发布）
 * - 东财 datacenter 明细（上榜原因/净买额/买卖额/次日涨幅）+ 同花顺补充（游资/机构净买、营业部标签、概念）
 * - 表头点击排序（净买额/游资/机构/涨跌幅/次日涨幅 等），行点击跳转个股
 */
import { ref, computed, onMounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, fmtAmount, fmtMarketValue, trendClass } from '../utils/format.js';

/** 本地日期（yyyy-MM-dd）→ 接口日期（yyyyMMdd） */
const toApiDate = (isoDate) => isoDate.replaceAll('-', '');

const todayIso = () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
};

const queryDate = ref(todayIso());
const dtData = ref(null);
const isLoading = ref(false);
const errorMessage = ref('');

const sortKey = ref('netAmount');
const sortDir = ref('desc');

const SORTABLE = ['pct', 'netAmount', 'buyAmount', 'sellAmount', 'hotMoneyNet', 'orgNet', 'turnover', 'freeMv', 'd1Pct'];

const rawList = computed(() => dtData.value?.list ?? []);
const platforms = computed(() => dtData.value?.platforms ?? []);

const list = computed(() => {
    const factor = sortDir.value === 'desc' ? -1 : 1;
    return [...rawList.value].sort((a, b) => {
        const av = a[sortKey.value];
        const bv = b[sortKey.value];
        if (av === null && bv === null) {
            return 0;
        }
        if (av === null) {
            return 1; // 缺失值恒排末尾
        }
        if (bv === null) {
            return -1;
        }
        return (av - bv) * factor;
    });
});

const totalNet = computed(() =>
    rawList.value.reduce((sum, item) => sum + (item.netAmount ?? 0), 0),
);

const loadData = async () => {
    if (!queryDate.value) {
        return;
    }
    isLoading.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/dragon-tiger', { date: toApiDate(queryDate.value) });
        dtData.value = resp.data;
    } catch (error) {
        errorMessage.value = error.message;
        dtData.value = null;
    } finally {
        isLoading.value = false;
    }
};

const handleDateChange = () => {
    loadData();
};

const handleSort = (key) => {
    if (!SORTABLE.includes(key)) {
        return;
    }
    if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
    } else {
        sortKey.value = key;
        sortDir.value = 'desc';
    }
};

const sortArrow = (key) => {
    if (sortKey.value !== key) {
        return '';
    }
    return sortDir.value === 'desc' ? '↓' : '↑';
};

const handleStockClick = (code) => {
    openStock(code);
};

const platformLabel = (name) => ({ eastmoney: '东财', ths: '同花顺' })[name] ?? name;

onMounted(loadData);
</script>

<template>
    <div class="dragontiger-view">
        <div class="panel">
            <div class="panel-title">
                <h2>
                    龙虎榜
                    <span class="sub">每日收盘后发布 · 东财明细 + 同花顺游资/机构/标签</span>
                </h2>
                <div class="panel-title-right">
                    <span
                        v-for="platform in platforms"
                        :key="platform.name"
                        class="tag"
                        :class="platform.ok ? 'tag-accent' : 'tag-warn'"
                        :title="platform.ok ? '' : platform.error"
                    >
                        {{ platformLabel(platform.name) }}{{ platform.ok ? ' ✓' : ' 不可用' }}
                    </span>
                    <input
                        v-model="queryDate"
                        class="input date-input"
                        type="date"
                        :max="todayIso()"
                        @change="handleDateChange"
                    >
                </div>
            </div>

            <div
                v-if="dtData"
                class="summary-bar"
            >
                <span class="stat-item">
                    上榜 <b class="num">{{ rawList.length }}</b> 只
                </span>
                <span class="stat-item">
                    合计净买
                    <b
                        class="num"
                        :class="trendClass(totalNet)"
                    >{{ fmtAmount(totalNet) }}</b>
                </span>
                <span class="stat-item">
                    日期 <b class="num">{{ queryDate }}</b>
                </span>
            </div>

            <div
                v-if="isLoading"
                class="state-box"
            >
                <span class="loading-spinner" />加载中…
            </div>
            <div
                v-else-if="errorMessage"
                class="state-box error"
            >
                加载失败：{{ errorMessage }}
            </div>
            <div
                v-else-if="rawList.length === 0"
                class="state-box"
            >
                该日期无龙虎榜数据（交易日收盘后约 17:00 起发布），请选择最近的交易日
            </div>
            <div
                v-else
                class="table-wrap dt-table-wrap"
            >
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>代码 / 名称</th>
                            <th>收盘价</th>
                            <th
                                class="is-sortable"
                                @click="handleSort('pct')"
                            >涨跌幅<span class="sort-arrow">{{ sortArrow('pct') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('netAmount')"
                            >净买额<span class="sort-arrow">{{ sortArrow('netAmount') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('buyAmount')"
                            >买入额<span class="sort-arrow">{{ sortArrow('buyAmount') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('sellAmount')"
                            >卖出额<span class="sort-arrow">{{ sortArrow('sellAmount') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('hotMoneyNet')"
                            >游资净买<span class="sort-arrow">{{ sortArrow('hotMoneyNet') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('orgNet')"
                            >机构净买<span class="sort-arrow">{{ sortArrow('orgNet') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('turnover')"
                            >换手率<span class="sort-arrow">{{ sortArrow('turnover') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('freeMv')"
                            >流通市值<span class="sort-arrow">{{ sortArrow('freeMv') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('d1Pct')"
                            >次日涨幅<span class="sort-arrow">{{ sortArrow('d1Pct') }}</span></th>
                            <th class="reason-col">上榜原因</th>
                            <th class="tags-col">标签 / 概念</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="item in list"
                            :key="item.code"
                            class="is-clickable"
                            @click="handleStockClick(item.code)"
                        >
                            <td>
                                <span class="cell-code">{{ item.code }}</span>
                                <span class="cell-name">&nbsp;{{ item.name ?? '-' }}</span>
                            </td>
                            <td class="num">{{ fmtPrice(item.close) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.pct)"
                            >{{ fmtPct(item.pct) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.netAmount)"
                            >{{ fmtAmount(item.netAmount) }}</td>
                            <td class="num up">{{ fmtAmount(item.buyAmount) }}</td>
                            <td class="num down">{{ fmtAmount(item.sellAmount) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.hotMoneyNet)"
                            >{{ fmtAmount(item.hotMoneyNet) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.orgNet)"
                            >{{ fmtAmount(item.orgNet) }}</td>
                            <td class="num">{{ item.turnover === null ? '-' : `${item.turnover}%` }}</td>
                            <td class="num">{{ fmtMarketValue(item.freeMv) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.d1Pct)"
                            >{{ fmtPct(item.d1Pct) }}</td>
                            <td
                                class="reason-col ellipsis"
                                :title="[item.explanation, item.explain].filter(Boolean).join('\n')"
                            >{{ item.explanation ?? item.explain ?? '-' }}</td>
                            <td class="tags-col">
                                <span
                                    v-for="tag in item.tags.slice(0, 2)"
                                    :key="tag"
                                    class="tag tag-warn tag-item"
                                >{{ tag }}</span>
                                <span
                                    v-if="item.tags.length > 2"
                                    class="tag tag-item"
                                    :title="item.tags.join(' / ')"
                                >+{{ item.tags.length - 2 }}</span>
                                <span
                                    v-for="concept in item.concepts.slice(0, 2)"
                                    :key="concept"
                                    class="tag tag-accent tag-item"
                                >{{ concept }}</span>
                                <span
                                    v-if="item.concepts.length > 2"
                                    class="tag tag-item"
                                    :title="item.concepts.join(' / ')"
                                >+{{ item.concepts.length - 2 }}</span>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</template>

<style scoped>
.panel-title-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.date-input {
    padding: 6px 10px;
    color-scheme: dark;
}

.summary-bar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    padding-bottom: 12px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
}

.stat-item {
    font-size: 13px;
    color: var(--muted);
}

.stat-item b {
    font-size: 15px;
    margin-left: 2px;
    color: var(--text-strong);
}

.dt-table-wrap {
    max-height: 72vh;
    overflow-y: auto;
}

.reason-col {
    max-width: 210px;
    text-align: left !important;
}

.tags-col {
    min-width: 180px;
    max-width: 220px;
    text-align: left !important;
    white-space: normal !important;
}

.ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
}

.tag-item {
    margin: 1px 3px 1px 0;
}
</style>
