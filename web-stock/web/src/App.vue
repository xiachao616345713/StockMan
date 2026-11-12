<script setup>
/**
 * App 根组件：顶部导航（AI 助手 / 总览 / 个股查询 / 板块排行 / 涨停中心 / 条件选股 / 龙虎榜 / 热榜）
 * + 交易状态徽章 + 系统设置齿轮入口（v1.4.0）。
 *
 * 默认标签页为 AI 助手聊天框（v1.3.0，store.js activeTab 初始值 'chat'）。
 * 视图间跳转通过 store.js 的模块级 ref 完成（未引入 vue-router，决策见 docs/design.md）。
 * 设置页不进导航标签，由右侧齿轮按钮单独触发（activeTab === 'settings'）。
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { activeTab } from './store.js';
import { apiGet } from './api.js';
import ChatView from './views/ChatView.vue';
import OverviewView from './views/OverviewView.vue';
import StockView from './views/StockView.vue';
import SectorView from './views/SectorView.vue';
import LimitUpView from './views/LimitUpView.vue';
import ScreenerView from './views/ScreenerView.vue';
import DragonTigerView from './views/DragonTigerView.vue';
import HotRankView from './views/HotRankView.vue';
import SettingsView from './views/SettingsView.vue';

const TABS = [
    { key: 'chat', label: 'AI 助手', component: ChatView },
    { key: 'overview', label: '总览', component: OverviewView },
    { key: 'stock', label: '个股查询', component: StockView },
    { key: 'sector', label: '板块排行', component: SectorView },
    { key: 'limitup', label: '涨停中心', component: LimitUpView },
    { key: 'screener', label: '条件选股', component: ScreenerView },
    { key: 'dragontiger', label: '龙虎榜', component: DragonTigerView },
    { key: 'hotrank', label: '热榜', component: HotRankView },
];

/** 视图映射：导航标签 + 设置页（settings 不在 TABS 中，由齿轮按钮触发） */
const VIEW_MAP = Object.fromEntries([
    ...TABS.map((tab) => [tab.key, tab.component]),
    ['settings', SettingsView],
]);

const isTradingTime = ref(false);
const serverVersion = ref('');

let healthTimer = null;

const fetchHealth = async () => {
    try {
        const { data } = await apiGet('/api/health');
        isTradingTime.value = data.isTradingTime;
        serverVersion.value = data.version;
    } catch (error) {
        console.error('健康检查失败:', error);
    }
};

const handleTabClick = (key) => {
    activeTab.value = key;
};

onMounted(() => {
    fetchHealth();
    healthTimer = setInterval(fetchHealth, 60_000);
});

onUnmounted(() => {
    if (healthTimer) {
        clearInterval(healthTimer);
    }
});
</script>

<template>
    <header class="app-header">
        <div class="app-logo">
            <span class="logo-icon">📈</span>
            <span>股票行情查询</span>
        </div>
        <nav class="app-nav">
            <button
                v-for="tab in TABS"
                :key="tab.key"
                class="nav-tab"
                :class="{ 'is-active': activeTab === tab.key }"
                @click="handleTabClick(tab.key)"
            >
                {{ tab.label }}
            </button>
        </nav>
        <div class="header-right">
            <div class="session-badge">
                <span
                    class="session-dot"
                    :class="{ 'is-trading': isTradingTime }"
                />
                <span>{{ isTradingTime ? '交易中' : '已收盘' }}</span>
            </div>
            <button
                class="gear-btn"
                :class="{ 'is-active': activeTab === 'settings' }"
                title="系统设置"
                @click="handleTabClick('settings')"
            >
                ⚙
            </button>
        </div>
    </header>

    <main class="app-main">
        <component
            :is="VIEW_MAP[activeTab]"
            v-if="VIEW_MAP[activeTab]"
        />
    </main>

    <footer class="app-footer">
        数据来源：东方财富 · 新浪财经 · 搜狐财经 · 同花顺 · 财联社 · 大智慧（仅用于个人学习研究） ·
        server v{{ serverVersion || '?' }} · 接口文档见项目 docs/api.md
    </footer>
</template>
