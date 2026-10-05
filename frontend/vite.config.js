var _a;
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
// Frontend dev-сервер проксирует /api на backend, поэтому в браузере
// используется тот же origin и cookie/токен работают без CORS-настройки.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
        port: 5173,
        strictPort: false,
        proxy: {
            '/api': {
                target: (_a = process.env.VITE_API_TARGET) !== null && _a !== void 0 ? _a : 'http://127.0.0.1:3001',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
    },
});
