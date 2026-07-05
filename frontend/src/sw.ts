/**
 * Service Worker 注册模块
 *
 * 配合 vite-plugin-pwa 自动生成 SW，实现：
 * 1. 静态资源离线缓存（HTML/JS/CSS/图片）
 * 2. 封面图片离线访问
 * 3. 已缓存书籍的 TTS 音频离线播放
 *
 * registerType: 'autoUpdate' — 新 SW 安装后自动接管，不打扰用户
 */

/**
 * 注册 Service Worker
 * 由 VitePWA 插件在构建时自动生成 sw.js，位于 dist/ 根目录
 */
export function registerSW(): void {
  if (!('serviceWorker' in navigator)) {
    console.log('[SW] 当前浏览器不支持 Service Worker，离线功能不可用');
    return;
  }

  // VitePWA 插件在构建时会自动替换为正确的环境判断
  // 开发环境跳过注册，避免缓存干扰热更新
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
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

      // 检查是否有等待中的新 SW
      if (registration.waiting) {
        console.log('[SW] 新版本等待激活');
      }

      // 监听更新
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
