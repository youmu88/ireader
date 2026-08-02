import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { LibraryPage } from './LibraryPage';

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
});
