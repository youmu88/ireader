import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192x192.png', 'icon-512x512.png'],
      manifest: {
        name: 'iReader - 图书阅读与听书',
        short_name: 'iReader',
        description: '离线阅读与听书应用',
        theme_color: '#3b82f6',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            // 缓存 API 封面图片请求：网络优先 + 缓存回退
            urlPattern: /^\/api\/books\/[^/]+\/cover/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ireader-covers',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
              backgroundSync: { name: 'ireader-cover-sync' },
            },
          },
          {
            // 缓存书籍文件请求（用于 EPUB 在线阅读）
            urlPattern: /^\/api\/books\/[^/]+\/file/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ireader-book-files',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // 缓存在先 TTS 音频（WAV 数据流）
            urlPattern: /^\/api\/tts/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'ireader-tts',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
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
  },
});
