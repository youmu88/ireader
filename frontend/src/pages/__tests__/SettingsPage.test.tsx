import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SettingsPage from '../SettingsPage';

// Mock ttsService to resolve immediately (no async loading delay in test)
vi.mock('../services/ttsService', () => ({
  fetchSources: vi.fn().mockResolvedValue([]),
  fetchVoices: vi.fn().mockResolvedValue([]),
  fetchTTSSettings: vi.fn().mockResolvedValue({
    source: 'kokoro',
    voiceId: 'zh-CN-XiaoxiaoNeural',
    speed: 1.0,
    apiUrl: '',
    apiKey: '',
    autoPreSynthesize: false,
  }),
  saveTTSSettings: vi.fn(),
  testConnection: vi.fn(),
  clearTTSCache: vi.fn(),
  type: {},
}));

// Mock themeService
vi.mock('../services/themeService', () => ({
  useTheme: vi.fn().mockReturnValue({
    theme: 'light',
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));

// Mock axios
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading spinner initially', () => {
    render(<SettingsPage />);
    expect(screen.getByText('加载中...')).toBeDefined();
  });

  it('should render settings panel after loading completes', async () => {
    render(<SettingsPage />);
    // waitFor loading to finish and settings panel to appear
    await waitFor(() => {
      expect(screen.getByText('设置')).toBeDefined();
    });
    // Verify key sections are rendered
    expect(screen.getByText('外观')).toBeDefined();
    expect(screen.getByText('关于')).toBeDefined();
  });

  it('全局滚动阻尼：默认 3 级，调节后持久化到 localStorage', async () => {
    localStorage.removeItem('ireader_scroll_damping');
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('设置')).toBeDefined();
    });
    const slider = screen.getByLabelText('滚动阻尼') as HTMLInputElement;
    expect(slider.value).toBe('3'); // 默认 3 级
    fireEvent.change(slider, { target: { value: '7' } });
    expect(localStorage.getItem('ireader_scroll_damping')).toBe('7');
  });
});
