<script setup>
/**
 * LimitUpLadder：连板天梯。
 * 当日涨停池按连板数分层（高度板在前），层内「N板N天」最强者优先、再按首封时间。
 * 数据来自 /api/ladder（后端复用涨停池缓存，前端零额外请求）。
 */
import { ref, watch } from 'vue';
import { apiGet } from '../api.js';
import { openStock } from '../store.js';

const props = defineProps({
    /** 交易日 yyyyMMdd */
    date: {
        type: String,
        required: true,
    },
});

const ladderData = ref(null);
const isLoading = ref(false);
const errorMessage = ref('');

const loadData = async () => {
    if (!props.date) {
        return;
    }
    isLoading.value = true;
    errorMessage.value = '';
    try {
        const resp = await apiGet('/api/ladder', { date: props.date });
        ladderData.value = resp.data;
    } catch (error) {
        errorMessage.value = error.message;
        ladderData.value = null;
    } finally {
        isLoading.value = false;
    }
};

watch(() => props.date, loadData, { immediate: true });

const handleStockClick = (code) => {
    openStock(code);
};

/** 连板高度着色：越高越醒目 */
const tierClass = (boards) => {
    if (boards >= 5) {
        return 'tier-hot';
    }
    if (boards >= 3) {
        return 'tier-warm';
    }
    if (boards === 2) {
        return 'tier-mid';
    }
    return '';
};

/** 时间 HH:mm:ss → HH:mm */
const shortTime = (clock) => (clock ? String(clock).slice(0, 5) : '');
</script>

<template>
    <div class="ladder">
        <div
            v-if="ladderData"
            class="summary-bar"
        >
            <span class="stat-item">
                最高 <b class="num up">{{ ladderData.maxBoards }}</b> 连板
            </span>
            <span class="stat-item">
                涨停 <b class="num">{{ ladderData.totalCount }}</b> 只
            </span>
            <span
                v-if="ladderData.tradeStatus"
                class="stat-item"
            >
                状态 <b class="num">{{ ladderData.tradeStatus }}</b>
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
            v-else-if="!ladderData || ladderData.tiers.length === 0"
            class="state-box"
        >
            该日期无涨停数据，请选择最近的交易日
        </div>
        <div
            v-else
            class="ladder-body"
        >
            <div
                v-for="tier in ladderData.tiers"
                :key="tier.boards"
                class="ladder-row"
            >
                <div
                    class="ladder-label"
                    :class="tierClass(tier.boards)"
                >
                    <span class="label-boards">{{ tier.label }}</span>
                    <span class="label-count">{{ tier.count }}只</span>
                </div>
                <div class="ladder-stocks">
                    <button
                        v-for="stock in tier.stocks"
                        :key="stock.code"
                        class="stock-chip"
                        :class="tierClass(tier.boards)"
                        :title="`${stock.code} ${stock.name}\n${stock.highDays ?? ''} ${stock.reasonType ?? ''}\n首封 ${stock.firstLimitUpTime ?? '-'}`"
                        @click="handleStockClick(stock.code)"
                    >
                        <span class="chip-name">{{ stock.name }}</span>
                        <span
                            v-if="stock.ladderDays > stock.boards"
                            class="chip-days"
                        >{{ stock.ladderDays }}天</span>
                        <span class="chip-time">{{ shortTime(stock.firstLimitUpTime) }}</span>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.summary-bar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    padding-bottom: 12px;
    margin-bottom: 12px;
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

.ladder-body {
    max-height: 70vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ladder-row {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 12px;
    align-items: start;
}

.ladder-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 8px 4px;
    border-radius: 8px;
    background: var(--bg-soft, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--border);
    min-height: 52px;
}

.label-boards {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
}

.label-count {
    font-size: 11px;
    color: var(--muted);
}

.ladder-label.tier-mid .label-boards {
    color: var(--warn);
}

.ladder-label.tier-warm .label-boards {
    color: #ff9f43;
}

.ladder-label.tier-hot .label-boards {
    color: var(--up);
}

.ladder-stocks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.stock-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-soft, rgba(255, 255, 255, 0.04));
    color: var(--text-strong);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.15s, transform 0.1s;
}

.stock-chip:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
}

.stock-chip.tier-mid .chip-name {
    color: var(--warn);
}

.stock-chip.tier-warm .chip-name {
    color: #ff9f43;
}

.stock-chip.tier-hot .chip-name {
    color: var(--up);
    font-weight: 700;
}

.chip-days {
    font-size: 10px;
    color: var(--muted);
}

.chip-time {
    font-size: 10px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
}
</style>
