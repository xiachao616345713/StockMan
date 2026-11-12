<script setup>
/**
 * ScreenerView：条件选股。
 * - 左栏：按筛选条件排序后的股票列表（点击选中）
 * - 右上：选中股票的日 K 线（复用 KLineChart）
 * - 右下：筛选指标（涨跌幅/换手率/成交额/总市值区间 + 板块 + 排除 ST + 排序），含快捷预设
 * 数据基础为后端全市场快照（/api/screen），不新增上游请求（决策见 docs/design.md）
 */
import { ref, computed, onMounted } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';
import KLineChart from '../components/KLineChart.vue';
import { fmtPrice, fmtPct, fmtClock, trendClass } from '../utils/format.js';

const DAY_OPTIONS = [60, 120, 250];
const LIST_LIMIT = 200;

const BOARD_OPTIONS = ['主板', '创业板', '科创板', '北交所'];
const SORT_OPTIONS = [
    { key: 'pct', label: '涨跌幅' },
    { key: 'turnover', label: '换手率' },
    { key: 'amount', label: '成交额' },
    { key: 'amplitude', label: '振幅' },
    { key: 'totalMv', label: '总市值' },
    { key: 'circMv', label: '流通市值' },
    { key: 'peTtm', label: '市盈率' },
    { key: 'pb', label: '市净率' },
    { key: 'volumeRatio', label: '量比' },
    { key: 'pct60', label: '60日涨幅' },
    { key: 'pctYtd', label: '年初至今' },
];

/** 默认表单 = 「中涨幅高换手」预设 */
const defaultForm = () => ({
    pctMin: 3,
    pctMax: 6,
    turnoverMin: 5,
    turnoverMax: 15,
    amountMin: '',
    amountMax: '',
    mvMin: '',
    mvMax: '',
    circMvMin: '',
    circMvMax: '',
    peMin: '',
    peMax: '',
    pbMin: '',
    pbMax: '',
    volumeRatioMin: '',
    volumeRatioMax: '',
    pct60Min: '',
    pct60Max: '',
    pctYtdMin: '',
    pctYtdMax: '',
    boards: [],
    excludeSt: true,
    sort: 'pct',
    dir: 'desc',
});

/** 快捷预设：仅覆盖与默认值不同的字段 */
const PRESETS = [
    { key: 'mid-gain', label: '中涨幅高换手', form: { pctMin: 3, pctMax: 6, turnoverMin: 5, turnoverMax: 15 } },
    { key: 'near-limit', label: '主板准涨停', form: { pctMin: 7, pctMax: 9.95, turnoverMin: '', turnoverMax: '', boards: ['主板'] } },
    { key: 'strong', label: '强势股 ≥9%', form: { pctMin: 9, pctMax: '', turnoverMin: '', turnoverMax: '' } },
    { key: 'small-cap', label: '小市值高活跃', form: { pctMin: '', pctMax: '', turnoverMin: 10, turnoverMax: '', mvMax: 50 } },
    { key: 'oversold', label: '超跌反弹池', form: { pctMin: '', pctMax: -5, turnoverMin: '', turnoverMax: '', sort: 'pct', dir: 'asc' } },
    {
        key: 'value',
        label: '低估值蓝筹',
        form: {
            pctMin: '', pctMax: '', turnoverMin: '', turnoverMax: '',
            peMin: 0, peMax: 15, pbMin: 0, pbMax: 1.5, mvMin: 200, sort: 'peTtm', dir: 'asc',
        },
    },
    {
        key: 'volume-surge',
        label: '放量启动',
        form: {
            pctMin: 2, pctMax: 9.9, turnoverMin: '', turnoverMax: '',
            volumeRatioMin: 2, sort: 'volumeRatio', dir: 'desc',
        },
    },
    {
        key: 'oversold-60d',
        label: '60日超跌',
        form: {
            pctMin: '', pctMax: '', turnoverMin: '', turnoverMax: '',
            pct60Max: -15, sort: 'pct60', dir: 'asc',
        },
    },
];

const form = ref(defaultForm());

const stockList = ref([]);
const matchTotal = ref(0);
const snapshotAt = ref('');
const screenSource = ref('');
const isLoadingList = ref(false);
const errorMessage = ref('');

const selected = ref(null);
const klineData = ref(null);
const klineDays = ref(120);
const isLoadingKline = ref(false);

/** 新浪兜底源缺 换手率/振幅/市值/市盈率/市净率/量比/涨跌停价 字段，设这些阈值会筛空，需提示用户 */
const isDegradedSource = computed(() => screenSource.value.startsWith('sina'));

const buildParams = () => {
    const params = { sort: form.value.sort, dir: form.value.dir, limit: LIST_LIMIT };
    const put = (key, value) => {
        if (value !== '' && value !== null && value !== undefined) {
            params[key] = value;
        }
    };
    put('pctMin', form.value.pctMin);
    put('pctMax', form.value.pctMax);
    put('turnoverMin', form.value.turnoverMin);
    put('turnoverMax', form.value.turnoverMax);
    put('amountMin', form.value.amountMin);
    put('amountMax', form.value.amountMax);
    put('mvMin', form.value.mvMin);
    put('mvMax', form.value.mvMax);
    put('circMvMin', form.value.circMvMin);
    put('circMvMax', form.value.circMvMax);
    put('peMin', form.value.peMin);
    put('peMax', form.value.peMax);
    put('pbMin', form.value.pbMin);
    put('pbMax', form.value.pbMax);
    put('volumeRatioMin', form.value.volumeRatioMin);
    put('volumeRatioMax', form.value.volumeRatioMax);
    put('pct60Min', form.value.pct60Min);
    put('pct60Max', form.value.pct60Max);
    put('pctYtdMin', form.value.pctYtdMin);
    put('pctYtdMax', form.value.pctYtdMax);
    if (form.value.boards.length > 0) {
        params.boards = form.value.boards.join(',');
    }
    if (!form.value.excludeSt) {
        params.excludeSt = '0';
    }
    return params;
};

const runScreen = async () => {
    isLoadingList.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/screen', buildParams());
        stockList.value = resp.data.list;
        matchTotal.value = resp.data.total;
        snapshotAt.value = fmtClock(resp.meta?.fetchedAt);
        screenSource.value = resp.meta?.source ?? '';
    } catch (error) {
        errorMessage.value = error.message;
        stockList.value = [];
        matchTotal.value = 0;
    } finally {
        isLoadingList.value = false;
    }
};

const loadKline = async (code) => {
    isLoadingKline.value = true;
    try {
        const resp = await apiGet('/api/kline', { code, days: klineDays.value });
        klineData.value = resp.data;
    } catch (error) {
        console.error('加载K线失败:', error);
        klineData.value = null;
    } finally {
        isLoadingKline.value = false;
    }
};

const handleSelect = (stock) => {
    selected.value = stock;
    loadKline(stock.code);
};

const handleDaysChange = (days) => {
    klineDays.value = days;
    if (selected.value) {
        loadKline(selected.value.code);
    }
};

const handleOpenInStock = () => {
    if (selected.value) {
        openStock(selected.value.code);
    }
};

const handlePreset = (preset) => {
    form.value = { ...defaultForm(), ...preset.form };
    runScreen();
};

const handleReset = () => {
    form.value = defaultForm();
    runScreen();
};

/** 区间输入不自动触发（避免逐字符请求），点击「筛选」执行 */
const handleScreen = () => {
    runScreen();
};

/** 排序/板块等离散条件变更立即重筛 */
const handleSortChange = (key) => {
    form.value.sort = key;
    runScreen();
};

const handleDirToggle = () => {
    form.value.dir = form.value.dir === 'desc' ? 'asc' : 'desc';
    runScreen();
};

const handleBoardToggle = (board) => {
    const boards = form.value.boards.includes(board)
        ? form.value.boards.filter((item) => item !== board)
        : [...form.value.boards, board];
    form.value.boards = boards;
    runScreen();
};

const handleExcludeStChange = () => {
    runScreen();
};

onMounted(async () => {
    await runScreen();
    // 默认选中第一只，保证右上 K 线区有内容
    if (stockList.value.length > 0) {
        handleSelect(stockList.value[0]);
    }
});
</script>

<template>
    <div class="screener-view">
        <!-- 左栏：筛选结果列表 -->
        <aside class="panel list-panel">
            <div class="panel-title">
                <h2>
                    筛选结果
                    <span class="sub">命中 {{ matchTotal }} · 展示 {{ stockList.length }}</span>
                    <span
                        v-if="isDegradedSource"
                        class="tag tag-warn"
                    >兜底源</span>
                </h2>
                <button
                    class="btn"
                    :disabled="isLoadingList"
                    @click="runScreen"
                >
                    刷新
                </button>
            </div>
            <div class="screen-list-head">
                <span>#</span>
                <span>代码 / 名称</span>
                <span class="num">最新价</span>
                <span class="num">涨跌幅</span>
                <span class="num">换手</span>
            </div>
            <div
                v-if="isLoadingList && stockList.length === 0"
                class="state-box"
            >
                <span class="loading-spinner" />筛选中…
            </div>
            <div
                v-else-if="errorMessage"
                class="state-box error"
            >
                筛选失败：{{ errorMessage }}
            </div>
            <div
                v-else-if="stockList.length === 0"
                class="state-box"
            >
                <p>无符合该条件的股票，请调整右下筛选指标</p>
                <p
                    v-if="isDegradedSource"
                    class="state-hint"
                >
                    当前快照为新浪兜底源（东财暂不可用），缺换手率/振幅/市值/市盈率/市净率/量比等字段，含这些阈值的条件会筛空；可改用仅涨跌幅的条件
                </p>
            </div>
            <div
                v-else
                class="screen-list"
            >
                <button
                    v-for="(stock, index) in stockList"
                    :key="stock.code"
                    class="screen-row"
                    :class="{ 'is-selected': selected?.code === stock.code }"
                    :title="`${stock.code} ${stock.name} · ${stock.board}`"
                    @click="handleSelect(stock)"
                >
                    <span class="row-rank num">{{ index + 1 }}</span>
                    <span class="row-main">
                        <span class="cell-name">{{ stock.name }}</span>
                        <span class="cell-code">{{ stock.code }}</span>
                    </span>
                    <span
                        class="row-num num"
                        :class="trendClass(stock.pct)"
                    >{{ fmtPrice(stock.price) }}</span>
                    <span
                        class="row-num num"
                        :class="trendClass(stock.pct)"
                    >{{ fmtPct(stock.pct) }}</span>
                    <span class="row-num num row-muted">{{ stock.turnover === null ? '-' : `${stock.turnover}%` }}</span>
                </button>
            </div>
        </aside>

        <!-- 右栏：上 K 线 / 下筛选指标 -->
        <section class="right-col">
            <div class="panel kline-panel">
                <div class="panel-title">
                    <h2 v-if="selected">
                        {{ selected.name }}
                        <span class="cell-code">{{ selected.code }}</span>
                        <span class="tag tag-accent">{{ selected.board }}</span>
                    </h2>
                    <h2 v-else>日 K 线</h2>
                    <div class="panel-title-right">
                        <span
                            v-if="selected"
                            class="num quote-inline"
                            :class="trendClass(selected.pct)"
                        >
                            {{ fmtPrice(selected.price) }}&nbsp;{{ fmtPct(selected.pct) }}
                        </span>
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
                        <button
                            v-if="selected"
                            class="btn"
                            @click="handleOpenInStock"
                        >
                            个股查询打开
                        </button>
                    </div>
                </div>
                <div
                    v-if="!selected"
                    class="state-box"
                >
                    点击左侧列表中的股票查看日 K 线
                </div>
                <div
                    v-else-if="isLoadingKline"
                    class="state-box"
                >
                    <span class="loading-spinner" />加载 K 线…
                </div>
                <KLineChart
                    v-else
                    :klines="klineData?.klines ?? []"
                    :stock-name="selected.name"
                    :stock-code="selected.code"
                />
            </div>

            <div class="panel filter-panel">
                <div class="panel-title">
                    <h2>
                        筛选指标
                        <span class="sub">基于全市场实时快照{{ snapshotAt ? ` · ${snapshotAt}` : '' }}</span>
                    </h2>
                    <div class="panel-title-right">
                        <button
                            class="btn"
                            @click="handleReset"
                        >
                            重置
                        </button>
                        <button
                            class="btn btn-primary"
                            :disabled="isLoadingList"
                            @click="handleScreen"
                        >
                            筛选
                        </button>
                    </div>
                </div>

                <div class="preset-row">
                    <span class="filter-label">快捷</span>
                    <button
                        v-for="preset in PRESETS"
                        :key="preset.key"
                        class="tag tag-clickable"
                        @click="handlePreset(preset)"
                    >
                        {{ preset.label }}
                    </button>
                </div>

                <div class="filter-grid">
                    <label class="filter-item">
                        <span class="filter-name">涨跌幅 %</span>
                        <input
                            v-model="form.pctMin"
                            class="input num-input"
                            type="number"
                            step="0.5"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.pctMax"
                            class="input num-input"
                            type="number"
                            step="0.5"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">换手率 %</span>
                        <input
                            v-model="form.turnoverMin"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.turnoverMax"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">成交额 亿</span>
                        <input
                            v-model="form.amountMin"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.amountMax"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">总市值 亿</span>
                        <input
                            v-model="form.mvMin"
                            class="input num-input"
                            type="number"
                            step="10"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.mvMax"
                            class="input num-input"
                            type="number"
                            step="10"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">流通市值 亿</span>
                        <input
                            v-model="form.circMvMin"
                            class="input num-input"
                            type="number"
                            step="10"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.circMvMax"
                            class="input num-input"
                            type="number"
                            step="10"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">市盈率TTM</span>
                        <input
                            v-model="form.peMin"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.peMax"
                            class="input num-input"
                            type="number"
                            step="1"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">市净率</span>
                        <input
                            v-model="form.pbMin"
                            class="input num-input"
                            type="number"
                            step="0.1"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.pbMax"
                            class="input num-input"
                            type="number"
                            step="0.1"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">量比</span>
                        <input
                            v-model="form.volumeRatioMin"
                            class="input num-input"
                            type="number"
                            step="0.5"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.volumeRatioMax"
                            class="input num-input"
                            type="number"
                            step="0.5"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">60日涨幅 %</span>
                        <input
                            v-model="form.pct60Min"
                            class="input num-input"
                            type="number"
                            step="5"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.pct60Max"
                            class="input num-input"
                            type="number"
                            step="5"
                            placeholder="最大"
                        >
                    </label>
                    <label class="filter-item">
                        <span class="filter-name">年初至今 %</span>
                        <input
                            v-model="form.pctYtdMin"
                            class="input num-input"
                            type="number"
                            step="5"
                            placeholder="最小"
                        >
                        <span class="range-sep">~</span>
                        <input
                            v-model="form.pctYtdMax"
                            class="input num-input"
                            type="number"
                            step="5"
                            placeholder="最大"
                        >
                    </label>
                </div>

                <div class="filter-row">
                    <span class="filter-label">板块</span>
                    <label
                        v-for="board in BOARD_OPTIONS"
                        :key="board"
                        class="check-item"
                    >
                        <input
                            type="checkbox"
                            :checked="form.boards.includes(board)"
                            @change="handleBoardToggle(board)"
                        >
                        {{ board }}
                    </label>
                    <label class="check-item">
                        <input
                            v-model="form.excludeSt"
                            type="checkbox"
                            @change="handleExcludeStChange"
                        >
                        排除 ST
                    </label>
                </div>

                <div class="filter-row">
                    <span class="filter-label">排序</span>
                    <div class="btn-group">
                        <button
                            v-for="option in SORT_OPTIONS"
                            :key="option.key"
                            class="btn"
                            :class="{ 'is-active': form.sort === option.key }"
                            @click="handleSortChange(option.key)"
                        >
                            {{ option.label }}
                        </button>
                    </div>
                    <button
                        class="btn"
                        @click="handleDirToggle"
                    >
                        {{ form.dir === 'desc' ? '降序 ↓' : '升序 ↑' }}
                    </button>
                </div>
            </div>
        </section>
    </div>
</template>

<style scoped>
.screener-view {
    display: grid;
    grid-template-columns: 350px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
}

.right-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
}

/* 左栏列表 */
.screen-list-head,
.screen-row {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) 72px 68px 56px;
    gap: 6px;
    align-items: center;
    padding: 7px 10px;
    font-size: 12.5px;
}

.screen-list-head {
    color: var(--muted);
    border-bottom: 1px solid var(--border);
}

.screen-list-head .num,
.screen-row .row-num {
    text-align: right;
}

.screen-list {
    max-height: 72vh;
    overflow-y: auto;
}

.screen-row {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
}

.screen-row:hover {
    background: rgba(79, 140, 255, 0.08);
}

.screen-row.is-selected {
    background: rgba(79, 140, 255, 0.16);
}

.row-rank {
    color: var(--muted);
}

.row-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
}

.row-main .cell-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.row-muted {
    color: var(--muted);
}

.state-hint {
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
}

/* 右上 K 线 */
.quote-inline {
    font-size: 14px;
    font-weight: 600;
}

/* 右下筛选面板 */
.preset-row,
.filter-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 0;
}

.preset-row {
    border-top: 1px solid var(--border);
}

.tag-clickable {
    cursor: pointer;
}

.tag-clickable:hover {
    border-color: var(--accent);
    color: var(--accent);
}

.filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px 18px;
    padding: 4px 0 8px;
}

.filter-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
}

.filter-name {
    width: 84px;
    color: var(--muted);
    flex-shrink: 0;
}

.num-input {
    width: 84px;
    padding: 6px 8px;
}

.range-sep {
    color: var(--muted);
}

.filter-label {
    width: 34px;
    color: var(--muted);
    font-size: 13px;
    flex-shrink: 0;
}

.check-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    cursor: pointer;
}

.btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}

.btn-primary:hover {
    filter: brightness(1.1);
}

@media (max-width: 900px) {
    .screener-view {
        grid-template-columns: 1fr;
    }

    .screen-list {
        max-height: 40vh;
    }
}
</style>
