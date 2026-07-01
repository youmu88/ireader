/**
 * 认证服务 — 登录/注册/Token 管理 + Axios 拦截器
 */
import axios from 'axios';

const TOKEN_KEY = 'ireader_auth_token';

export interface UserInfo {
  userId: string;
  username: string;
  displayName: string | null;
  createdAt: string;
}

export interface AuthResponse {
  success: boolean;
  data?: {
    token: string;
    user: UserInfo;
  };
  error?: string;
}

// ── Token 管理 ──

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// ── API 调用 ──

export async function loginApi(username: string, password: string): Promise<AuthResponse> {
  const res = await axios.post('/api/auth/login', { username, password });
  return res.data;
}

export async function registerApi(
  username: string,
  password: string,
  displayName?: string,
): Promise<AuthResponse> {
  const res = await axios.post('/api/auth/register', { username, password, displayName });
  return res.data;
}

export async function getCurrentUser(): Promise<{ success: boolean; data?: UserInfo; error?: string }> {
  const res = await axios.get('/api/auth/me');
  return res.data;
}

// ── Axios 拦截器（自动附加 Token + 401 处理） ──

let interceptorsSetup = false;

export function setupAxiosInterceptors(onUnauthorized?: () => void): void {
  if (interceptorsSetup) return;
  interceptorsSetup = true;

  // 请求拦截器：自动附加 Authorization header
  axios.interceptors.request.use((config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // 响应拦截器：401 时自动触发登出回调
  axios.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        removeToken();
        onUnauthorized?.();
      }
      return Promise.reject(error);
    },
  );
}
