<script setup>
/**
 * KLineChart 组件：日 K 蜡烛图 + MA5/10/20 均线 + 成交量副图（ECharts）。
 *
 * 颜色遵循红涨绿跌（--up / --down）。组件销毁时 dispose 实例，容器尺寸变化自动 resize。
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
    klines: {
        type: Array,
        default: () => [],
    },
    stockName: {
        type: String,
        default: '',
    },
    stockCode: {
        type: String,
        default: '',
    },
});

const UP_COLOR = '#f6465d';
const DOWN_COLOR = '#2ebd85';
const MA_COLORS = ['#f0b90b', '#4f8cff', '#c084fc'];

const chartRef = ref(null);
let chartInstance = null;
let resizeObserver = null;

/** 计算 N 日均线（前 N-1 项为 null，ECharts 自动断开） */
const computeMa = (closes, n) =>
    closes.map((_, index) => {
        if (index < n - 1) {
            return null;
        }
        let sum = 0;
        for (let i = index - n + 1; i <= index; i += 1) {
            sum += closes[i];
        }
        return Number((sum / n).toFixed(2));
    });

const buildOption = () => {
    const dates = props.klines.map((k) => k.date);
    // ECharts 蜡烛数据顺序：[open, close, low, high]
    const ohlc = props.klines.map((k) => [k.open, k.close, k.low, k.high]);
    const closes = props.klines.map((k) => k.close);
    const volumes = props.klines.map((k) => ({
        value: k.volume,
        itemStyle: {
            color: k.close >= k.open ? UP_COLOR : DOWN_COLOR,
            opacity: 0.7,
        },
    }));
    const maPeriods = [5, 10, 20];

    return {
        animation: false,
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            backgroundColor: 'rgba(18, 22, 31, 0.96)',
            borderColor: '#232a38',
            textStyle: { color: '#d5d9e0', fontSize: 12 },
            formatter: (params) => {
                const klineParam = params.find((p) => p.seriesType === 'candlestick');
                if (!klineParam) {
                    return '';
                }
                const row = props.klines[klineParam.dataIndex];
                if (!row) {
                    return '';
                }
                const pctClass = row.pct >= 0 ? UP_COLOR : DOWN_COLOR;
                const volumeText =
                    row.volume === null
                        ? '-'
                        : row.volume >= 1e4
                            ? `${(row.volume / 1e4).toFixed(2)}万手`
                            : `${row.volume}手`;
                const amountText =
                    row.amount === null
                        ? '-'
                        : row.amount >= 1e8
                            ? `${(row.amount / 1e8).toFixed(2)}亿`
                            : `${(row.amount / 1e4).toFixed(2)}万`;
                const maLines = params
                    .filter((p) => p.seriesType === 'line' && p.value !== null && p.value !== undefined)
                    .map((p) => `${p.marker}${p.seriesName}: ${Number(p.value).toFixed(2)}`)
                    .join('&nbsp;&nbsp;');
                return [
                    `<b>${row.date}</b>`,
                    `开盘: ${row.open}&nbsp;&nbsp;收盘: ${row.close}`,
                    `最高: ${row.high}&nbsp;&nbsp;最低: ${row.low}`,
                    `涨跌幅: <span style="color:${pctClass}">${row.pct === null ? '-' : `${row.pct > 0 ? '+' : ''}${row.pct.toFixed(2)}%`}</span>`,
                    `成交量: ${volumeText}&nbsp;&nbsp;成交额: ${amountText}`,
                    row.turnover === null ? '' : `换手率: ${row.turnover.toFixed(2)}%`,
                    maLines,
                ]
                    .filter(Boolean)
                    .join('<br>');
            },
        },
        axisPointer: {
            link: [{ xAxisIndex: 'all' }],
        },
        grid: [
            { left: 64, right: 24, top: 24, height: '56%' },
            { left: 64, right: 24, top: '74%', height: '16%' },
        ],
        xAxis: [
            {
                type: 'category',
                data: dates,
                gridIndex: 0,
                axisLine: { lineStyle: { color: '#232a38' } },
                axisLabel: { color: '#7c8698', fontSize: 11 },
                splitLine: { show: false },
                boundaryGap: true,
                axisPointer: { label: { show: false } },
            },
            {
                type: 'category',
                data: dates,
                gridIndex: 1,
                axisLine: { lineStyle: { color: '#232a38' } },
                axisLabel: { show: false },
                axisTick: { show: false },
                boundaryGap: true,
                axisPointer: {
                    label: {
                        color: '#d5d9e0',
                        backgroundColor: '#232a38',
                        formatter: (params) => params.value,
                    },
                },
            },
        ],
        yAxis: [
            {
                scale: true,
                gridIndex: 0,
                axisLabel: { color: '#7c8698', fontSize: 11 },
                splitLine: { lineStyle: { color: 'rgba(35, 42, 56, 0.6)' } },
            },
            {
                gridIndex: 1,
                axisLabel: {
                    color: '#7c8698',
                    fontSize: 10,
                    formatter: (value) => (value >= 1e4 ? `${(value / 1e4).toFixed(0)}万` : value),
                },
                splitLine: { show: false },
                splitNumber: 2,
            },
        ],
        dataZoom: [
            { type: 'inside', xAxisIndex: [0, 1], start: 40, end: 100 },
            {
                type: 'slider',
                xAxisIndex: [0, 1],
                bottom: 4,
                height: 18,
                start: 40,
                end: 100,
                borderColor: '#232a38',
                backgroundColor: 'rgba(23, 29, 41, 0.5)',
                fillerColor: 'rgba(79, 140, 255, 0.15)',
                handleStyle: { color: '#4f8cff' },
                textStyle: { color: '#7c8698', fontSize: 10 },
            },
        ],
        series: [
            {
                name: 'K线',
                type: 'candlestick',
                data: ohlc,
                xAxisIndex: 0,
                yAxisIndex: 0,
                itemStyle: {
                    color: UP_COLOR,
                    color0: DOWN_COLOR,
                    borderColor: UP_COLOR,
                    borderColor0: DOWN_COLOR,
                },
            },
            ...maPeriods.map((period, index) => ({
                name: `MA${period}`,
                type: 'line',
                data: computeMa(closes, period),
                xAxisIndex: 0,
                yAxisIndex: 0,
                smooth: true,
                symbol: 'none',
                lineStyle: { width: 1, color: MA_COLORS[index] },
            })),
            {
                name: '成交量',
                type: 'bar',
                data: volumes,
                xAxisIndex: 1,
                yAxisIndex: 1,
            },
        ],
    };
};

const renderChart = () => {
    if (!chartInstance || props.klines.length === 0) {
        return;
    }
    chartInstance.setOption(buildOption(), { notMerge: true });
};

watch(() => props.klines, renderChart);

onMounted(() => {
    chartInstance = echarts.init(chartRef.value);
    renderChart();
    resizeObserver = new ResizeObserver(() => chartInstance?.resize());
    resizeObserver.observe(chartRef.value);
});

onBeforeUnmount(() => {
    resizeObserver?.disconnect();
    chartInstance?.dispose();
    chartInstance = null;
});
</script>

<template>
    <div class="kline-chart-wrap">
        <div
            v-show="klines.length === 0"
            class="state-box"
        >
            暂无 K 线数据
        </div>
        <div
            ref="chartRef"
            class="kline-chart"
            :aria-label="`${stockName}(${stockCode}) 日K线图`"
        />
    </div>
</template>

<style scoped>
.kline-chart-wrap {
    position: relative;
    width: 100%;
}

.kline-chart {
    width: 100%;
    height: 460px;
}
</style>
