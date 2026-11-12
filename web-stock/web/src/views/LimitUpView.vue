<script setup>
/**
 * LimitUpView：涨停中心。
 * - 日期选择（默认今天；非交易日无数据时提示选择最近交易日）
 * - 涨停池（同花顺 limit_up_pool）：几天几板/涨停类型/涨停原因/首封时间/开板次数/封单等
 * - 涨停复盘（同花顺 block_top）：按题材分组展示涨停股，可折叠
 * - 连板天梯（/api/ladder）：按连板数分层的当日涨停梯队
 * - 关联分析（/api/limitup/related）：题材关联 + 近 N 日共同涨停统计
 * - 点击股票代码跳转个股页
 */
import { ref, computed, onMounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, fmtMarketValue, fmtShares, trendClass } from '../utils/format.js';
import LimitUpLadder from '../components/LimitUpLadder.vue';
import LimitUpRelated from '../components/LimitUpRelated.vue';

const SUB_TABS = [
    { key: 'pool', label: '涨停池' },
    { key: 'replay', label: '涨停复盘' },
    { key: 'ladder', label: '连板天梯' },
    { key: 'related', label: '关联分析' },
];

const COLLAPSED_AFTER = 5; // 复盘默认展开前 5 个题材

/** 本地日期（yyyy-MM-dd）→ 接口日期（yyyyMMdd） */
const toApiDate = (isoDate) => isoDate.replaceAll('-', '');

const todayIso = () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
};

const queryDate = ref(todayIso());
const subTab = ref('pool');
const relatedCode = ref(''); // 关联分析带入的股票代码

const poolData = ref(null);
const replayData = ref(null);
const isLoading = ref(false);
const errorMessage = ref('');
const collapsedGroups = ref(new Set());

const poolList = computed(() => poolData.value?.list ?? []);
const poolSummary = computed(() => poolData.value?.summary ?? null);
const replayGroups = computed(() => replayData.value?.groups ?? []);

const loadData = async () => {
    if (!queryDate.value) {
        return;
    }
    isLoading.value = true;
    errorMessage.value = '';
    const date = toApiDate(queryDate.value);
    try {
        const [poolResp, replayResp] = await Promise.all([
            apiGet('/api/limitup/pool', { date }),
            apiGet('/api/limitup/replay', { date }),
        ]);
        poolData.value = poolResp.data;
        replayData.value = replayResp.data;
        // 默认折叠第 COLLAPSED_AFTER 个之后的题材分组
        collapsedGroups.value = new Set(
            (replayResp.data?.groups ?? []).slice(COLLAPSED_AFTER).map((group) => group.name),
        );
    } catch (error) {
        errorMessage.value = error.message;
        poolData.value = null;
        replayData.value = null;
    } finally {
        isLoading.value = false;
    }
};

const handleDateChange = () => {
    loadData();
};

const handleSubTabChange = (key) => {
    subTab.value = key;
};

const handleStockClick = (code) => {
    openStock(code);
};

/** 涨停池「关联」按钮 → 带入代码并切到关联分析子页 */
const handleRelatedClick = (code) => {
    relatedCode.value = code;
    subTab.value = 'related';
};

const handleGroupToggle = (groupName) => {
    const next = new Set(collapsedGroups.value);
    if (next.has(groupName)) {
        next.delete(groupName);
    } else {
        next.add(groupName);
    }
    collapsedGroups.value = next;
};

const isGroupCollapsed = (groupName) => collapsedGroups.value.has(groupName);

/** "3天2板" → 提取板数用于徽章着色 */
const boardCountOf = (highDays) => {
    const match = String(highDays ?? '').match(/(\d+)板/);
    return match ? Number(match[1]) : 0;
};

onMounted(loadData);
</script>

<template>
    <div class="limitup-view">
        <div class="panel">
            <div class="panel-title">
                <h2>涨停中心</h2>
                <div class="panel-title-right">
                    <div class="btn-group">
                        <button
                            v-for="tab in SUB_TABS"
                            :key="tab.key"
                            class="btn"
                            :class="{ 'is-active': subTab === tab.key }"
                            @click="handleSubTabChange(tab.key)"
                        >
                            {{ tab.label }}
                        </button>
                    </div>
                    <input
                        v-model="queryDate"
                        class="input date-input"
                        type="date"
                        :max="todayIso()"
                        @change="handleDateChange"
                    >
                </div>
            </div>

            <!-- 摘要 -->
            <div
                v-if="subTab === 'pool' && poolSummary"
                class="summary-bar"
            >
                <span class="stat-item up">
                    涨停 <b class="num">{{ poolSummary.limitUpCount ?? poolList.length }}</b>
                </span>
                <span
                    v-if="poolSummary.limitDownCount !== null"
                    class="stat-item down"
                >
                    跌停 <b class="num">{{ poolSummary.limitDownCount }}</b>
                </span>
                <span
                    v-if="poolSummary.tradeStatus"
                    class="stat-item"
                >
                    交易状态 <b>{{ poolSummary.tradeStatus }}</b>
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

            <!-- 涨停池表格 -->
            <template v-else-if="subTab === 'pool'">
                <div
                    v-if="poolList.length === 0"
                    class="state-box"
                >
                    该日期无涨停池数据，请选择最近的交易日
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
                                <th>几天几板</th>
                                <th>类型</th>
                                <th>首封时间</th>
                                <th>开板</th>
                                <th>换手率</th>
                                <th>封单</th>
                                <th>流通市值</th>
                                <th class="reason-col">涨停原因</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="stock in poolList"
                                :key="stock.code"
                                class="is-clickable"
                                @click="handleStockClick(stock.code)"
                            >
                                <td>
                                    <span class="cell-code">{{ stock.code }}</span>
                                    <span class="cell-name">&nbsp;{{ stock.name }}</span>
                                </td>
                                <td class="num up">{{ fmtPrice(stock.price) }}</td>
                                <td class="num up">{{ fmtPct(stock.pct) }}</td>
                                <td>
                                    <span
                                        class="tag"
                                        :class="boardCountOf(stock.highDays) >= 2 ? 'tag-up' : ''"
                                    >{{ stock.highDays ?? '-' }}</span>
                                </td>
                                <td>{{ stock.limitUpType ?? '-' }}</td>
                                <td class="num">{{ stock.firstLimitUpTime ?? '-' }}</td>
                                <td class="num">{{ stock.openNum ?? 0 }}</td>
                                <td class="num">{{ stock.turnover === null ? '-' : `${stock.turnover}%` }}</td>
                                <td class="num">{{ fmtShares(stock.orderVolume) }}</td>
                                <td class="num">{{ fmtMarketValue(stock.circMv) }}</td>
                                <td
                                    class="reason-col reason-text"
                                    :title="stock.reasonType ?? ''"
                                >{{ stock.reasonType ?? '-' }}</td>
                                <td>
                                    <button
                                        class="btn btn-mini"
                                        @click.stop="handleRelatedClick(stock.code)"
                                    >
                                        关联
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>

            <!-- 涨停复盘分组 -->
            <template v-else-if="subTab === 'replay'">
                <div
                    v-if="replayGroups.length === 0"
                    class="state-box"
                >
                    该日期无涨停复盘数据，请选择最近的交易日
                </div>
                <div
                    v-else
                    class="replay-groups"
                >
                    <div
                        v-for="group in replayGroups"
                        :key="group.name"
                        class="replay-group"
                    >
                        <button
                            class="group-header"
                            @click="handleGroupToggle(group.name)"
                        >
                            <span class="group-arrow">{{ isGroupCollapsed(group.name) ? '▸' : '▾' }}</span>
                            <span class="group-name">{{ group.name }}</span>
                            <span class="tag tag-up">{{ group.limitUpNum ?? group.stocks.length }} 只涨停</span>
                            <span
                                v-if="group.days"
                                class="tag"
                            >持续 {{ group.days }} 天</span>
                        </button>
                        <div
                            v-show="!isGroupCollapsed(group.name)"
                            class="group-stocks"
                        >
                            <button
                                v-for="stock in group.stocks"
                                :key="stock.code"
                                class="stock-chip"
                                :title="`${stock.code} ${stock.reasonInfo ?? stock.reasonType ?? ''}`"
                                @click="handleStockClick(stock.code)"
                            >
                                <span class="chip-name">{{ stock.name }}</span>
                                <span
                                    v-if="boardCountOf(stock.highDays) >= 2 || (stock.continueNum ?? 0) >= 2"
                                    class="chip-board tag-up"
                                >{{ stock.highDays ?? `${stock.continueNum}板` }}</span>
                                <span
                                    class="chip-pct num"
                                    :class="trendClass(stock.pct)"
                                >{{ fmtPct(stock.pct) }}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </template>

            <!-- 连板天梯 -->
            <limit-up-ladder
                v-else-if="subTab === 'ladder'"
                :date="toApiDate(queryDate)"
            />

            <!-- 关联分析 -->
            <limit-up-related
                v-else
                :date="toApiDate(queryDate)"
                :initial-code="relatedCode"
            />
        </div>
    </div>
</template>

<style scoped>
.panel-title-right {
    display: flex;
    align-items: center;
    gap: 10px;
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

.stat-item.up b {
    color: var(--up);
}

.stat-item.down b {
    color: var(--down);
}

.reason-col {
    max-width: 320px;
}

.reason-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12px;
}

.replay-groups {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.replay-group {
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
}

.group-header {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 14px;
    background: var(--panel-2);
    border: none;
    color: var(--text);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
}

.group-header:hover {
    background: #1c2333;
}

.group-arrow {
    color: var(--muted);
    width: 12px;
}

.group-name {
    font-weight: 600;
    color: var(--text-strong);
}

.group-stocks {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 14px;
}

.stock-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
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
    font-weight: 500;
}

.chip-board {
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--up);
    background: rgba(246, 70, 93, 0.1);
}

.chip-pct {
    color: var(--muted);
}

.btn-mini {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 4px;
}
</style>
