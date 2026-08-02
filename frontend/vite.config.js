import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:10000',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        // 兼容旧浏览器：降低目标到 es2015（支持 Safari 9+ / iOS 9+）
        target: 'es2015',
        // manualChunks：高频第三方库独立成 chunk，利用浏览器长缓存（应用更新不失效）
        rollupOptions: {
            output: {
                manualChunks: function (id) {
                    // 仅处理 node_modules 中的模块；忽略 styles.css 旁路
                    if (!id.includes('node_modules'))
                        return;
                    // react / react-dom 生态
                    if (id.includes('/react/') ||
                        id.includes('/react-dom/') ||
                        id.includes('/scheduler/') ||
                        id.includes('/react-is/') ||
                        id.includes('@types/react')) {
                        return 'react-vendor';
                    }
                    // react-router 生态
                    if (id.includes('/react-router/') || id.includes('/react-router-dom/')) {
                        return 'router-vendor';
                    }
                    // 其余第三方库统一进入 vendor（可选拆分，避免切分过碎）
                    return 'vendor';
                },
            },
        },
    },
});
