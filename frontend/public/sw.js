/**
 * iReader Service Worker
 *
 * 离线缓存策略：
 * 1. 安装时预缓存 App Shell（/ 与 /index.html）
 * 2. 导航请求：网络优先（NetworkFirst）；网络失败或 5xx 时回退缓存副本，保障弱网/宕机可用
 * 3. 静态资源：缓存优先 + 后台更新（StaleWhileRevalidate，Vite hash 资源无版本问题）
 * 4. 封面图片：网络优先 + 缓存回退（NetworkFirst）
 * 5. API 数据：不拦截（离线数据由 IndexedDB 缓存层负责）
 *
 * ⚠️ 版本规则：CACHE_VERSION 由构建期脚本 scripts/inject-sw-version.mjs
 *    从 src/version.ts 自动注入 dist/sw.js（无需手工 bump）。
 *    SW 更新检测基于文件字节差异——版本变化会触发 install 重装与旧缓存清理。
 */

// 源文件占位值；发布产物 dist/sw.js 由构建期注入真实版本（v<APP_VERSION>）
const CACHE_VERSION = 'dev';
const STATIC_CACHE = `ireader-static-${CACHE_VERSION}`;
const COVERS_CACHE = `ireader-covers-${CACHE_VERSION}`;

// 需要预缓存的静态资源（构建后 Vite 生成）
const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// ── 安装：预缓存关键页面 ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      // 逐个缓存而非 addAll（addAll 原子失败，一个失败全挂）
      return Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch(() => {
            console.log(`[SW] 预缓存 ${url} 跳过（可能尚不存在）`);
          })
        )
      );
    }).then(() => {
      console.log('[SW] 预缓存完成');
    })
  );
  self.skipWaiting();
});

// ── 激活：清理旧缓存 ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('ireader-') && !name.endsWith(CACHE_VERSION))
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ── 判断请求类型 ──
function isStaticAsset(url) {
  const extensions = ['.js', '.css', '.html', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf'];
  return extensions.some((ext) => url.pathname.endsWith(ext));
}

function isCoverImage(url) {
  return /^\/api\/books\/[^/]+\/cover/.test(url.pathname);
}

// ── 导航请求：离线时返回缓存的 App Shell ──
function isNavigateRequest(event) {
  return event.request.mode === 'navigate';
}

// ── 响应：离线缓存策略 ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

// ⭐ 导航请求（页面级跳转）：网络优先（NetworkFirst）
//    在线时总是返回网络最新 index.html 并更新缓存；网络失败或 5xx 时回退缓存/离线 HTML。
if (isNavigateRequest(event)) {
  const fallbackToCache = () =>
    caches.match('/index.html').then((cached) => {
      if (cached) return cached;
      return new Response(
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>iReader - 离线模式</title></head><body><div id="root"><div style="padding:40px;text-align:center;color:#666;font-family:sans-serif"><h2>📚 iReader 离线模式</h2><p>正在从本地缓存加载书籍数据...</p><p style="font-size:12px;color:#999;margin-top:20px">请确保您已预先缓存书籍</p></div></div></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    });
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 5xx（后端/网关故障）同样回退缓存副本，避免用户看到服务器错误页
        if (response && response.status >= 500) return fallbackToCache();
        if (response && response.status === 200) {
          caches.open(STATIC_CACHE).then((cache) => cache.put('/index.html', response.clone()));
        }
        return response;
      })
      .catch(fallbackToCache)
  );
  return;
}

  // 静态资源：过期缓存 + 后台更新（StaleWhileRevalidate）
  // ✅ 修复：CacheFirst → StaleWhileRevalidate
  //    用户立即看到缓存版本，同时后台静默下载最新版并更新缓存
  //    解决了 PWA 模式下用户永远看不到新版代码的问题
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) => {
        return cache.match(event.request).then((cached) => {
          // 并发：返回缓存 + 后台网络请求更新缓存
          const fetchPromise = fetch(event.request).then((response) => {
            if (response && response.status === 200) {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => {
            // 网络失败且无缓存：仅 HTML 类请求可回退 App Shell；
            // JS/CSS/字体等按扩展名路径返回 404，避免把 index.html 当脚本/样式返回（MIME 错误）
            if (url.pathname.endsWith('.html')) return caches.match('/index.html');
            return new Response('', { status: 404, statusText: 'Offline: asset not cached' });
          });
          // 优先返回缓存，同时后台发起网络请求更新缓存
          return cached || fetchPromise;
        });
      })
    );
    return;
  }

  // 封面图片：网络优先 + 缓存回退（NetworkFirst）
  if (isCoverImage(url)) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(COVERS_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // 兜底：返回内置占位图
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300"><rect fill="#e5e7eb" width="200" height="300"/><text fill="#9ca3af" font-size="14" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">暂无封面</text></svg>',
            { headers: { 'Content-Type': 'image/svg+xml' } }
          );
        });
      })
    );
    return;
  }

  // 其他 API：网络优先（不作缓存回退 API 数据，由 IndexedDB 处理）
  // 不拦截，让正常 fetch 通过
});