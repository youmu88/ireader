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
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-900 transition-colors">
      {!isReader && (
        <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 transition-colors">
                      <div className="max-w-7xl mx-auto px-3 py-2 sm:px-4 sm:py-3 flex items-center justify-between">
            <Link to="/" className="text-xl font-bold text-blue-600 dark:text-blue-400">
              📚 iReader
            </Link>
            <nav className="flex items-center gap-1 sm:gap-3">
              <Link
                to="/"
                className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm tap-active ${
                  location.pathname === '/' ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : ''
                }`}
              >
                <span className="sm:hidden">📚</span><span className="hidden sm:inline">书架</span>
              </Link>
              {/* TTS 队列图标（带角标） */}
              <button
                onClick={openTtsQueue}
                className="relative px-2 sm:px-3 py-1 rounded text-xs sm:text-sm hover:bg-gray-100 dark:hover:bg-gray-700 tap-active"
                title="语音生成队列"
              >
                🎙
                {activeJobCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 sm:-top-1 sm:-right-1 inline-flex items-center justify-center w-4 h-4 sm:w-5 sm:h-5 text-[10px] sm:text-xs font-bold text-white bg-red-500 rounded-full animate-pop-in">
                    {activeJobCount > 99 ? '99+' : activeJobCount}
                  </span>
                )}
              </button>
              <Link
                to="/settings"
                className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm tap-active ${
                  location.pathname === '/settings' ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : ''
                }`}
              >
                <span className="sm:hidden">⚙️</span><span className="hidden sm:inline">设置</span>
              </Link>
              {/* 用户信息 */}
              {user && (
                <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline">
                  {user.displayName || user.username}
                </span>
              )}
              {/* 桌面端工具栏：主题切换 + 退出登录（移动端隐藏，可在设置页操作） */}
              <div className="hidden sm:flex items-center gap-1 sm:gap-3">
                {/* 主题切换按钮（iOS 式按压） */}
                <button
                  onClick={toggleTheme}
                  className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center hover:bg-gray-300 dark:hover:bg-gray-600 tap-icon ripple-btn"
                  title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
                >
                  {theme === 'dark' ? '☀️' : '🌙'}
                </button>
                {/* 退出登录 */}
                <button
                  onClick={handleLogout}
                  className="p-1 sm:px-3 sm:py-1 rounded text-xs sm:text-sm bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 tap-active"
                  title="退出登录"
                >
                  <span className="sm:hidden">🚪</span><span className="hidden sm:inline">退出</span>
                </button>
              </div>
            </nav>
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
