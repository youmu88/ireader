import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ReaderPage from './ReaderPage';

// ── axios mock（ReaderPage 与 useReaderProgress 共同消费） ──
const axiosMocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMocks }));

// ── EpubBookController mock（屏蔽 epub.js 渲染细节，专注组装逻辑） ──
const controllerMocks = vi.hoisted(() => {
  const instance = {
    load: vi.fn(),
    destroy: vi.fn(),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    goTo: vi.fn(),
    goToPercentage: vi.fn(),
    applySettings: vi.fn(),
    onLocationChange: vi.fn().mockReturnValue(() => {}),
    generateLocations: vi.fn().mockResolvedValue(500),
    isLocationsReady: false,
    currentLocation: null,
  };
  return { instance, ctor: vi.fn(() => instance) };
});
vi.mock('../reader/EpubBookController', () => ({ EpubBookController: controllerMocks.ctor }));

const offlineMocks = vi.hoisted(() => ({ getCachedEpubArchive: vi.fn() }));
vi.mock('../services/offlineCacheService', () => ({
  getCachedEpubArchive: offlineMocks.getCachedEpubArchive,
}));
vi.mock('../services/authService', () => ({ getToken: vi.fn().mockReturnValue('test-token') }));
vi.mock('../services/deviceId', () => ({ getDeviceId: vi.fn().mockReturnValue('device-1') }));

const renderReader = () =>
  render(
    <MemoryRouter initialEntries={['/reader/book-1']}>
      <Routes>
        <Route path="/reader/:bookId" element={<ReaderPage />} />
      </Routes>
    </MemoryRouter>,
  );

const mockBook = (format: 'epub' | 'txt') => {
  axiosMocks.get.mockImplementation((url: string) => {
    if (url === '/api/books/book-1') {
      return Promise.resolve({
        data: { success: true, data: { id: 'book-1', title: '测试之书', author: '作者', format } },
      });
    }
    return Promise.resolve({ data: { success: true, data: null } }); // GET progress → 无记录
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  controllerMocks.instance.load.mockResolvedValue([{ id: 'c1', label: '第一章', href: 'ch1.xhtml' }]);
  controllerMocks.instance.onLocationChange.mockReturnValue(() => {});
  controllerMocks.instance.generateLocations.mockResolvedValue(500);
  offlineMocks.getCachedEpubArchive.mockResolvedValue(undefined);
  axiosMocks.put.mockResolvedValue({ data: { success: true, conflict: false, data: { progressVersion: 2 } } });
  localStorage.clear();
});

describe('ReaderPage', () => {
  it('TXT 书籍：显示暂不支持提示，不初始化渲染', async () => {
    mockBook('txt');
    renderReader();
    expect(await screen.findByText(/TXT 格式，新版阅读器暂不支持/)).toBeDefined();
    expect(controllerMocks.instance.load).not.toHaveBeenCalled();
  });

  it('EPUB 书籍：以文件 URL + Authorization 头初始化渲染，渲染点按层', async () => {
    mockBook('epub');
    renderReader();
    expect(await screen.findByTestId('tap-zones')).toBeDefined();
    const [source, , options] = controllerMocks.instance.load.mock.calls[0];
    expect(source).toBe('/api/books/book-1/file');
    expect(options.requestHeaders).toEqual({ Authorization: 'Bearer test-token' });
    // 目录与页码生成已触发
    expect(controllerMocks.instance.generateLocations).toHaveBeenCalled();
  });

  it('离线包命中时：以 ArrayBuffer 为渲染源（不走网络 URL）', async () => {
    offlineMocks.getCachedEpubArchive.mockResolvedValue({ data: new ArrayBuffer(8) });
    mockBook('epub');
    renderReader();
    await screen.findByTestId('tap-zones');
    const [source, , options] = controllerMocks.instance.load.mock.calls[0];
    expect(source).toBeInstanceOf(ArrayBuffer);
    expect(options.requestHeaders).toBeUndefined();
  });

  it('点按中央切换工具栏显隐；点按右侧触发下一页', async () => {
    mockBook('epub');
    renderReader();
    await screen.findByTestId('tap-zones');

    // 初始隐藏
    expect(screen.getByTestId('reader-chrome-top').className).toContain('-translate-y-full');
    // 点按中央 → 显示
    fireEvent.click(screen.getByLabelText('显示或隐藏工具栏'));
    expect(screen.getByTestId('reader-chrome-top').className).toContain('translate-y-0');
    // 顶栏书名
    expect(screen.getByText('测试之书')).toBeDefined();
    // 点按右侧 1/4 → 下一页
    fireEvent.click(screen.getByLabelText('下一页'));
    expect(controllerMocks.instance.next).toHaveBeenCalledTimes(1);
    // 点按左侧 1/4 → 上一页
    fireEvent.click(screen.getByLabelText('上一页'));
    expect(controllerMocks.instance.prev).toHaveBeenCalledTimes(1);
  });

  it('顶栏打开目录/aA 面板；目录选择跳转并关闭', async () => {
    mockBook('epub');
    renderReader();
    await screen.findByTestId('tap-zones');
    fireEvent.click(screen.getByLabelText('显示或隐藏工具栏'));

    // 打开目录（getByRole 精确命中顶栏按钮，避免与抽屉容器 aria-label 冲突）
    fireEvent.click(screen.getByRole('button', { name: '目录' }));
    fireEvent.click(screen.getByText('第一章'));
    expect(controllerMocks.instance.goTo).toHaveBeenCalledWith('ch1.xhtml');

    // 打开 aA 面板
    fireEvent.click(screen.getByLabelText('字体与主题'));
    const panel = screen.getByTestId('font-settings-panel');
    expect(panel.className).toContain('opacity-100');
  });

  it('加载失败：显示错误与返回入口', async () => {
    axiosMocks.get.mockRejectedValue(new Error('Network Error'));
    renderReader();
    expect(await screen.findByText('书籍加载失败，请稍后重试')).toBeDefined();
    expect(screen.getByText('返回书库')).toBeDefined();
  });
});
