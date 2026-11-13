/**
 * 应用配置中心（v1.4.0）：6 组配置的默认值/校验/内存热读/持久化/变更通知。
 *
 * 设计（见 docs/design.md D16）：
 * - 数据库为唯一真相源（lib/config-store.js：node:sqlite 主 / JSON 兜底）。
 * - 首次运行迁移：库为空时，用 LLM_* 环境变量或 server/llm.config.json 播种 llm 组、
 *   用 PORT 环境变量播种 server.port，保持老部署不中断；此后一切以库为准，env 仅作首跑种子。
 * - 内存态 current：启动时 defaults ← 深合并库中值；各模块经 getGroup() 同步热读（无每请求 DB 开销）。
 * - update(patch)：逐组校验 → 合并 → 持久化变更组 → 通知 onChange 监听者（采集器据此重排定时器）。
 * - 密钥安全：llm.accessToken 只存服务端，maskSecrets() 对外只暴露 accessTokenSet 布尔，绝不回显原文。
 *
 * 热生效约定：update() 用「整体替换 current」实现，故所有读取方必须在「使用时」调用 getGroup()，
 * 不可在模块加载期缓存配置引用（http/market/history/llm/agent/api 均遵循此约定）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore, loadAll, saveGroup, storeBackend, storePath } from './config-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_LLM_FILE = path.resolve(__dirname, '../llm.config.json');

/** 配置组名（顺序即设置页展示顺序） */
export const GROUPS = ['collection', 'llm', 'agent', 'cache', 'server', 'http'];

/** 数据采集类型开关的合法键（与 lib/history.js HISTORY_TYPES 对应） */
const COLLECTION_TYPES = ['limitup', 'ladder', 'hotrank', 'dragontiger'];

/** 缓存 TTL 的合法键（与 api.js 各路由一一对应） */
const CACHE_KEYS = [
    'snapshot', 'indices', 'kline', 'sectors', 'bkstocks',
    'limitup', 'ladder', 'related', 'dragontiger', 'hotrank',
];

/** 派生只读字段（对外返回但写入时忽略） */
const DERIVED_READONLY = { llm: ['accessTokenSet'] };

/** 默认配置（每次调用返回全新对象，避免共享引用被污染） */
function defaults() {
    return {
        collection: {
            enabled: true,
            intervalMinutes: 30,
            initialDelaySeconds: 5,
            dragonTigerAfterHour: 15,
            rewriteIntervalMinutes: 10,
            types: { limitup: true, ladder: true, hotrank: true, dragontiger: true },
        },
        llm: {
            enabled: true,
            modelUrl: '',
            accessToken: '', // 密钥：maskSecrets 对外隐藏
            model: '',
            timeoutMs: 90_000,
            temperature: 0.3,
            maxTokens: 2048,
        },
        agent: { maxRounds: 6, maxMessages: 30, maxContent: 4000 },
        // 收盘后默认 24h（v1.6.0，D19）：收盘后数据静态可长缓存，实际过期时间由 api.js#cacheTtl
        // 封顶到下一个交易日开盘（否则周一盘前会命中上周五旧快照）。
        // 龙虎榜例外（1h）：收盘后约 17:00 才发布，傍晚数据经历「空 → 有」变化，不宜过长。
        cache: {
            snapshot: { trading: 30, closed: 86_400 },
            indices: { trading: 30, closed: 86_400 },
            kline: { trading: 60, closed: 86_400 },
            sectors: { trading: 60, closed: 86_400 },
            bkstocks: { trading: 60, closed: 86_400 },
            limitup: { trading: 120, closed: 86_400 },
            ladder: { trading: 120, closed: 86_400 },
            related: { trading: 300, closed: 86_400 },
            dragontiger: { trading: 300, closed: 3_600 },
            hotrank: { trading: 300, closed: 86_400 },
        },
        server: { port: 8787, tradingStart: '09:15', tradingEnd: '15:05' },
        // minIntervalMs/maxConcurrent（v1.6.1，D20）：按主机限流，防上游隐性频率限制
        // （触发后返回空数据/拒绝连接）。默认同一主机相邻请求间隔 ≥100ms、并发 ≤4，
        // 快照分页（≈60 页）由此前的 6 并发瞬时突发变为平滑拉取（全量约 6–8s，TTL 30s 内可接受）。
        http: { timeoutMs: 10_000, retries: 1, retryBackoffMs: 300, minIntervalMs: 100, maxConcurrent: 4 },
    };
}

/** 配置校验/写入错误（api.js 映射为 HTTP 400） */
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

/** @type {Record<string, any>} 内存态配置（init 前为默认值） */
let current = defaults();
let initialized = false;
/** @type {Set<(snapshot: object) => void>} */
const listeners = new Set();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：以 target 为底，用 source 覆盖；缺失键保留 target（前向兼容新增字段） */
function deepMerge(target, source) {
    const out = { ...target };
    for (const [key, value] of Object.entries(source ?? {})) {
        if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key], value);
        } else {
            out[key] = typeof value === 'object' && value !== null ? structuredClone(value) : value;
        }
    }
    return out;
}

/** 逐组深合并库中值到默认值之上 */
function mergeGroups(base, stored) {
    const out = base;
    for (const group of GROUPS) {
        if (isPlainObject(stored?.[group])) {
            out[group] = deepMerge(out[group], stored[group]);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// 字段校验原语（错误信息为中文，含字段路径）
// ---------------------------------------------------------------------------

function reqBool(value, fieldPath) {
    if (typeof value !== 'boolean') {
        throw new ConfigError(`${fieldPath} 必须为布尔值（true/false）`);
    }
    return value;
}

function reqInt(value, fieldPath, min, max) {
    const num = Number(value);
    if (!Number.isInteger(num)) {
        throw new ConfigError(`${fieldPath} 必须为整数`);
    }
    if (num < min || num > max) {
        throw new ConfigError(`${fieldPath} 取值范围 ${min}–${max}`);
    }
    return num;
}

function reqNum(value, fieldPath, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw new ConfigError(`${fieldPath} 必须为数字`);
    }
    if (num < min || num > max) {
        throw new ConfigError(`${fieldPath} 取值范围 ${min}–${max}`);
    }
    return num;
}

function reqStr(value, fieldPath, maxLen) {
    if (typeof value !== 'string') {
        throw new ConfigError(`${fieldPath} 必须为字符串`);
    }
    const trimmed = value.trim();
    if (maxLen && trimmed.length > maxLen) {
        throw new ConfigError(`${fieldPath} 长度不超过 ${maxLen} 字符`);
    }
    return trimmed;
}

function reqHHMM(value, fieldPath) {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
        throw new ConfigError(`${fieldPath} 必须为 HH:MM（24 小时制，如 09:15）`);
    }
    return value.trim();
}

/** 允许空串（未配置）；非空时须为合法 http(s) 地址 */
function reqUrl(value, fieldPath) {
    const text = String(value ?? '').trim();
    if (text === '') {
        return '';
    }
    try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('bad protocol');
        }
    } catch {
        throw new ConfigError(`${fieldPath} 必须为合法的 http(s) 地址`);
    }
    return text;
}

// ---------------------------------------------------------------------------
// 各组合并 + 校验（dst 为 current 的克隆，原地改写；src 为请求补丁）
// ---------------------------------------------------------------------------

function mergeCollection(dst, src) {
    const p = 'collection';
    for (const [key, value] of Object.entries(src)) {
        if (key === 'types') {
            if (!isPlainObject(value)) {
                throw new ConfigError(`${p}.types 必须为对象`);
            }
            for (const [typeKey, typeVal] of Object.entries(value)) {
                if (!COLLECTION_TYPES.includes(typeKey)) {
                    throw new ConfigError(`${p}.types 含未知采集类型: ${typeKey}（可选: ${COLLECTION_TYPES.join('/')}）`);
                }
                dst.types[typeKey] = reqBool(typeVal, `${p}.types.${typeKey}`);
            }
            continue;
        }
        switch (key) {
            case 'enabled': dst.enabled = reqBool(value, `${p}.enabled`); break;
            case 'intervalMinutes': dst.intervalMinutes = reqInt(value, `${p}.intervalMinutes`, 1, 1440); break;
            case 'initialDelaySeconds': dst.initialDelaySeconds = reqInt(value, `${p}.initialDelaySeconds`, 0, 600); break;
            case 'dragonTigerAfterHour': dst.dragonTigerAfterHour = reqInt(value, `${p}.dragonTigerAfterHour`, 0, 23); break;
            case 'rewriteIntervalMinutes': dst.rewriteIntervalMinutes = reqInt(value, `${p}.rewriteIntervalMinutes`, 1, 1440); break;
            default: throw new ConfigError(`${p} 含未知字段: ${key}`);
        }
    }
}

function mergeLlm(dst, src) {
    const p = 'llm';
    for (const [key, value] of Object.entries(src)) {
        if ((DERIVED_READONLY.llm ?? []).includes(key)) {
            continue; // accessTokenSet 等派生字段：写入时忽略
        }
        switch (key) {
            case 'enabled': dst.enabled = reqBool(value, `${p}.enabled`); break;
            case 'modelUrl': dst.modelUrl = reqUrl(value, `${p}.modelUrl`); break;
            case 'accessToken': {
                // 密钥语义：缺省=不变（dst 已含旧值）；''=清除；非空=设置
                if (typeof value !== 'string') {
                    throw new ConfigError(`${p}.accessToken 必须为字符串`);
                }
                dst.accessToken = value.trim();
                break;
            }
            case 'model': dst.model = reqStr(value, `${p}.model`, 200); break;
            case 'timeoutMs': dst.timeoutMs = reqInt(value, `${p}.timeoutMs`, 5_000, 600_000); break;
            case 'temperature': dst.temperature = reqNum(value, `${p}.temperature`, 0, 2); break;
            case 'maxTokens': dst.maxTokens = reqInt(value, `${p}.maxTokens`, 256, 32_768); break;
            default: throw new ConfigError(`${p} 含未知字段: ${key}`);
        }
    }
}

function mergeAgent(dst, src) {
    const p = 'agent';
    for (const [key, value] of Object.entries(src)) {
        switch (key) {
            case 'maxRounds': dst.maxRounds = reqInt(value, `${p}.maxRounds`, 1, 20); break;
            case 'maxMessages': dst.maxMessages = reqInt(value, `${p}.maxMessages`, 1, 200); break;
            case 'maxContent': dst.maxContent = reqInt(value, `${p}.maxContent`, 100, 100_000); break;
            default: throw new ConfigError(`${p} 含未知字段: ${key}`);
        }
    }
}

function mergeCache(dst, src) {
    const p = 'cache';
    for (const [key, value] of Object.entries(src)) {
        if (!CACHE_KEYS.includes(key)) {
            throw new ConfigError(`${p} 含未知缓存键: ${key}（可选: ${CACHE_KEYS.join('/')}）`);
        }
        if (!isPlainObject(value)) {
            throw new ConfigError(`${p}.${key} 必须为对象 { trading, closed }`);
        }
        for (const [subKey, subVal] of Object.entries(value)) {
            if (subKey !== 'trading' && subKey !== 'closed') {
                throw new ConfigError(`${p}.${key} 含未知字段: ${subKey}（仅 trading/closed）`);
            }
            // trading 上限 2h（盘中时效性要求）；closed 上限 24h（v1.6.0，实际过期仍封顶到下一交易日开盘）
            const max = subKey === 'closed' ? 86_400 : 7_200;
            dst[key][subKey] = reqInt(subVal, `${p}.${key}.${subKey}`, 5, max);
        }
    }
}

function mergeServer(dst, src) {
    const p = 'server';
    for (const [key, value] of Object.entries(src)) {
        switch (key) {
            case 'port': dst.port = reqInt(value, `${p}.port`, 1, 65_535); break;
            case 'tradingStart': dst.tradingStart = reqHHMM(value, `${p}.tradingStart`); break;
            case 'tradingEnd': dst.tradingEnd = reqHHMM(value, `${p}.tradingEnd`); break;
            default: throw new ConfigError(`${p} 含未知字段: ${key}`);
        }
    }
    if (dst.tradingStart >= dst.tradingEnd) {
        throw new ConfigError(`${p}.tradingStart 必须早于 tradingEnd`);
    }
}

function mergeHttp(dst, src) {
    const p = 'http';
    for (const [key, value] of Object.entries(src)) {
        switch (key) {
            case 'timeoutMs': dst.timeoutMs = reqInt(value, `${p}.timeoutMs`, 1_000, 120_000); break;
            case 'retries': dst.retries = reqInt(value, `${p}.retries`, 0, 5); break;
            case 'retryBackoffMs': dst.retryBackoffMs = reqInt(value, `${p}.retryBackoffMs`, 0, 10_000); break;
            case 'minIntervalMs': dst.minIntervalMs = reqInt(value, `${p}.minIntervalMs`, 0, 10_000); break;
            case 'maxConcurrent': dst.maxConcurrent = reqInt(value, `${p}.maxConcurrent`, 1, 32); break;
            default: throw new ConfigError(`${p} 含未知字段: ${key}`);
        }
    }
}

const MERGERS = {
    collection: mergeCollection,
    llm: mergeLlm,
    agent: mergeAgent,
    cache: mergeCache,
    server: mergeServer,
    http: mergeHttp,
};

// ---------------------------------------------------------------------------
// 首跑播种（env / llm.config.json → 库）
// ---------------------------------------------------------------------------

/** 读取 legacy LLM 配置（env 优先于 llm.config.json），无有效值返回 null */
function readLegacyLlmSeed() {
    let file = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(LEGACY_LLM_FILE, 'utf-8'));
        file = {
            modelUrl: String(parsed.modelUrl ?? parsed.model_url ?? '').trim(),
            accessToken: String(parsed.accessToken ?? parsed.access_token ?? '').trim(),
            model: String(parsed.model ?? '').trim(),
        };
    } catch {
        file = {};
    }
    const seed = {};
    const modelUrl = (process.env.LLM_MODEL_URL ?? file.modelUrl ?? '').trim();
    const accessToken = (process.env.LLM_ACCESS_TOKEN ?? file.accessToken ?? '').trim();
    const model = (process.env.LLM_MODEL ?? file.model ?? '').trim();
    if (modelUrl) seed.modelUrl = modelUrl;
    if (accessToken) seed.accessToken = accessToken;
    if (model) seed.model = model;
    return Object.keys(seed).length > 0 ? seed : null;
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 初始化配置（进程启动时调用一次，须在监听请求/启动采集器之前 await）。
 * 探测存储后端 → 载入并深合并默认值 → 首跑播种 → 落定内存态。
 *
 * @returns {Promise<Record<string, any>>} 生效配置（含密钥，内部用）
 */
export async function init() {
    if (initialized) {
        return current;
    }
    await initStore();
    const stored = await loadAll();
    const merged = mergeGroups(defaults(), stored);

    // 首跑播种：库中无 llm 组时，用 env/llm.config.json 迁移
    if (!isPlainObject(stored.llm)) {
        const seed = readLegacyLlmSeed();
        if (seed) {
            Object.assign(merged.llm, seed);
            await saveGroup('llm', merged.llm);
        }
    }
    // 首跑播种：库中无 server 组且设置了 PORT 环境变量时，用其播种端口
    if (!isPlainObject(stored.server) && process.env.PORT) {
        const port = Number(process.env.PORT);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) {
            merged.server.port = port;
            await saveGroup('server', merged.server);
        }
    }

    current = merged;
    initialized = true;
    return current;
}

/** 生效配置全量（含密钥，仅服务端内部使用；对外接口须经 maskSecrets） */
export function getConfig() {
    return current;
}

/**
 * 读取某配置组（使用时调用，勿在模块加载期缓存引用，否则热更新失效）。
 *
 * @param {string} name GROUPS 之一
 * @returns {any} 该组对象（内存活引用，只读使用）
 */
export function getGroup(name) {
    return current[name];
}

/**
 * 脱敏：隐藏 llm.accessToken 原文，改为 accessTokenSet 布尔（对外响应专用）。
 *
 * @param {Record<string, any>} cfg 含密钥的配置
 * @returns {Record<string, any>} 可安全下发的副本
 */
export function maskSecrets(cfg) {
    const out = structuredClone(cfg);
    if (out.llm) {
        out.llm.accessTokenSet = Boolean(out.llm.accessToken);
        delete out.llm.accessToken;
    }
    return out;
}

/**
 * 校验并应用配置补丁，持久化变更组，通知监听者。
 *
 * @param {Record<string, any>} patch { 组名: { 字段: 值 } }（可只含部分组/字段）
 * @returns {Promise<Record<string, any>>} 更新后的脱敏配置
 * @throws {ConfigError} 未知组/字段或取值非法（api.js → 400）
 */
export async function update(patch) {
    if (!isPlainObject(patch)) {
        throw new ConfigError('请求体必须为 JSON 对象（{ 组名: { 字段: 值 } }）');
    }
    const next = structuredClone(current);
    const changed = [];
    for (const [group, fields] of Object.entries(patch)) {
        if (!GROUPS.includes(group)) {
            throw new ConfigError(`未知配置组: ${group}（可选: ${GROUPS.join('/')}）`);
        }
        if (!isPlainObject(fields)) {
            throw new ConfigError(`配置组 ${group} 必须为对象`);
        }
        MERGERS[group](next[group], fields);
        if (!changed.includes(group)) {
            changed.push(group);
        }
    }
    for (const group of changed) {
        await saveGroup(group, next[group]);
    }
    current = next;
    notify();
    return maskSecrets(structuredClone(current));
}

/**
 * 注册配置变更监听器（采集器据此重排定时器）。
 *
 * @param {(snapshot: object) => void} fn 回调（入参为脱敏快照，通常无需使用，直接 getGroup 重读即可）
 * @returns {() => void} 取消注册
 */
export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify() {
    const snapshot = maskSecrets(structuredClone(current));
    for (const fn of listeners) {
        try {
            fn(snapshot);
        } catch (error) {
            console.warn(`[config] 变更监听器异常: ${error.message}`);
        }
    }
}

/** 存储后端信息（启动日志用） */
export function storeInfo() {
    return { backend: storeBackend(), path: storePath() };
}
