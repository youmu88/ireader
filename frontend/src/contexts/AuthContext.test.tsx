import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { Button } from '../components/ui/Button';

// 模拟 getCurrentUser，用于断言「离线态不应发起认证请求」
const getCurrentUserSpy = vi.fn();
vi.mock('../services/authService', () => ({
  loginApi: vi.fn(),
  registerApi: vi.fn(),
  getCurrentUser: (...args: any[]) => getCurrentUserSpy(...args),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
  removeToken: vi.fn(),
  setupAxiosInterceptors: vi.fn(),
  UserInfo: class {},
}));

function Probe() {
  const { loading, isAuthenticated, isOfflineMode, enterOfflineMode } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="auth">{String(isAuthenticated)}</span>
      <span data-testid="offline">{String(isOfflineMode)}</span>
      <Button data-testid="enter" onClick={enterOfflineMode} variant="ghost" className="!w-auto !h-auto !px-2 !py-1">enter</Button>
    </div>
  );
}

function renderProvider() {
  return render(
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </BrowserRouter>
  );
}

describe('AuthContext — 离线模式跳过认证', () => {
  beforeEach(() => {
    getCurrentUserSpy.mockReset();
    getCurrentUserSpy.mockResolvedValue({ success: true, data: { id: '1', username: 'u', email: 'e' } });
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('进入离线模式后 loading 立即为 false，且不再请求 getCurrentUser', async () => {
    renderProvider();
    // 点击「离线使用」
    await act(async () => {
      screen.getByTestId('enter').click();
    });
    expect(screen.getByTestId('offline').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('auth').textContent).toBe('true');
    // 关键回归点：离线态下绝不能再去请求后端认证 API
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });

  it('localStorage 残留离线标志时，首次加载即跳过认证（loading=false, auth=true）', async () => {
    localStorage.setItem('ireader_offline_mode', 'true');
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('offline').textContent).toBe('true');
    expect(screen.getByTestId('auth').textContent).toBe('true');
    expect(getCurrentUserSpy).not.toHaveBeenCalled();
  });
});
