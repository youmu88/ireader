/**
 * 认证上下文 — 全局鉴权状态管理
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  loginApi,
  registerApi,
  getCurrentUser,
  getToken,
  setToken,
  removeToken,
  setupAxiosInterceptors,
  UserInfo,
} from '../services/authService';

const OFFLINE_MODE_KEY = 'ireader_offline_mode';

interface AuthContextType {
  user: UserInfo | null;
  loading: boolean;
  isAuthenticated: boolean;
  isOfflineMode: boolean;
  login: (username: string, password: string) => Promise<string | null>;
  register: (username: string, password: string, displayName?: string) => Promise<string | null>;
  logout: () => void;
  enterOfflineMode: () => void;
  exitOfflineMode: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOfflineMode, setIsOfflineMode] = useState(() => {
    try { return localStorage.getItem(OFFLINE_MODE_KEY) === 'true'; } catch { return false; }
  });
  const navigate = useNavigate();
  const navigateRef = useRef<((path: string) => void) | null>(null);

  // 处理未授权回调（跳转到登录页）——优先使用 React Router navigate，避免硬跳转破坏 SPA 状态
  const handleUnauthorized = useCallback(() => {
    setUser(null);
    removeToken();
    if (navigateRef.current) {
      navigateRef.current('/login');
    } else {
      window.location.href = '/login';
    }
  }, []);

  // 初始化：设置拦截器 + 检查已有 Token
  useEffect(() => {
    navigateRef.current = navigate;

    // ── 离线模式（用户主动选择）：完全跳过认证 ──
    if (isOfflineMode) {
      console.log('[Auth] 离线模式（用户主动选择）：跳过认证');
      setLoading(false);
      return;
    }

    // ── 离线策略（网络不可用）：完全跳过认证，允许访问本地缓存数据 ──
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      console.log('[Auth] 离线模式：跳过认证，允许访问本地缓存数据');
      setLoading(false);
      return;
    }

    setupAxiosInterceptors(handleUnauthorized);

    const token = getToken();
    if (token) {
      // 尝试校验 token：在线时请求后端验证
      getCurrentUser()
        .then((res) => {
          if (res.success && res.data) {
            setUser(res.data);
          } else {
            // 后端返回 success=false（如用户不存在）→ 清除无效 token
            removeToken();
          }
        })
        .catch((err) => {
          // ── 首次加载时 token 验证失败 ──
          // 如果是 401 错误：拦截器已通过 handleUnauthorized 清除 token（但 navigate 可能是硬跳转）
          // 这里统一处理：清除 token，不跳转，让 ProtectedRoute 自动重定向到 /login
          if (err?.response?.status === 401) {
            console.warn('[Auth] token 无效（401），已清除');
            removeToken();
          } else {
            // 网络错误：保留 token，让用户继续使用已缓存的离线内容
            console.warn('[Auth] 网络错误：保留本地 token，跳过后端验证');
          }
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, [handleUnauthorized, navigate]);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await loginApi(username, password);
      if (res.success && res.data) {
        setToken(res.data.token);
        setUser(res.data.user);
        return null;
      }
      return res.error || '登录失败';
    } catch (err: any) {
      return err.response?.data?.error || '网络错误，请稍后重试';
    }
  }, []);

  const register = useCallback(
    async (username: string, password: string, displayName?: string): Promise<string | null> => {
      try {
        const res = await registerApi(username, password, displayName);
        if (res.success && res.data) {
          return null;
        }
        return res.error || '注册失败';
      } catch (err: any) {
        return err.response?.data?.error || '网络错误，请稍后重试';
      }
    },
    [],
  );

  const logout = useCallback(() => {
    removeToken();
    setUser(null);
    if (navigateRef.current) {
      navigateRef.current('/login');
    } else {
      window.location.href = '/login';
    }
  }, []);

  // ── 进入离线模式 ──
  const enterOfflineMode = useCallback(() => {
    try { localStorage.setItem(OFFLINE_MODE_KEY, 'true'); } catch { /* ignore */ }
    setIsOfflineMode(true);
    setLoading(false);
  }, []);

  // ── 退出离线模式 ──
  const exitOfflineMode = useCallback(() => {
    try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch { /* ignore */ }
    setIsOfflineMode(false);
    setUser(null);
    if (navigateRef.current) {
      navigateRef.current('/login');
    } else {
      window.location.href = '/login';
    }
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      isAuthenticated: !!user || isOfflineMode,
      isOfflineMode,
      login,
      register,
      logout,
      enterOfflineMode,
      exitOfflineMode,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
