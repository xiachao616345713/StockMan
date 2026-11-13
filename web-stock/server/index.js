/**
 * web-stock 服务入口：
 * - /api/*  → api.js 路由（代理上游行情接口）
 * - 其他路径 → 托管 ../web/dist 前端静态资源（未构建时返回引导提示）
 *
 * 启动：node server/index.js（或 npm start），端口默认 8787，可用 PORT 环境变量覆盖。
 * 零第三方依赖，要求 Node >= 18（内置 fetch）。
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from './api.js';
import { clearCache, cacheSize } from './lib/cache.js';
import { dataDir, isDataDirPresent } from './lib/history.js';
import { init as initConfig, getGroup, storeInfo } from './lib/config.js';
import { initChatStore, chatStoreInfo } from './lib/chat-store.js';
import { start as startCollector } from './lib/collector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, '../web/dist');

// 配置初始化：探测存储后端（sqlite/JSON）、载入库中值并深合并默认、首跑播种 env。
// 必须在读取 PORT、启动采集器之前 await（顶层 await 会暂停后续语句直至完成）。
await initConfig();

// AI 助手会话存储初始化（v1.5.0）：node:sqlite（chat.db）/ JSON 兜底，与配置存储同款探测
await initChatStore();

// 端口：env.PORT 为部署期覆盖（优先级最高），否则取配置库 server.port（设置页可改，需重启生效）
const PORT = Number(process.env.PORT) || getGroup('server').port;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    try {
        if (url.pathname.startsWith('/api/')) {
            if (url.pathname === '/api/cache' && req.method === 'DELETE') {
                clearCache();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            const handled = await handleApiRequest(req, res, url);
            if (!handled) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: { status: 404, message: `未知接口 ${url.pathname}` } }));
            }
            return;
        }
        await serveStatic(url.pathname, res);
    } catch (error) {
        console.error('[server] 未处理异常:', error);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { status: 500, message: '服务器内部错误' } }));
        } else {
            res.end();
        }
    }
});

/** 静态资源服务（含路径穿越防护） */
async function serveStatic(pathname, res) {
    if (!fs.existsSync(WEB_DIST)) {
        respondText(res, 200, [
            'web-stock server 已启动（API 可用：/api/health）。',
            '前端尚未构建：请先执行 cd web && npm install && npm run build，',
            '或使用开发模式：cd web && npm run dev（Vite 已配置 /api 代理到本服务）。',
        ].join('\n'));
        return;
    }
    const decoded = decodeURIComponent(pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.resolve(WEB_DIST, relative);
    if (!filePath.startsWith(WEB_DIST)) {
        respondText(res, 403, 'Forbidden');
        return;
    }
    try {
        const stat = await fsp.stat(filePath);
        if (stat.isDirectory()) {
            throw new Error('is directory');
        }
        const ext = path.extname(filePath).toLowerCase();
        const content = await fsp.readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
            'Content-Length': content.length,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
        });
        res.end(content);
    } catch {
        // SPA 兜底：未命中的路径返回 index.html
        try {
            const indexHtml = await fsp.readFile(path.join(WEB_DIST, 'index.html'));
            res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Content-Length': indexHtml.length });
            res.end(indexHtml);
        } catch {
            respondText(res, 404, 'Not Found');
        }
    }
}

function respondText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

server.listen(PORT, () => {
    const store = storeInfo();
    const chatStore = chatStoreInfo();
    console.log(`web-stock server 已启动: http://localhost:${PORT}`);
    console.log(`API 示例: http://localhost:${PORT}/api/health`);
    console.log(`配置存储: ${store.backend}${store.backend === 'json' ? '（node:sqlite 不可用，已回退 JSON）' : ''} → ${store.path}`);
    console.log(`会话存储: ${chatStore.backend} → ${chatStore.path}`);
    console.log(`前端目录: ${WEB_DIST}${fs.existsSync(WEB_DIST) ? '' : '（尚未构建）'}`);
    console.log(`缓存条目: ${cacheSize()}`);
    console.log(`历史归档目录: ${dataDir()}${isDataDirPresent() ? '' : '（首次采集时自动创建）'}`);

    // 历史归档采集器：按 config.collection 排程（开关/周期/首跑延时），配置变更时热重排（见 lib/collector.js）
    startCollector();
});
