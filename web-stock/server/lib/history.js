/**
 * 历史数据归档层（v1.3.0）：涨停池 / 热榜 / 龙虎榜 / 连板天梯 按交易日落盘 JSON。
 *
 * 存储选型（决策见 docs/design.md D15）：server/data/{type}/{yyyyMMdd}.json 纯文件，
 * 零第三方依赖、无 Node 版本要求（node:sqlite 需 ≥22.5 且为实验特性）；
 * 数据量 ≈100–300 行/天/类型，查询为小窗口内存 join，文件存储完全够用且可直接人工检视。
 *
 * 写入路径：
 * 1. write-through：api.js 各路由成功获取数据后节流落盘（同 key ≥10min 才重写，盘中数据可随采集器刷新）
 * 2. 采集器：index.js 定时调用 api.js#collectHistory（复用路由与缓存，归档当日数据）
 *
 * 注意：热榜/龙虎榜为「抓取时刻」快照；热榜上游不支持按日期回补，归档只能自启用之日起向前累积。
 * 涨停池/龙虎榜支持 date 参数，历史缺口可由 Agent 工具经 invokeRoute 回补（回补同样触发 write-through）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGroup } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

/** 归档数据类型 */
export const HISTORY_TYPES = ['limitup', 'hotrank', 'dragontiger', 'ladder'];

/** 同一 (type,date) 的最小重写间隔（盘中数据会变化，允许采集器周期性覆盖；取自 config.collection.rewriteIntervalMinutes，v1.4.0） */
function rewriteIntervalMs() {
    return getGroup('collection').rewriteIntervalMinutes * 60_000;
}

/** @type {Map<string, number>} key → 上次落盘时间戳（进程内节流，重启后首次必写） */
const lastWrite = new Map();

function isValidType(type) {
    return HISTORY_TYPES.includes(type);
}

function isValidDate8(date8) {
    return /^\d{8}$/.test(String(date8 ?? ''));
}

function fileOf(type, date8) {
    return path.join(DATA_DIR, type, `${date8}.json`);
}

/**
 * 节流落盘：首次立即写；同 key 10 分钟内重复调用跳过（内容通常未变）。
 * fire-and-forget 语义：调用方无需 await 成功与否，归档失败不影响接口响应。
 *
 * @param {string} type HISTORY_TYPES 之一
 * @param {string} date8 交易日 yyyyMMdd（热榜为抓取日）
 * @param {any} data 路由返回的完整 data（含 source/summary 等元信息，便于事后判断口径）
 * @returns {Promise<boolean>} 是否实际写入
 */
export async function saveRecordThrottled(type, date8, data) {
    if (!isValidType(type) || !isValidDate8(date8)) {
        return false;
    }
    const key = `${type}:${date8}`;
    const now = Date.now();
    const prev = lastWrite.get(key);
    if (prev !== undefined && now - prev < rewriteIntervalMs()) {
        return false;
    }
    lastWrite.set(key, now); // 先占位，失败不回滚（下轮采集重试即可）

    const file = fileOf(type, date8);
    const tmp = `${file}.tmp`;
    const payload = JSON.stringify({ type, date: date8, savedAt: new Date(now).toISOString(), data });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, payload, 'utf-8');
    await fsp.rename(tmp, file); // 原子替换，避免读到半截 JSON
    return true;
}

/**
 * 读取某日归档
 *
 * @returns {Promise<any|null>} 归档 data 字段；不存在或损坏返回 null
 */
export async function loadRecord(type, date8) {
    if (!isValidType(type) || !isValidDate8(date8)) {
        return null;
    }
    try {
        const parsed = JSON.parse(await fsp.readFile(fileOf(type, date8), 'utf-8'));
        return parsed?.data ?? null;
    } catch {
        return null;
    }
}

/** 某类型已归档的全部日期（升序 yyyyMMdd） */
export async function listDates(type) {
    if (!isValidType(type)) {
        return [];
    }
    try {
        const files = await fsp.readdir(path.join(DATA_DIR, type));
        return files
            .filter((name) => /^\d{8}\.json$/.test(name))
            .map((name) => name.slice(0, 8))
            .sort();
    } catch {
        return []; // 目录尚不存在
    }
}

/** 归档概览：各类型的 条数/最早/最近/最近5个日期（Agent history_overview 工具用） */
export async function archiveOverview() {
    const overview = {};
    for (const type of HISTORY_TYPES) {
        const dates = await listDates(type);
        overview[type] = {
            days: dates.length,
            earliest: dates[0] ?? null,
            latest: dates[dates.length - 1] ?? null,
            recentDates: dates.slice(-5),
        };
    }
    return overview;
}

/**
 * 最近 N 个自然日的日期列表（含今天，降序）
 *
 * @param {number} days 1–120
 * @param {string} [endDate8] 截止日（默认今天，上海时区）
 */
export function recentCalendarDates(days, endDate8) {
    const end = endDate8 ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '');
    const base = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)), 12);
    const dates = [];
    for (let i = 0; i < days; i += 1) {
        dates.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10).replaceAll('-', ''));
    }
    return dates;
}

/**
 * 最近 N 个「工作日」的日期列表（跳过周末，不识别节假日；含今天，降序）。
 * 节假日查询上游返回空列表，归档跳过空数据，不影响正确性。
 */
export function recentWeekdayDates(days, endDate8) {
    const end = endDate8 ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replaceAll('-', '');
    const base = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8)), 12);
    const dates = [];
    for (let i = 0; dates.length < days && i < days * 2 + 10; i += 1) {
        const d = new Date(base - i * 86_400_000);
        const weekday = d.getUTCDay();
        if (weekday !== 0 && weekday !== 6) {
            dates.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
        }
    }
    return dates;
}

/** 归档目录（启动日志/文档用） */
export function dataDir() {
    return DATA_DIR;
}

/** 同步检查归档目录是否存在（index.js 启动日志用） */
export function isDataDirPresent() {
    return fs.existsSync(DATA_DIR);
}
