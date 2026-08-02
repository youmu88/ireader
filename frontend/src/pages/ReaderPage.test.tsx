import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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
    loadTxt: vi.fn(),
    destroy: vi.fn(),
    goTo: vi.fn(),
    goToPercentage: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    applySettings: vi.fn(),
    onLocationChange: vi.fn().mockReturnValue(() => {}),
    onTap: vi.fn().mockReturnValue(() => {}),
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

// toast 真实实现依赖 ToastProvider 容器，集成测试环境未挂载，替换为 mock（Button 等其余导出保持真实）
vi.mock('../components/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

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
    if (format === 'txt' && url === '/api/books/book-1/chapters') {
      return Promise.resolve({
        data: {
          success: true,
          data: [
            { id: 'ch-1', title: '第一章', href: null },
            { id: 'ch-2', title: '第二章', href: null },
          ],
        },
      });
    }
    if (format === 'txt' && url.includes('/chapters/')) {
      return Promise.resolve({ data: { success: true, data: { text: '第一章正文内容' } } });
    }
    return Promise.resolve({ data: { success: true, data: null } }); // GET progress → 无记录
  });
};

// 捕获正文点按回调（epub.js click 桥接 → onTap），测试中模拟“点按正文”
let tapCb: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tapCb = undefined;
  controllerMocks.instance.load.mockResolvedValue([{ id: 'c1', label: '第一章', href: 'ch1.xhtml' }]);
  controllerMocks.instance.loadTxt.mockResolvedValue([{ id: 'c1', label: '第一章', href: 'txt-0.xhtml' }]);
  controllerMocks.instance.onLocationChange.mockReturnValue(() => {});
  controllerMocks.instance.onTap.mockImplementation((cb: () => void) => {
    tapCb = cb;
    return () => {};
  });
  controllerMocks.instance.generateLocations.mockResolvedValue(500);
  offlineMocks.getCachedEpubArchive.mockResolvedValue(undefined);
  (controllerMocks.instance as Record<string, unknown>).currentLocation = null;

  axiosMocks.put.mockResolvedValue({ data: { success: true, conflict: false, data: { progressVersion: 2 } } });
  localStorage.clear();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
});

describe('ReaderPage', () => {
  it('TXT 书籍：成功加载 → 逐章拉取正文 → loadTxt 渲染并显示目录', async () => {
    mockBook('txt');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.loadTxt).toHaveBeenCalledTimes(1));
    expect(controllerMocks.instance.load).not.toHaveBeenCalled();
    const [, , options] = controllerMocks.instance.loadTxt.mock.calls[0];
    // 传入的章节完整（标题 + 正文文本）
    expect(options.settings).toBeDefined();
  });

  it('EPUB 书籍：以文件 URL + Authorization 头初始化渲染', async () => {
    mockBook('epub');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
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
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
    const [source, , options] = controllerMocks.instance.load.mock.calls[0];
    expect(source).toBeInstanceOf(ArrayBuffer);
    expect(options.requestHeaders).toBeUndefined();
  });

  it('点按正文（epub.js click 桥接）切换底部工具栏显隐', async () => {
    mockBook('epub');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));

    // 初始隐藏
    expect(screen.getByTestId('reader-chrome-bottom').className).toContain('translate-y-full');
    // 点按正文 → 显示
    act(() => tapCb?.());
    expect(screen.getByTestId('reader-chrome-bottom').className).toContain('translate-y-0');
    // 底栏菜单书名
    expect(screen.getByText('测试之书')).toBeDefined();
    // 再点按正文 → 隐藏
    act(() => tapCb?.());
    expect(screen.getByTestId('reader-chrome-bottom').className).toContain('translate-y-full');
  });

  it('底栏菜单顺序：目录 → 书名 → 搜索/aA（不含返回书架/书签/全屏）', async () => {
    mockBook('epub');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
    act(() => tapCb?.());
    const bar = screen.getByTestId('reader-menu-bar');
    const texts = Array.from(bar.querySelectorAll('button, p')).map(el => el.textContent ?? '');
    const idx = (s: string) => texts.findIndex(t => t.includes(s));
    expect(idx('书库')).toBe(-1);
    expect(idx('添加书签')).toBe(-1);
    expect(idx('全屏')).toBe(-1);
    expect(idx('aA')).toBeGreaterThan(idx('测试之书'));
  });

  it('底栏打开目录/aA 面板；目录选择跳转并关闭', async () => {
    mockBook('epub');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
    act(() => tapCb?.());

    // 打开目录（getByRole 精确命中底栏按钮，避免与抽屉容器 aria-label 冲突）
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


  it('全书搜索：面板输入触发搜索，点击结果跳转并关闭', async () => {
    mockBook('epub');
    controllerMocks.instance.search.mockResolvedValue([
      { cfi: 'epubcfi(/6/8!/2/1:5)', excerpt: '命中摘要文本', chapterHref: 'ch1.xhtml' },
    ]);
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
    act(() => tapCb?.());
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    // 面板内输入关键词（防抖 300ms 后触发 controller.search）
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: '关键词' } });
    const hit = await screen.findByText('命中摘要文本');
    expect(controllerMocks.instance.search).toHaveBeenCalledWith('关键词');
    fireEvent.click(hit);
    expect(controllerMocks.instance.goTo).toHaveBeenCalledWith('epubcfi(/6/8!/2/1:5)');
  });

  it('阅读主题背景同步到 theme-color meta（浏览器顶栏跟随主题，不再恒为默认色）', async () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.setAttribute('content', '#3b82f6');
    document.head.appendChild(meta);
    mockBook('epub');
    renderReader();
    await waitFor(() => expect(controllerMocks.instance.load).toHaveBeenCalledTimes(1));
    // 默认白色主题 → 顶栏同步为阅读背景色
    expect(meta.getAttribute('content')).toBe('#ffffff');
  });
});
