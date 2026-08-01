import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../services/themeService';
import { SafeGlass } from '../services/progressiveComponents';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';
import { Dock } from './Dock/Dock';

const DOCK_TABS = [
  { id: '/', label: '书架', icon: 'shelf' as const },
  { id: '/library', label: '图书管理', icon: 'library' as const },
  { id: '/settings', label: '设置', icon: 'settings' as const },
];

interface TTSJob {
  id: string;
  status: string;
}

function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isReader = location.pathname.startsWith('/reader');
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const [activeJobCount, setActiveJobCount] = useState(0);
  const [offline, setOffline] = useState(!navigator.onLine);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // 监听网络状态
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const fetchActiveJobCount = useCallback(async () => {
    try {
      const res = await axios.get('/api/tts/jobs');
      if (res.data.success) {
        const active = res.data.data.filter((j: TTSJob) => j.status === 'pending' || j.status === 'running').length;
        setActiveJobCount(active);
      }
    } catch { /* 静默，未登录时忽略 */ }
  }, []);

  // 页面加载和切换时启动/停止轮询
  useEffect(() => {
    if (!isReader && user) {
      fetchActiveJobCount();
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchActiveJobCount, 10000);
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
    };
  }, [isReader, user, fetchActiveJobCount]);

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  const openTtsQueue = () => {
    // 跳转到书架页面并自动打开 TTS 队列
    navigate('/', { state: { openTtsQueue: true } });
  };

  const { compatibility } = useTheme();

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* iOS 风格毛玻璃导航栏（非阅读器页面） */}
      {!isReader && (
        <SafeGlass compatibility={compatibility} className="sticky top-0 z-40" fallbackClassName="sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6">
            {/* 主栏：标题 + 操作（书架/设置导航已由底部 Dock 承担，顶部仅保留全局操作，避免重复） */}
            <div className="flex items-center justify-between h-12 sm:h-14">
              {/* 左侧：iOS 风格标题 */}
              <Link to="/" className="flex items-center gap-2 no-underline">
                <span className="text-xl sm:text-2xl font-semibold" style={{ color: 'var(--color-primary)' }}>
                  iReader
                </span>
                {/* 活跃任务指示器 */}
                {activeJobCount > 0 && (
                  <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full animate-fade-in"
                    style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-primary)' }} />
                    合成中
                  </span>
                )}
                {/* 离线状态指示器 */}
                {offline && (
                  <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(239,68,68,0.15)', color: 'rgb(239,68,68)' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
                      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                      <line x1="12" y1="20" x2="12.01" y2="20" />
                    </svg>
                    离线
                  </span>
                )}
              </Link>

              {/* 右侧：全局操作（语音合成 + 桌面端用户区）；书架/设置导航由底部 Dock 承担 */}
              <nav className="flex items-center gap-1 sm:gap-2">
                {/* 语音合成（麦克风图标）—— 双端统一 */}
                <IconButton
                  onClick={openTtsQueue}
                  variant="ghost"
                  size="sm"
                  className="relative"
                  style={{ color: 'var(--color-text-secondary)' }}
                  title="语音合成"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="2" width="6" height="11" rx="3" ry="3" />
                    <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  {activeJobCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white rounded-full animate-pop-in bg-ios-primary">
                      {activeJobCount > 99 ? '99+' : activeJobCount}
                    </span>
                  )}
                </IconButton>

                {/* 桌面端：用户信息 + 主题切换 + 退出 */}
                <div className="hidden sm:flex items-center gap-2 ml-1 pl-2"
                  style={{ borderLeft: '0.5px solid var(--color-border)' }}>
                  {user && (
                    <span className="text-sm px-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {user.displayName || user.username}
                    </span>
                  )}
                  <IconButton
                    onClick={toggleTheme}
                    variant="subtle"
                    size="sm"
                    title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
                  >
                    {theme === 'dark' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ios-warning">
                        <circle cx="12" cy="12" r="5" />
                        <line x1="12" y1="1" x2="12" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="23" />
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                        <line x1="1" y1="12" x2="3" y2="12" />
                        <line x1="21" y1="12" x2="23" y2="12" />
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ios-primary">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                  </IconButton>
                  <Button variant="secondary" size="sm" onClick={handleLogout} title="退出登录">
                    退出
                  </Button>
                </div>
              </nav>
            </div>
          </div>
        </SafeGlass>
      )}
      <main className="flex-1">
        <Outlet />
      </main>
      {/* iOS 底部透明 Dock（阅读器路由不渲染：阅读页为全屏沉浸态，Dock 常驻会以空白条遮挡底部 UI 与设置面板） */}
      {!isReader && (
        <Dock
          tabs={DOCK_TABS}
          currentPath={location.pathname}
          onNavigate={(path) => {
            if (location.pathname !== path) navigate(path);
          }}
        />
      )}
    </div>
  );
}

export default Layout;
