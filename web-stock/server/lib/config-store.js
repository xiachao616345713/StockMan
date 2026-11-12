/**
 * 配置持久化存储层（v1.4.0）：node:sqlite（主）/ JSON 文件（兜底），启动时探测后端。
 *
 * 选型（决策见 docs/design.md D16）：
 * - 主后端 node:sqlite —— Node 内置、零第三方依赖（延续 D2 硬约束），是真正的关系库；
 *   Node ≥22.5 可用（本机 v24 已验证），首次加载会打印一次 ExperimentalWarning（下方静默）。
 * - 兜底 JSON 文件 —— 旧 Node（<22.5）无 node:sqlite 时自动回退，保证 `npm start` 在 Node ≥18 仍可运行；
 *   写法复用 lib/history.js 的原子写（tmp + rename）。
 *
 * 存储粒度：一行一个「配置组」（collection/llm/agent/cache/server/http），value 为该组 JSON。
 * 文件均落在 server/data/（已 gitignore），llm.accessToken 等敏感值不会进入版本库。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'config.db');
const JSON_FILE = path.join(DATA_DIR, 'config.json');

/** @type {'sqlite'|'json'|null} 实际后端（initStore 后确定） */
let backend = null;
/** @type {import('node:sqlite').DatabaseSync|null} sqlite 句柄（json 后端时为 null） */
let db = null;

/**
 * 尝试打开 sqlite：动态 import + 建表，任一步失败返回 null（触发 JSON 兜底）。
 * 期间静默 node:sqlite 的一次性 ExperimentalWarning，避免污染启动日志。
 */
async function tryOpenSqlite() {
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = (warning, ...args) => {
        const message = typeof warning === 'string' ? warning : warning?.message;
        if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) {
            return; // 仅吞掉这一条已知告警
        }
        return originalEmitWarning.call(process, warning, ...args);
    };
    try {
        const { DatabaseSync } = await import('node:sqlite');
        await fsp.mkdir(DATA_DIR, { recursive: true });
        const handle = new DatabaseSync(DB_FILE);
        handle.exec(
            'CREATE TABLE IF NOT EXISTS app_config (' +
                'key TEXT PRIMARY KEY, ' +
                'value TEXT NOT NULL, ' +
                'updated_at TEXT NOT NULL' +
            ')',
        );
        return handle;
    } catch {
        return null; // 模块不可用（旧 Node / 需 flag）或建表失败 → 兜底
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

/**
 * 初始化存储后端（进程启动时调用一次）。
 *
 * @returns {Promise<'sqlite'|'json'>} 实际启用的后端
 */
export async function initStore() {
    db = await tryOpenSqlite();
    backend = db ? 'sqlite' : 'json';
    if (!db) {
        await fsp.mkdir(DATA_DIR, { recursive: true });
    }
    return backend;
}

/** 当前后端类型（启动日志用） */
export function storeBackend() {
    return backend;
}

/** 当前后端对应的落盘文件路径（启动日志用） */
export function storePath() {
    return backend === 'sqlite' ? DB_FILE : JSON_FILE;
}

/**
 * 读取全部配置组。
 *
 * @returns {Promise<Record<string, any>>} { 组名: 组对象 }；损坏/缺失的组被跳过
 */
export async function loadAll() {
    if (backend === 'sqlite' && db) {
        const rows = db.prepare('SELECT key, value FROM app_config').all();
        const out = {};
        for (const row of rows) {
            try {
                out[row.key] = JSON.parse(row.value);
            } catch {
                // 单组损坏跳过，由上层用默认值兜底
            }
        }
        return out;
    }
    try {
        const parsed = JSON.parse(await fsp.readFile(JSON_FILE, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {}; // 文件尚不存在
    }
}

/**
 * 持久化单个配置组（覆盖写）。
 *
 * @param {string} key 组名
 * @param {any} value 组对象（JSON 序列化后落盘）
 * @returns {Promise<void>}
 */
export async function saveGroup(key, value) {
    const json = JSON.stringify(value);
    const now = new Date().toISOString();
    if (backend === 'sqlite' && db) {
        db.prepare(
            'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(key, json, now);
        return;
    }
    // JSON 兜底：读-改-写整文件 + 原子替换
    let all = {};
    try {
        const parsed = JSON.parse(await fsp.readFile(JSON_FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            all = parsed;
        }
    } catch {
        all = {};
    }
    all[key] = value;
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${JSON_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
    await fsp.rename(tmp, JSON_FILE);
}
