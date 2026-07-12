import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../services/themeService';
import { SafeGlass } from '../services/progressiveComponents';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';

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
            {/* 主栏：标题 + 操作 */}
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

              {/* 右侧：导航操作（双端图标一致：书架 → 语音合成 → 设置） */}
              <nav className="flex items-center gap-1 sm:gap-2">
                {/* 书架按钮（移动端纯图标 + 桌面端图标文字） */}
                <Link
                  to="/"
                  className={`flex items-center justify-center sm:justify-start gap-1.5 w-9 h-9 sm:w-auto sm:px-3 sm:py-1.5 rounded-full sm:rounded-lg text-sm font-medium transition-all duration-200 tap-icon sm:tap-active ${
                    location.pathname === '/'
                      ? 'sm:bg-primary-subtle sm:text-primary'
                      : 'sm:opacity-70 sm:hover:opacity-100'
                  }`}
                  style={{
                    color: location.pathname === '/' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    background: location.pathname === '/' ? 'var(--color-primary-subtle)' : 'transparent',
                  }}
                  title="书架"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-[16px] sm:h-[16px]">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <span className="hidden sm:inline">书架</span>
                </Link>

                {/* 语音合成（麦克风图标）—— 双端统一 */}
                <button
                  onClick={openTtsQueue}
                  className="relative w-9 h-9 flex items-center justify-center rounded-full tap-icon"
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
                    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold text-white rounded-full animate-pop-in"
                      style={{ background: 'var(--color-primary)' }}>
                      {activeJobCount > 99 ? '99+' : activeJobCount}
                    </span>
                  )}
                </button>

                {/* 设置按钮（移动端纯图标 + 桌面端图标文字） */}
                <Link
                  to="/settings"
                  className={`flex items-center justify-center sm:justify-start gap-1.5 w-9 h-9 sm:w-auto sm:px-3 sm:py-1.5 rounded-full sm:rounded-lg text-sm font-medium transition-all duration-200 tap-icon sm:tap-active ${
                    location.pathname === '/settings'
                      ? 'sm:bg-primary-subtle sm:text-primary'
                      : 'sm:opacity-70 sm:hover:opacity-100'
                  }`}
                  style={{
                    color: location.pathname === '/settings' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    background: location.pathname === '/settings' ? 'var(--color-primary-subtle)' : 'transparent',
                  }}
                  title="设置"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-[16px] sm:h-[16px]">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className="hidden sm:inline">设置</span>
                </Link>

                {/* 桌面端：用户信息 + 主题切换 + 退出 */}
                <div className="hidden sm:flex items-center gap-2 ml-1 pl-2"
                  style={{ borderLeft: '0.5px solid var(--color-border)' }}>
                  {user && (
                    <span className="text-sm px-1" style={{ color: 'var(--color-text-secondary)' }}>
                      {user.displayName || user.username}
                    </span>
                  )}
                  <button
                    onClick={toggleTheme}
                    className="w-8 h-8 rounded-full flex items-center justify-center tap-icon"
                    style={{ background: 'var(--color-bg-alt)' }}
                    title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
                  >
                    {theme === 'dark' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#fbbf24' }}>
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
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#6366f1' }}>
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                  </button>
                  <button
                    onClick={handleLogout}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium tap-active transition-all duration-200"
                    style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}
                    title="退出登录"
                  >
                    退出
                  </button>
                </div>
              </nav>
            </div>
          </div>
        </SafeGlass>
      )}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;