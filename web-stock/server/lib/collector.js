/**
 * 历史归档采集器调度（v1.4.0）：持有定时器，按 config.collection 排程，配置变更时热重排。
 *
 * 取代 index.js 内联的 setTimeout(5s)+setInterval(30min)：
 * - start()：读 config.collection 排程（enabled=false 则不排程）；并注册 config.onChange，
 *   当 开关/周期/首跑延时 变化时重建定时器（其余配置组变更不触发重排）。
 * - 采集逻辑仍复用 api.js#collectHistory（其内部再按 config 决定采集哪些类型）。
 *
 * 依赖方向：collector → {config, api}；api 不反向依赖 collector（无循环）。
 */

import { getGroup, onChange } from './config.js';
import { collectHistory } from '../api.js';

/** @type {NodeJS.Timeout|null} 首跑延时定时器 */
let startTimer = null;
/** @type {NodeJS.Timeout|null} 周期定时器 */
let intervalTimer = null;
/** 当前排程签名（用于判断是否需要重排） */
let scheduledSignature = '';

function signatureOf(collection) {
    return `${collection.enabled}|${collection.intervalMinutes}|${collection.initialDelaySeconds}`;
}

function clearTimers() {
    if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
    }
    if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
    }
}

/** 按当前 config.collection 重建定时器（幂等） */
function schedule() {
    clearTimers();
    const collection = getGroup('collection');
    scheduledSignature = signatureOf(collection);

    if (!collection.enabled) {
        console.log('[collector] 数据采集已关闭（config.collection.enabled = false）');
        return;
    }
    const runOnce = () => {
        collectHistory().catch((error) => console.warn(`[history] 采集轮异常: ${error.message}`));
    };
    const delayMs = Math.max(0, collection.initialDelaySeconds) * 1000;
    const intervalMs = Math.max(1, collection.intervalMinutes) * 60_000;
    startTimer = setTimeout(runOnce, delayMs);
    intervalTimer = setInterval(runOnce, intervalMs);
    console.log(`[collector] 已排程：${collection.initialDelaySeconds}s 后首跑，每 ${collection.intervalMinutes}min 一轮`);
}

/**
 * 启动采集器（index.js 在 config.init() 之后调用）。
 * 注册配置变更监听：仅当采集相关签名变化时重排。
 */
export function start() {
    schedule();
    onChange(() => {
        const collection = getGroup('collection');
        if (signatureOf(collection) !== scheduledSignature) {
            schedule();
        }
    });
}

/** 停止采集器（测试/优雅退出口预留） */
export function stop() {
    clearTimers();
}
