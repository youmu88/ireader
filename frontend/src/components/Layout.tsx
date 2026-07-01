import { Outlet, Link, useLocation } from 'react-router-dom';
import { useTheme } from '../services/themeService';
import { useAuth } from '../contexts/AuthContext';

function Layout() {
  const location = useLocation();
  const isReader = location.pathname.startsWith('/reader');
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();

  const handleLogout = () => {
    logout();
    window.location.href = '/login';
  };

  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-900 transition-colors">
      {!isReader && (
        <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 transition-colors">
          <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link to="/" className="text-xl font-bold text-blue-600 dark:text-blue-400">
              📚 iReader
            </Link>
            <nav className="flex items-center gap-3">
              <Link
                to="/"
                className={`px-3 py-1 rounded ${
                  location.pathname === '/' ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : ''
                }`}
              >
                书架
              </Link>
              <Link
                to="/settings"
                className={`px-3 py-1 rounded ${
                  location.pathname === '/settings' ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' : ''
                }`}
              >
                设置
              </Link>
              {/* 用户信息 */}
              {user && (
                <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline">
                  {user.displayName || user.username}
                </span>
              )}
              {/* 主题切换按钮 */}
              <button
                onClick={toggleTheme}
                className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
              {/* 退出登录 */}
              <button
                onClick={handleLogout}
                className="px-3 py-1 rounded text-sm bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                title="退出登录"
              >
                退出
              </button>
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
