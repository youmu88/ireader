/**
 * SettingsPage — 检查更新入口测试
 *
 * 覆盖：点击「检查更新」三种结果分支（有新版本/已最新/环境不支持）的 toast 提示。
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './SettingsPage';

// ── SW 检查 mock ──
const swMocks = vi.hoisted(() => ({ checkSWUpdate: vi.fn() }));
vi.mock('../sw', () => ({ checkSWUpdate: swMocks.checkSWUpdate }));

// ── toast mock（真实实现依赖 ToastProvider 容器）──
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('../components/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, toast: toastMocks };
});

// ── TTS 服务 mock（SettingsPage 挂载时拉取配置）──
vi.mock('../services/ttsService', () => ({
  fetchSources: vi.fn().mockResolvedValue([]),
  fetchVoices: vi.fn().mockResolvedValue([]),
  fetchModels: vi.fn().mockResolvedValue([]),
  fetchTTSSettings: vi.fn().mockResolvedValue({ voiceId: 'alloy', speed: 1.0, apiUrl: '', apiKey: '', model: '', autoPreSynthesize: false }),
  saveTTSSettings: vi.fn(),
  testConnection: vi.fn(),
  clearTTSCache: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock('../services/themeService', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/** jsdom 的 location.reload 只读：替换整个 location 对象以注入 reload spy */
function installReloadSpy() {
  const reloadSpy = vi.fn();
  const original = window.location;
  // @ts-expect-error jsdom location 属性不可写，先删除再赋值
  delete window.location;
  // @ts-expect-error 注入含 reload spy 的 location 替身
  window.location = { ...original, reload: reloadSpy };
  return reloadSpy;
}

describe('SettingsPage 检查更新', () => {
  it('渲染「检查更新」入口并显示当前版本', async () => {
    render(<SettingsPage />);
    expect(await screen.findByTestId('check-update')).toBeDefined();
    expect(screen.getByText(/v2\.61\.0/)).toBeDefined();
  });

  it('检测到新版本：toast.success 提示正在刷新，并触发 reload 兑底', async () => {
    swMocks.checkSWUpdate.mockResolvedValue('update');
    const reloadSpy = installReloadSpy();
    render(<SettingsPage />);
    const btn = await screen.findByTestId('check-update'); // 真实 timers 下等 loading 完成
    vi.useFakeTimers();
    fireEvent.click(btn);
    // flush 微任务（fake timers 不劫持微任务；async handler 的 await 链需要几轮）
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(toastMocks.success).toHaveBeenCalledWith('检测到新版本，正在刷新应用…');
    // 3s 兑底刷新（controllerchange 自动刷新为主）
    vi.advanceTimersByTime(3100);
    expect(reloadSpy).toHaveBeenCalled();
  });

  it('已是最新版本：toast.info 提示', async () => {
    swMocks.checkSWUpdate.mockResolvedValue('latest');
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId('check-update'));
    await waitFor(() => expect(toastMocks.info).toHaveBeenCalledWith('已是最新版本'));
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('环境不支持：toast.error 明确提示', async () => {
    swMocks.checkSWUpdate.mockResolvedValue('unsupported');
    render(<SettingsPage />);
    fireEvent.click(await screen.findByTestId('check-update'));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('当前环境不支持在线更新检查'));
  });

  it('检查中防重复点击（disabled）', async () => {
    let resolveFn: (v: 'update' | 'latest' | 'unsupported') => void = () => {};
    swMocks.checkSWUpdate.mockImplementation(() => new Promise(r => { resolveFn = r; }));
    render(<SettingsPage />);
    const btn = await screen.findByTestId('check-update');
    fireEvent.click(btn);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('检查中…')).toBeDefined();
    resolveFn('latest');
    await waitFor(() => expect((screen.getByTestId('check-update') as HTMLButtonElement).disabled).toBe(false));
  });
});
