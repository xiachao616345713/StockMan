<script setup>
/**
 * OverviewView：市场总览。
 * - 三大指数卡片（上证/深成/创业板，东财 kline lmt=1）
 * - 全市场涨跌统计（上涨/下跌/平盘/涨停/跌停/停牌）
 * - 涨幅榜 / 跌幅榜 Top20，点击跳转个股页
 * - 30s 自动刷新（页面不可见时跳过），可手动刷新
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, fmtSigned, fmtAmount, fmtClock, trendClass } from '../utils/format.js';

const REFRESH_INTERVAL_MS = 30_000;

const indices = ref([]);
const stats = ref(null);
const topUp = ref([]);
const topDown = ref([]);
const isLoading = ref(false);
const hasLoadError = ref(false);
const errorMessage = ref('');
const lastUpdated = ref('');
const meta = ref(null);

let refreshTimer = null;

const loadAll = async () => {
    if (isLoading.value) {
        return;
    }
    isLoading.value = true;
    hasLoadError.value = false;
    try {
        const [indicesResp, statsResp, upResp, downResp] = await Promise.all([
            apiGet('/api/indices'),
            apiGet('/api/stats'),
            apiGet('/api/ranking', { order: 'desc', limit: 20 }),
            apiGet('/api/ranking', { order: 'asc', limit: 20 }),
        ]);
        indices.value = indicesResp.data;
        stats.value = statsResp.data;
        topUp.value = upResp.data;
        topDown.value = downResp.data;
        meta.value = statsResp.meta;
        lastUpdated.value = fmtClock(statsResp.meta?.fetchedAt);
    } catch (error) {
        hasLoadError.value = true;
        errorMessage.value = error.message;
        console.error('加载总览数据失败:', error);
    } finally {
        isLoading.value = false;
    }
};

const handleRefresh = () => {
    loadAll();
};

const handleRowClick = (code) => {
    openStock(code);
};

const isIndexUp = (index) => (index.pct ?? 0) >= 0;

onMounted(() => {
    loadAll();
    refreshTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
            loadAll();
        }
    }, REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
});
</script>

<template>
    <div class="overview-view">
        <!-- 指数卡片 -->
        <div class="index-cards">
            <div
                v-for="index in indices"
                :key="index.secid"
                class="panel index-card"
            >
                <div class="index-name">{{ index.name }}</div>
                <div
                    class="index-price num"
                    :class="isIndexUp(index) ? 'up' : 'down'"
                >
                    {{ fmtPrice(index.close) }}
                </div>
                <div
                    class="index-change num"
                    :class="isIndexUp(index) ? 'up' : 'down'"
                >
                    {{ fmtSigned(index.change) }}&nbsp;&nbsp;{{ fmtPct(index.pct) }}
                </div>
                <div class="index-detail num">
                    <span>成交 {{ fmtAmount(index.amount) }}</span>
                    <span>振幅 {{ index.amplitude === null ? '-' : `${index.amplitude}%` }}</span>
                </div>
            </div>
        </div>

        <!-- 涨跌统计 -->
        <div class="panel stats-bar">
            <template v-if="stats">
                <span class="stat-item">
                    总数 <b class="num">{{ stats.total }}</b>
                </span>
                <span class="stat-item up">
                    上涨 <b class="num">{{ stats.up }}</b>
                </span>
                <span class="stat-item down">
                    下跌 <b class="num">{{ stats.down }}</b>
                </span>
                <span class="stat-item">
                    平盘 <b class="num">{{ stats.flat }}</b>
                </span>
                <span class="stat-item up">
                    涨停 <b class="num">{{ stats.limitUp }}</b>
                </span>
                <span class="stat-item down">
                    跌停 <b class="num">{{ stats.limitDown }}</b>
                </span>
                <span class="stat-item">
                    停牌 <b class="num">{{ stats.suspended }}</b>
                </span>
            </template>
            <div class="stats-right meta-line">
                <span v-if="isLoading"><span class="loading-spinner" />刷新中</span>
                <span v-else-if="lastUpdated">更新于 {{ lastUpdated }}</span>
                <span
                    v-if="meta"
                    class="tag"
                >{{ meta.source }}</span>
                <button
                    class="btn"
                    :disabled="isLoading"
                    @click="handleRefresh"
                >
                    刷新
                </button>
            </div>
        </div>

        <!-- 错误提示 -->
        <div
            v-if="hasLoadError"
            class="panel state-box error"
        >
            加载失败：{{ errorMessage }}
            <button
                class="btn"
                @click="handleRefresh"
            >
                重试
            </button>
        </div>

        <!-- 涨跌幅榜 -->
        <div class="grid-2col">
            <div class="panel">
                <div class="panel-title">
                    <h2>涨幅榜 <span class="sub">Top 20</span></h2>
                </div>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>代码 / 名称</th>
                                <th>最新价</th>
                                <th>涨跌幅</th>
                                <th>成交额</th>
                                <th>换手率</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="stock in topUp"
                                :key="stock.code"
                                class="is-clickable"
                                @click="handleRowClick(stock.code)"
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
                                <td class="num">{{ fmtAmount(stock.amount) }}</td>
                                <td class="num">{{ stock.turnover === null ? '-' : `${stock.turnover}%` }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="panel">
                <div class="panel-title">
                    <h2>跌幅榜 <span class="sub">Top 20</span></h2>
                </div>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>代码 / 名称</th>
                                <th>最新价</th>
                                <th>涨跌幅</th>
                                <th>成交额</th>
                                <th>换手率</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="stock in topDown"
                                :key="stock.code"
                                class="is-clickable"
                                @click="handleRowClick(stock.code)"
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
                                <td class="num">{{ fmtAmount(stock.amount) }}</td>
                                <td class="num">{{ stock.turnover === null ? '-' : `${stock.turnover}%` }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.overview-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.index-cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
}

@media (max-width: 760px) {
    .index-cards {
        grid-template-columns: 1fr;
    }
}

.index-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.index-name {
    font-size: 13px;
    color: var(--muted);
}

.index-price {
    font-size: 26px;
    font-weight: 700;
    line-height: 1.2;
}

.index-change {
    font-size: 13px;
}

.index-detail {
    display: flex;
    gap: 16px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
}

.stats-bar {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
    padding: 10px 16px;
}

.stat-item {
    font-size: 13px;
    color: var(--muted);
}

.stat-item b {
    font-size: 15px;
    margin-left: 2px;
}

.stats-right {
    margin-left: auto;
}
</style>
