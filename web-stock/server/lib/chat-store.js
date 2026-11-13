/**
 * AI 助手会话持久化存储层（v1.5.0）：node:sqlite（主）/ JSON 文件（兜底），启动时探测后端。
 *
 * 选型沿用 config-store.js（决策见 docs/design.md D17）：
 * - 主后端 node:sqlite —— Node 内置、零第三方依赖（延续 D2 硬约束）；
 *   独立库文件 server/data/chat.db（与 config.db 分离：配置与对话数据生命周期不同）。
 * - 兜底 JSON 文件 —— 旧 Node（<22.5）自动回退 server/data/chat.json（tmp+rename 原子写）。
 *
 * 三张表：
 * - chat_sessions  会话（id/title/created_at/updated_at）
 * - chat_messages  消息（role/content/reasoning/tool_trace/stocks/trace_id）
 * - agent_traces   Agent 调用链路 trace（完整 rounds JSON，可观测看板数据源）
 *
 * 保留策略：会话数上限 MAX_SESSIONS（超限删最旧，连带其消息与 trace）；
 * trace 单条含结果预览，体积可控（resultPreview 已在 agent.js 截断）。
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'chat.db');
const JSON_FILE = path.join(DATA_DIR, 'chat.json');

/** 会话保留上限（超限删最旧会话及其消息/trace） */
const MAX_SESSIONS = 100;

/** @type {'sqlite'|'json'|null} 实际后端（initChatStore 后确定） */
let backend = null;
/** @type {import('node:sqlite').DatabaseSync|null} sqlite 句柄（json 后端时为 null） */
let db = null;
/** @type {{sessions: Array, messages: Array, traces: Array}|null} JSON 兜底后端的内存态 */
let jsonState = null;

/**
 * 尝试打开 sqlite：动态 import + 建表，任一步失败返回 null（触发 JSON 兜底）。
 * 期间静默 node:sqlite 的一次性 ExperimentalWarning（与 config-store.js 同款处理）。
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
            'CREATE TABLE IF NOT EXISTS chat_sessions (' +
                'id TEXT PRIMARY KEY, ' +
                'title TEXT NOT NULL, ' +
                'created_at TEXT NOT NULL, ' +
                'updated_at TEXT NOT NULL' +
            ');' +
            'CREATE TABLE IF NOT EXISTS chat_messages (' +
                'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
                'session_id TEXT NOT NULL, ' +
                'role TEXT NOT NULL, ' +
                'content TEXT NOT NULL, ' +
                'reasoning TEXT, ' +
                'tool_trace TEXT, ' +
                'stocks TEXT, ' +
                'trace_id TEXT, ' +
                'created_at TEXT NOT NULL' +
            ');' +
            'CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);' +
            'CREATE TABLE IF NOT EXISTS agent_traces (' +
                'id TEXT PRIMARY KEY, ' +
                'session_id TEXT NOT NULL, ' +
                'created_at TEXT NOT NULL, ' +
                'model TEXT, ' +
                'llm_rounds INTEGER, ' +
                'duration_ms INTEGER, ' +
                'data TEXT NOT NULL' +
            ');' +
            'CREATE INDEX IF NOT EXISTS idx_agent_traces_session ON agent_traces(session_id, created_at);',
        );
        return handle;
    } catch {
        return null; // 模块不可用（旧 Node / 需 flag）或建表失败 → 兜底
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

/** JSON 兜底后端：读入内存态（损坏视为空） */
async function loadJsonState() {
    try {
        const parsed = JSON.parse(await fsp.readFile(JSON_FILE, 'utf-8'));
        if (parsed && Array.isArray(parsed.sessions) && Array.isArray(parsed.messages) && Array.isArray(parsed.traces)) {
            return parsed;
        }
    } catch {
        // 文件尚不存在或损坏
    }
    return { sessions: [], messages: [], traces: [] };
}

/** JSON 兜底后端：内存态整体原子落盘（tmp+rename） */
async function flushJson() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${JSON_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(jsonState), 'utf-8');
    await fsp.rename(tmp, JSON_FILE);
}

/**
 * 初始化会话存储后端（进程启动时调用一次）。
 *
 * @returns {Promise<'sqlite'|'json'>} 实际启用的后端
 */
export async function initChatStore() {
    db = await tryOpenSqlite();
    backend = db ? 'sqlite' : 'json';
    if (!db) {
        jsonState = await loadJsonState();
    }
    return backend;
}

/** 当前存储信息（启动日志用） */
export function chatStoreInfo() {
    return { backend, path: backend === 'sqlite' ? DB_FILE : JSON_FILE };
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

function toSession(row) {
    return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * 会话列表（按最近更新降序，附消息条数）。
 *
 * @returns {Promise<Array<{id: string, title: string, createdAt: string, updatedAt: string, messageCount: number}>>}
 */
export async function listSessions() {
    if (backend === 'sqlite') {
        return db
            .prepare(
                'SELECT s.id, s.title, s.created_at, s.updated_at, ' +
                    '(SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count ' +
                    'FROM chat_sessions s ORDER BY s.updated_at DESC',
            )
            .all()
            .map((row) => ({ ...toSession(row), messageCount: Number(row.message_count) }));
    }
    return [...jsonState.sessions]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((s) => ({ ...s, messageCount: jsonState.messages.filter((m) => m.sessionId === s.id).length }));
}

/**
 * 新建会话（id 为 UUID；顺带按 MAX_SESSIONS 修剪最旧会话）。
 *
 * @param {string} [title] 会话标题（默认「新会话」，首条用户消息后由路由层更新）
 * @returns {Promise<object>} 会话对象
 */
export async function createSession(title = '') {
    const session = { id: crypto.randomUUID(), title: title || '新会话', created_at: nowIso(), updated_at: nowIso() };
    if (backend === 'sqlite') {
        db.prepare('INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
            session.id,
            session.title,
            session.created_at,
            session.updated_at,
        );
        // 修剪：保留最近 MAX_SESSIONS 个会话
        const stale = db
            .prepare('SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT -1 OFFSET ?')
            .all(MAX_SESSIONS)
            .map((row) => row.id);
        for (const id of stale) {
            deleteSessionRows(id);
        }
    } else {
        jsonState.sessions.push(toSession(session));
        const sorted = [...jsonState.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        for (const stale of sorted.slice(MAX_SESSIONS)) {
            jsonState.sessions = jsonState.sessions.filter((s) => s.id !== stale.id);
            jsonState.messages = jsonState.messages.filter((m) => m.sessionId !== stale.id);
            jsonState.traces = jsonState.traces.filter((t) => t.sessionId !== stale.id);
        }
        await flushJson();
    }
    return toSession(session);
}

/** sqlite 后端：删除会话及其消息/trace 行 */
function deleteSessionRows(sessionId) {
    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM agent_traces WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
}

/**
 * 读取单个会话。
 *
 * @param {string} sessionId
 * @returns {Promise<object|null>} 不存在返回 null
 */
export async function getSession(sessionId) {
    if (backend === 'sqlite') {
        const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(sessionId);
        return row ? toSession(row) : null;
    }
    return jsonState.sessions.find((s) => s.id === sessionId) ?? null;
}

/**
 * 更新会话标题（同时刷新 updated_at）。
 *
 * @param {string} sessionId
 * @param {string} title
 */
export async function updateSessionTitle(sessionId, title) {
    if (backend === 'sqlite') {
        db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, nowIso(), sessionId);
        return;
    }
    const session = jsonState.sessions.find((s) => s.id === sessionId);
    if (session) {
        session.title = title;
        session.updatedAt = nowIso();
        await flushJson();
    }
}

/**
 * 删除会话（连带消息与 trace）。
 *
 * @param {string} sessionId
 */
export async function deleteSession(sessionId) {
    if (backend === 'sqlite') {
        deleteSessionRows(sessionId);
        return;
    }
    jsonState.sessions = jsonState.sessions.filter((s) => s.id !== sessionId);
    jsonState.messages = jsonState.messages.filter((m) => m.sessionId !== sessionId);
    jsonState.traces = jsonState.traces.filter((t) => t.sessionId !== sessionId);
    await flushJson();
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/**
 * 追加一条消息（同时触达会话 updated_at）。
 *
 * @param {string} sessionId
 * @param {{role: 'user'|'assistant', content: string, reasoning?: string|null,
 *          toolTrace?: Array|null, stocks?: Array|null, traceId?: string|null}} message
 * @returns {Promise<object>} 落库后的消息对象
 */
export async function appendMessage(sessionId, message) {
    const createdAt = nowIso();
    const row = {
        sessionId,
        role: message.role,
        content: message.content ?? '',
        reasoning: message.reasoning ?? null,
        toolTrace: message.toolTrace ?? null,
        stocks: message.stocks ?? null,
        traceId: message.traceId ?? null,
        createdAt,
    };
    if (backend === 'sqlite') {
        db.prepare(
            'INSERT INTO chat_messages (session_id, role, content, reasoning, tool_trace, stocks, trace_id, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
            sessionId,
            row.role,
            row.content,
            row.reasoning,
            row.toolTrace ? JSON.stringify(row.toolTrace) : null,
            row.stocks ? JSON.stringify(row.stocks) : null,
            row.traceId,
            row.createdAt,
        );
        db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(createdAt, sessionId);
    } else {
        jsonState.messages.push(row);
        const session = jsonState.sessions.find((s) => s.id === sessionId);
        if (session) {
            session.updatedAt = createdAt;
        }
        await flushJson();
    }
    return row;
}

function parseMessageRow(row) {
    const safeParse = (text) => {
        if (text === null || text === undefined) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    };
    return {
        role: row.role,
        content: row.content,
        reasoning: row.reasoning ?? null,
        toolTrace: safeParse(row.toolTrace ?? row.tool_trace),
        stocks: safeParse(row.stocks),
        traceId: row.traceId ?? row.trace_id ?? null,
        createdAt: row.createdAt ?? row.created_at,
    };
}

/**
 * 会话消息列表（时间升序）。
 *
 * @param {string} sessionId
 * @param {number} [limit] 最多返回条数（取最近的 limit 条，仍按升序返回）
 * @returns {Promise<Array<object>>}
 */
export async function listMessages(sessionId, limit = 0) {
    let rows;
    if (backend === 'sqlite') {
        rows = limit > 0
            ? db
                  .prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
                  .all(sessionId, limit)
            : db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC').all(sessionId);
    } else {
        const all = jsonState.messages.filter((m) => m.sessionId === sessionId);
        rows = limit > 0 ? all.slice(-limit) : all;
    }
    return rows.map(parseMessageRow);
}

// ---------------------------------------------------------------------------
// Agent 调用链路 trace
// ---------------------------------------------------------------------------

/**
 * 保存一条 Agent trace（runAgent 完整调用链路，可观测看板数据源）。
 *
 * @param {{id?: string, sessionId: string, model: string, llmRounds: number,
 *          truncated: boolean, durationMs: number, rounds: Array, usage?: object|null}} trace
 * @returns {Promise<string>} trace id
 */
export async function saveTrace(trace) {
    const id = trace.id ?? crypto.randomUUID();
    const createdAt = nowIso();
    const data = JSON.stringify(trace);
    if (backend === 'sqlite') {
        db.prepare(
            'INSERT INTO agent_traces (id, session_id, created_at, model, llm_rounds, duration_ms, data) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
                'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        ).run(id, trace.sessionId, createdAt, trace.model ?? null, trace.llmRounds ?? null, trace.durationMs ?? null, data);
        return id;
    }
    jsonState.traces.push({
        id,
        sessionId: trace.sessionId,
        createdAt,
        model: trace.model ?? null,
        llmRounds: trace.llmRounds ?? null,
        durationMs: trace.durationMs ?? null,
        data,
    });
    await flushJson();
    return id;
}

/**
 * 读取单条 trace（含完整 rounds）。
 *
 * @param {string} traceId
 * @returns {Promise<object|null>} 不存在返回 null
 */
export async function getTrace(traceId) {
    let data;
    if (backend === 'sqlite') {
        const row = db.prepare('SELECT data FROM agent_traces WHERE id = ?').get(traceId);
        data = row?.data;
    } else {
        data = jsonState.traces.find((t) => t.id === traceId)?.data;
    }
    if (!data) {
        return null;
    }
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}
