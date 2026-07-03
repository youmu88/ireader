/**
 * 登录 / 注册页面 — iOS 风格
 */
import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const { login, register, isAuthenticated } = useAuth();

  // 如果已登录则自动跳转
  if (isAuthenticated) {
    navigate('/', { replace: true });
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const errMsg = isRegister
        ? await register(username, password, displayName || undefined)
        : await login(username, password);

      if (errMsg) {
        setError(errMsg);
      } else if (isRegister) {
        setIsRegister(false);
      } else {
        navigate('/', { replace: true });
      }
    } catch {
      setError('操作失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    setError('');
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--color-bg)' }}>
      <div className="w-full max-w-sm animate-fade-in">
        {/* iOS 风格毛玻璃卡片 */}
        <div className="rounded-2xl overflow-hidden shadow-ios-sm p-8"
          style={{ background: 'var(--color-bg-card)' }}>
          {/* Logo / 标题 */}
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'var(--color-primary)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <h1 className="text-[28px] font-bold tracking-tight" style={{ color: 'var(--color-text)' }}>
              iReader
            </h1>
            <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {isRegister ? '创建新账号' : '登录你的账号'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* 用户名 */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                用户名
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl text-sm outline-none border transition-all duration-200"
                style={{
                  background: 'var(--color-bg-alt)',
                  color: 'var(--color-text)',
                  borderColor: 'var(--color-border)',
                }}
                placeholder="请输入用户名"
                required
                minLength={3}
                maxLength={30}
                onFocus={(e) => { e.target.style.borderColor = 'var(--color-primary)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--color-border)'; }}
              />
            </div>

            {/* 显示名称（注册时） */}
            {isRegister && (
              <div className="animate-slide-up">
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  显示名称 <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>（可选）</span>
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl text-sm outline-none border transition-all duration-200"
                  style={{
                    background: 'var(--color-bg-alt)',
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                  }}
                  placeholder="给自己取个好听的名字吧"
                  maxLength={50}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--color-primary)'; }}
                  onBlur={(e) => { e.target.style.borderColor = 'var(--color-border)'; }}
                />
              </div>
            )}

            {/* 密码 */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl text-sm outline-none border transition-all duration-200"
                style={{
                  background: 'var(--color-bg-alt)',
                  color: 'var(--color-text)',
                  borderColor: 'var(--color-border)',
                }}
                placeholder={isRegister ? '至少6个字符' : '请输入密码'}
                required
                minLength={6}
                onFocus={(e) => { e.target.style.borderColor = 'var(--color-primary)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--color-border)'; }}
              />
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="text-xs px-3 py-2 rounded-xl animate-slide-up"
                style={{
                  background: 'rgba(255,59,48,0.12)',
                  color: '#ff3b30',
                }}>
                {error}
              </div>
            )}

            {/* 提交按钮 */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 rounded-xl text-sm font-semibold text-center transition-all duration-200 active:scale-[0.97]"
              style={{
                background: submitting ? 'var(--color-bg-alt)' : 'var(--color-primary)',
                color: submitting ? 'var(--color-text-muted)' : '#fff',
              }}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" opacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  处理中...
                </span>
              ) : isRegister ? '注册' : '登录'}
            </button>
          </form>

          {/* 切换登录/注册 */}
          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={toggleMode}
              className="text-sm font-medium tap-active transition-all duration-200"
              style={{ color: 'var(--color-primary)' }}
            >
              {isRegister ? '已有账号？去登录' : '没有账号？去注册'}
            </button>
          </div>

          {/* 底部提示（分割线 + 默认账号） */}
          <div className="mt-8 pt-4"
            style={{ borderTop: '0.5px solid var(--color-border)' }}>
            <p className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
              默认管理员账号：admin / admin123
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
