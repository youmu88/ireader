/**
 * Service Worker 注册模块
 *
 * 注册原生 Service Worker (public/sw.js)，实现离线访问：
 * 1. 静态资源离线缓存（HTML/JS/CSS/图片）
 * 2. 封面图片离线访问（NetworkFirst 策略）
 * 3. 已缓存 API 数据的离线回退
 */

/**
 * 注册 Service Worker
 */
export function registerSW(): void {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] 当前浏览器不支持 Service Worker，离线功能不可用');
    return;
  }

  // 开发环境跳过注册，避免缓存干扰热更新
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    console.log('[SW] 开发环境跳过 Service Worker 注册');
    return;
  }

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
      console.log('[SW] 注册成功，作用域:', registration.scope);

      // 新 SW 接管（skipWaiting+claim 或版本升级）→ 非阅读页立即刷新，让新版本前端即刻生效；
      // 阅读页不强制刷新（避免打断阅读），下次导航自然加载新版。
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!window.location.pathname.startsWith('/reader')) {
          console.log('[SW] 新版本已接管，刷新页面应用新版本');
          window.location.reload();
        }
      });

      // 检查更新
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('[SW] 新版本已安装，后台等待激活');
            }
          });
        }
      });
    } catch (err) {
      console.warn('[SW] 注册失败:', err);
    }
  });
}

/**
 * 检查 Service Worker 是否已控制当前页面
 */
export function isSWControlled(): boolean {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
  return navigator.serviceWorker.controller !== null;
}

/**
 * 手动检查 Service Worker 更新
 */
export async function checkSWUpdate(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.update();
      return !!registration.waiting;
    }
    return false;
  } catch {
    return false;
  }
}
