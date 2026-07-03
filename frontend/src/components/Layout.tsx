import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../services/themeService';
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
  const pollRef = useRef<ReturnType<typeof setInterval>>();

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

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
      {/* iOS 风格毛玻璃导航栏（非阅读器页面） */}
      {!isReader && (
        <header className="glass sticky top-0 z-40">
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
              </Link>

              {/* 右侧：导航操作（桌面端显示全部，移动端精简） */}
              <nav className="flex items-center gap-1 sm:gap-2">
                {/* 移动端：TTS 队列图标 */}
                <button
                  onClick={openTtsQueue}
                  className="relative w-9 h-9 flex items-center justify-center rounded-full tap-icon sm:hidden"
                  style={{ color: 'var(--color-text-secondary)' }}
                  title="语音生成队列"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
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

                {/* 桌面端：导航链接 */}
                <Link
                  to="/"
                  className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                    location.pathname === '/'
                      ? ''
                      : 'opacity-70 hover:opacity-100'
                  }`}
                  style={{
                    background: location.pathname === '/' ? 'var(--color-primary-subtle)' : 'transparent',
                    color: location.pathname === '/' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                  书架
                </Link>

                {/* 桌面端：TTS 队列图标 */}
                <button
                  onClick={openTtsQueue}
                  className="hidden sm:flex relative w-9 h-9 items-center justify-center rounded-full tap-icon"
                  style={{ color: 'var(--color-text-secondary)' }}
                  title="语音生成队列"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
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

                <Link
                  to="/settings"
                  className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                    location.pathname === '/settings'
                      ? ''
                      : 'opacity-70 hover:opacity-100'
                  }`}
                  style={{
                    background: location.pathname === '/settings' ? 'var(--color-primary-subtle)' : 'transparent',
                    color: location.pathname === '/settings' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  设置
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
        </header>
      )}
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export default Layout;
