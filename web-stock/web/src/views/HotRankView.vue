<script setup>
/**
 * HotRankView：热榜（多平台人气/热度合并）。
 * - 平台状态徽章：东财(dfcf) / 同花顺(ths) / 财联社(cls) / 大智慧(dzh)，任一可用即出数据
 * - 按东财名次为主序、同花顺名次为次序排序；缺失名次排末尾
 * - 表头点击可按任一平台名次/涨跌幅排序；行点击跳转个股
 * - 日期选择（v1.6.0）：历史日期由服务端归档直读（上游无历史热榜接口，归档缺失时如实提示）
 */
import { ref, computed, onMounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import { fmtPrice, fmtPct, fmtInt, trendClass } from '../utils/format.js';

const LIMIT_OPTIONS = [50, 100, 300];

/** 本地日期（yyyy-MM-dd）→ 接口日期（yyyyMMdd） */
const toApiDate = (isoDate) => isoDate.replaceAll('-', '');

const todayIso = () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
};

const queryDate = ref(todayIso());
const limit = ref(100);
const hotData = ref(null);
const meta = ref(null);
const isLoading = ref(false);
const errorMessage = ref('');

const sortKey = ref('dfcfRank');
const sortDir = ref('asc');

const SORTABLE = ['dfcfRank', 'thsRank', 'clsRank', 'dzhRank', 'pct'];

const PLATFORM_LABELS = { dfcf: '东财', ths: '同花顺', cls: '财联社', dzh: '大智慧' };
const platformLabel = (name) => PLATFORM_LABELS[name] ?? name;

const rawList = computed(() => hotData.value?.list ?? []);
const platforms = computed(() => hotData.value?.platforms ?? []);
const total = computed(() => hotData.value?.total ?? 0);

const list = computed(() => {
    const factor = sortDir.value === 'desc' ? -1 : 1;
    return [...rawList.value].sort((a, b) => {
        // 名次类字段缺失 = 该平台未收录，恒排末尾
        const av = a[sortKey.value] ?? Number.MAX_SAFE_INTEGER;
        const bv = b[sortKey.value] ?? Number.MAX_SAFE_INTEGER;
        return (av - bv) * factor;
    });
});

const loadData = async () => {
    isLoading.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/hot-rank', { limit: limit.value, date: toApiDate(queryDate.value) });
        hotData.value = resp.data;
        meta.value = resp.meta ?? null;
    } catch (error) {
        errorMessage.value = error.message;
        hotData.value = null;
        meta.value = null;
    } finally {
        isLoading.value = false;
    }
};

const handleDateChange = () => {
    loadData();
};

const handleLimit = (value) => {
    limit.value = value;
    loadData();
};

/** 归档直读标记（v1.6.0）：历史日期命中服务端归档时展示落盘时间 */
const archiveInfo = computed(() => {
    if (meta.value?.fromArchive !== true) {
        return null;
    }
    return {
        savedAt: meta.value.archiveSavedAt
            ? new Date(meta.value.archiveSavedAt).toLocaleString('zh-CN', { hour12: false })
            : null,
    };
});

const handleSort = (key) => {
    if (!SORTABLE.includes(key)) {
        return;
    }
    if (sortKey.value === key) {
        sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
    } else {
        sortKey.value = key;
        // 名次升序更有意义，涨跌幅降序更有意义
        sortDir.value = key === 'pct' ? 'desc' : 'asc';
    }
};

const sortArrow = (key) => {
    if (sortKey.value !== key) {
        return '';
    }
    return sortDir.value === 'desc' ? '↓' : '↑';
};

/** 名次变化：正数 ▲ 红、负数 ▼ 绿、0 — */
const rankChangeInfo = (change) => {
    if (change === null || change === undefined) {
        return null;
    }
    if (change > 0) {
        return { text: `▲${change}`, cls: 'up' };
    }
    if (change < 0) {
        return { text: `▼${-change}`, cls: 'down' };
    }
    return { text: '—', cls: 'flat' };
};

const handleStockClick = (code) => {
    openStock(code);
};

onMounted(loadData);
</script>

<template>
    <div class="hotrank-view">
        <div class="panel">
            <div class="panel-title">
                <h2>
                    热榜
                    <span class="sub">东财人气 + 同花顺热榜 + 财联社 + 大智慧，按代码合并</span>
                </h2>
                <div class="panel-title-right">
                    <span
                        v-for="platform in platforms"
                        :key="platform.name"
                        class="tag"
                        :class="platform.ok ? 'tag-accent' : 'tag-warn'"
                        :title="platform.ok ? '' : platform.error"
                    >
                        {{ platformLabel(platform.name) }}{{ platform.ok ? ` ✓${platform.count ?? ''}` : ' 不可用' }}
                    </span>
                    <input
                        v-model="queryDate"
                        class="input date-input"
                        type="date"
                        :max="todayIso()"
                        :title="queryDate === todayIso() ? '今天（实时）' : '历史日期由本地归档提供'"
                        @change="handleDateChange"
                    >
                    <div class="btn-group">
                        <button
                            v-for="option in LIMIT_OPTIONS"
                            :key="option"
                            class="btn"
                            :class="{ 'is-active': limit === option }"
                            @click="handleLimit(option)"
                        >
                            前{{ option }}
                        </button>
                    </div>
                    <button
                        class="btn"
                        :disabled="isLoading"
                        @click="loadData"
                    >
                        刷新
                    </button>
                </div>
            </div>

            <div class="meta-line">
                <span
                    v-if="archiveInfo"
                    class="tag tag-accent"
                >📦 历史归档{{ archiveInfo.savedAt ? ` · 保存于 ${archiveInfo.savedAt}` : '' }}</span>
                共合并 {{ total }} 只股票，当前展示 {{ rawList.length }} 只 ·
                名次为空表示该平台未收录此股
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
                暂无热榜数据，请稍后重试
            </div>
            <div
                v-else
                class="table-wrap hot-table-wrap"
            >
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>代码 / 名称</th>
                            <th>最新价</th>
                            <th
                                class="is-sortable"
                                @click="handleSort('pct')"
                            >涨跌幅<span class="sort-arrow">{{ sortArrow('pct') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('dfcfRank')"
                            >东财<span class="sort-arrow">{{ sortArrow('dfcfRank') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('thsRank')"
                            >同花顺<span class="sort-arrow">{{ sortArrow('thsRank') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('clsRank')"
                            >财联社<span class="sort-arrow">{{ sortArrow('clsRank') }}</span></th>
                            <th
                                class="is-sortable"
                                @click="handleSort('dzhRank')"
                            >大智慧<span class="sort-arrow">{{ sortArrow('dzhRank') }}</span></th>
                            <th>热度标签</th>
                            <th>量比</th>
                            <th class="concepts-col">概念</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="(item, index) in list"
                            :key="item.code"
                            class="is-clickable"
                            @click="handleStockClick(item.code)"
                        >
                            <td class="num muted">{{ index + 1 }}</td>
                            <td>
                                <span class="cell-code">{{ item.code }}</span>
                                <span class="cell-name">&nbsp;{{ item.name ?? '-' }}</span>
                            </td>
                            <td class="num">{{ fmtPrice(item.price) }}</td>
                            <td
                                class="num"
                                :class="trendClass(item.pct)"
                            >{{ fmtPct(item.pct) }}</td>
                            <td class="num">{{ item.dfcfRank ?? '-' }}</td>
                            <td class="num">
                                {{ item.thsRank ?? '-' }}
                                <span
                                    v-if="rankChangeInfo(item.thsRankChange)"
                                    class="rank-change"
                                    :class="rankChangeInfo(item.thsRankChange).cls"
                                    :title="`同花顺热度值 ${fmtInt(item.thsHotValue)}`"
                                >{{ rankChangeInfo(item.thsRankChange).text }}</span>
                            </td>
                            <td class="num">
                                {{ item.clsRank ?? '-' }}
                                <span
                                    v-if="rankChangeInfo(item.clsRankChange)"
                                    class="rank-change"
                                    :class="rankChangeInfo(item.clsRankChange).cls"
                                >{{ rankChangeInfo(item.clsRankChange).text }}</span>
                            </td>
                            <td
                                class="num"
                                :title="item.dzhHeat === null ? '' : `大智慧热度 ${fmtInt(item.dzhHeat)}`"
                            >{{ item.dzhRank ?? '-' }}</td>
                            <td>
                                <span
                                    v-if="item.popularityTag"
                                    class="tag tag-up"
                                    :title="item.analyseTitle"
                                >{{ item.popularityTag }}</span>
                                <span
                                    v-else
                                    class="muted"
                                >-</span>
                            </td>
                            <td class="num">{{ item.volumeRatio === null ? '-' : Number(item.volumeRatio).toFixed(2) }}</td>
                            <td
                                class="concepts-col"
                                :title="item.concepts.join(' / ')"
                            >
                                <span
                                    v-for="concept in item.concepts.slice(0, 3)"
                                    :key="concept"
                                    class="tag tag-accent tag-item"
                                >{{ concept }}</span>
                                <span
                                    v-if="item.concepts.length > 3"
                                    class="tag tag-item"
                                >+{{ item.concepts.length - 3 }}</span>
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

.hot-table-wrap {
    max-height: 74vh;
    overflow-y: auto;
}

.rank-change {
    font-size: 11px;
    margin-left: 3px;
}

.concepts-col {
    max-width: 240px;
    text-align: left !important;
    white-space: normal !important;
}

.tag-item {
    margin: 1px 3px 1px 0;
}

.muted {
    color: var(--muted);
}
</style>
