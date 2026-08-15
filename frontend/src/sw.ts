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
      // 阅读页不强制刷新（避免打断阅读）：发全局事件提示 + sessionStorage 标记，
      // 退出阅读（ReaderPage 卸载）时检测标记并刷新应用新版。
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (window.location.pathname.startsWith('/reader')) {
          try {
            sessionStorage.setItem('ireader_new_version_pending', '1');
          } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent('app:new-version-ready'));
        } else {
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
 * 手动检查 Service Worker 更新：
 * - 'update'：发现新版本（installing/waiting，或已触发 controllerchange 接管）
 * - 'latest'：已是最新版本
 * - 'unsupported'：环境不支持 SW（无 navigator.serviceWorker / 无注册）
 *
 * 说明：sw.js 在 install 时调用 skipWaiting，新 SW 会立即激活接管，waiting 状态极短暂；
 * 因此 update() 后除检测 installing/waiting 外，还需等待 controllerchange 短窗口，
 * 否则会漏报已就绪的新版本（竞态）。
 */
export async function checkSWUpdate(): Promise<'update' | 'latest' | 'unsupported'> {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return 'unsupported';
    await registration.update();
    // 新 SW 已进入 installing/waiting（尚未激活）→ 即将 skipWaiting 接管
    if (registration.installing || registration.waiting) return 'update';
    // 已激活接管（skipWaiting 竞态）：等待 controllerchange 短窗口确认
    return new Promise<'update' | 'latest'>((resolve) => {
      const timer = setTimeout(() => resolve('latest'), 3000);
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          clearTimeout(timer);
          resolve('update');
        },
        { once: true },
      );
    });
  } catch {
    return 'unsupported';
  }
}
