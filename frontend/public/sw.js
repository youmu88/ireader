/**
 * iReader Service Worker v1
 * 
 * 离线缓存策略：
 * 1. 安装时预缓存所有静态资源（HTML/JS/CSS/字体/图片）
 * 2. 运行时缓存封面图片、书籍文件、TTS 音频
 * 3. 静态资源：缓存优先（CacheFirst）
 * 4. API 数据：网络优先 + 缓存回退（NetworkFirst）
 */

const CACHE_VERSION = 'v2';
const SW_VERSION = '1.0.0';
// SW 版本号——变更时触发 install 事件，自动激活新 SW
const STATIC_CACHE = `ireader-static-${CACHE_VERSION}`;
const COVERS_CACHE = `ireader-covers-${CACHE_VERSION}`;
const API_CACHE = `ireader-api-${CACHE_VERSION}`;

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

function isBookFile(url) {
  return /^\/api\/books\/[^/]+\/file/.test(url.pathname);
}

function isAPIRequest(url) {
  return url.pathname.startsWith('/api/');
}

// ── 导航请求：离线时返回缓存的 App Shell（StaleWhileRevalidate 化）──
function isNavigateRequest(event) {
  return event.request.mode === 'navigate';
}

// ── 响应：离线缓存策略 ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // ⭐ 导航请求（页面级跳转）：StaleWhileRevalidate 化
  //    在线时后台更新 index.html 缓存，离线时从缓存返回
  //    确保用户看到的 App Shell 是最新版
  if (isNavigateRequest(event)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) => {
        return cache.match('/index.html').then((cached) => {
          // 后台更新：不管有没有缓存，都发起网络请求更新
          const networkPromise = fetch(event.request).then((response) => {
            if (response && response.status === 200) {
              cache.put('/index.html', response.clone());
            }
            return response;
          });
          // 立即返回缓存（如果有），同时后台静默更新
          if (cached) return cached;
          // 无缓存时走网络请求；网络失败则返回最简离线 HTML
          return networkPromise.catch(() => {
            return new Response(
              '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>iReader - 离线模式</title></head><body><div id="root"><div style="padding:40px;text-align:center;color:#666;font-family:sans-serif"><h2>📚 iReader 离线模式</h2><p>正在从本地缓存加载书籍数据...</p><p style="font-size:12px;color:#999;margin-top:20px">请确保您已预先缓存书籍</p></div></div></body></html>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
        });
      })
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
            // 网络失败时如果无缓存，尝试返回 index.html 兜底
            return caches.match('/index.html');
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