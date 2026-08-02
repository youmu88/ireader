import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { LibraryPage } from './LibraryPage';

// confirm 依赖 ConfirmProvider 渲染容器，测试环境未挂载；统一 mock 为可配置 resolve
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, confirm: () => confirmMock() };
});

vi.mock('axios');
const mockedAxios = axios as any;

function renderPage() {
  return render(
    <MemoryRouter>
      <LibraryPage />
    </MemoryRouter>
  );
}

describe('LibraryPage 图书管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockResolvedValue({
      data: {
        success: true,
        data: [
          { id: 'b1', title: '示例书一', status: 'ready' },
          { id: 'b2', title: '示例书二', status: 'ready' },
        ],
      },
    });
  });

  it('renders three management sections', () => {
    renderPage();
    expect(screen.getByText('上传图书')).toBeDefined();
    expect(screen.getAllByText(/批量选择/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/预合成语音/i).length).toBeGreaterThan(0);
  });

  it('loads and displays books', async () => {
    renderPage();
    await screen.findByText('示例书一');
    expect(screen.getByText('示例书二')).toBeDefined();
  });

  it('filters books by search keyword', async () => {
    renderPage();
    await screen.findByText('示例书一');
    fireEvent.change(screen.getByPlaceholderText(/搜索/i), { target: { value: '书二' } });
    expect(screen.getByText('示例书二')).toBeDefined();
    expect(screen.queryByText('示例书一')).toBeNull();
  });

  it('selects all books via select-all toggle', async () => {
    renderPage();
    await screen.findByText('示例书一');
    fireEvent.click(screen.getByText(/全选/i));
    await waitFor(() => {
      expect(screen.getByText('2')).toBeDefined();
    });
  });

  it('opens TTS queue panel from pre-synthesize tab', async () => {
    renderPage();
    // 切到"预合成语音"Tab
    const preSynthButton = screen.getAllByText(/预合成语音/i).find(el => el.tagName === 'BUTTON')
      ?? screen.getAllByText(/预合成语音/i)[0];
    fireEvent.click(preSynthButton);
    // Tab 内应有"查看语音队列"入口
    fireEvent.click(screen.getByText(/查看语音队列/i));
    expect(screen.getByText(/语音生成队列/i)).toBeDefined();
  });

  it('opens TTS queue panel after submitting voice generation', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    renderPage();
    await screen.findByText('示例书一');
    fireEvent.click(screen.getByText(/全选/i));
    await waitFor(() => expect(screen.getByText('2')).toBeDefined());
    // 批量选择区应有"合成语音"提交按钮（含 🎙 前缀，区别于分段 Tab 纯文本）
    fireEvent.click(screen.getByText(/🎙.*合成语音/i));
    await waitFor(() => {
      expect(screen.getByText(/语音生成队列/i)).toBeDefined();
    });
  });

  it('batch deletes selected books via single batch-delete API', async () => {
    confirmMock.mockResolvedValue(true);
    mockedAxios.post.mockResolvedValue({ data: { success: true, data: { deleted: 2, failed: [] } } });
    renderPage();
    await screen.findByText('示例书一');
    fireEvent.click(screen.getByText(/全选/i));
    await waitFor(() => expect(screen.getByText('2')).toBeDefined());
    fireEvent.click(screen.getByText(/删除/i));
    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/books/batch-delete', { ids: ['b1', 'b2'] });
    });
  });

  it('batch caches selected books via single batch-cache API', async () => {
    mockedAxios.post.mockResolvedValue({ data: { success: true, data: { results: [{ id: 'b1', cached: 1, failed: 0 }, { id: 'b2', cached: 1, failed: 0 }] } } });
    renderPage();
    await screen.findByText('示例书一');
    fireEvent.click(screen.getByText(/全选/i));
    await waitFor(() => expect(screen.getByText('2')).toBeDefined());
    fireEvent.click(screen.getByText(/缓存离线包/i));
    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/books/batch-cache', { ids: ['b1', 'b2'] });
    });
  });
});
