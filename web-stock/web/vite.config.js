import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 开发模式下将 /api 代理到本地 Node 后端（默认 8787）
export default defineConfig({
    plugins: [vue()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:8787',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        chunkSizeWarningLimit: 1200,
    },
});
