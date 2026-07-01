/**
 * 认证上下文 — 全局鉴权状态管理
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
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

interface AuthContextType {
  user: UserInfo | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<string | null>;
  register: (username: string, password: string, displayName?: string) => Promise<string | null>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 处理未授权回调（跳转到登录页）
  const handleUnauthorized = useCallback(() => {
    setUser(null);
    removeToken();
    window.location.href = '/login';
  }, []);

  // 初始化：设置拦截器 + 检查已有 Token
  useEffect(() => {
    setupAxiosInterceptors(handleUnauthorized);

    const token = getToken();
    if (token) {
      getCurrentUser()
        .then((res) => {
          if (res.success && res.data) {
            setUser(res.data);
          } else {
            removeToken();
          }
        })
        .catch(() => {
          removeToken();
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
    }
  }, [handleUnauthorized]);

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
    window.location.href = '/login';
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, isAuthenticated: !!user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
