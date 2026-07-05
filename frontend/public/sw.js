/**
 * iReader Service Worker v1
 * 
 * 离线缓存策略：
 * 1. 安装时预缓存所有静态资源（HTML/JS/CSS/字体/图片）
 * 2. 运行时缓存封面图片、书籍文件、TTS 音频
 * 3. 静态资源：缓存优先（CacheFirst）
 * 4. API 数据：网络优先 + 缓存回退（NetworkFirst）
 */

const CACHE_VERSION = 'v1';
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
      return cache.addAll(PRECACHE_URLS).catch(() => {
        // 部分资源可能还不存在，忽略错误
        console.log('[SW] 预缓存完成（部分可能跳过）');
      });
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

// ── 响应：离线缓存策略 ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // 静态资源：缓存优先（CacheFirst）
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => {
          // 离线时返回缓存首页
          return caches.match('/index.html');
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