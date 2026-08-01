import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchPanel, HighlightedExcerpt } from './SearchPanel';
import type { SearchResult } from '../searchBook';

const RESULTS: SearchResult[] = [
  { cfi: 'cfi(a)', excerpt: '你好世界，Hello World', chapterHref: 'ch1.xhtml' },
  { cfi: 'cfi(b)', excerpt: '另一个 hello 在这里', chapterHref: 'ch2.xhtml' },
];

const renderPanel = (props: Partial<Parameters<typeof SearchPanel>[0]> = {}) => {
  const onSearch = vi.fn();
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <SearchPanel
      open
      chromeBackground="#fff"
      chromeColor="#000"
      searching={false}
      results={[]}
      onSearch={onSearch}
      onSelect={onSelect}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSearch, onSelect, onClose };
};

describe('HighlightedExcerpt', () => {
  it('命中词以 mark 高亮（大小写不敏感），可多处', () => {
    const { container } = render(<HighlightedExcerpt excerpt="你好世界，Hello World" query="hello" />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('Hello');
  });

  it('无命中时不渲染 mark', () => {
    const { container } = render(<HighlightedExcerpt excerpt="普通文本" query="不存在" />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });
});

describe('SearchPanel', () => {
  it('输入防抖 300ms 后触发 onSearch', async () => {
    const { onSearch } = renderPanel();
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: 'hello' } });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('hello'), { timeout: 1000 });
  });

  it('渲染结果列表：摘要 + 章节标题（chapterLabelOf 反查）', () => {
    renderPanel({
      results: RESULTS,
      chapterLabelOf: href => (href === 'ch1.xhtml' ? '第一章 开始' : undefined),
    });
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: 'hello' } });
    expect(screen.getByText('第一章 开始')).toBeDefined();
    expect(screen.getByText('ch2.xhtml')).toBeDefined(); // 无映射时回退 href
  });

  it('点击结果触发 onSelect', async () => {
    const { onSelect } = renderPanel({ results: RESULTS });
    // 输入不命中摘要的词，避免高亮拆分导致完整文本无法匹配
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: 'xyz' } });
    fireEvent.click(screen.getByText('另一个 hello 在这里'));
    expect(onSelect).toHaveBeenCalledWith(RESULTS[1]);
  });

  it('搜索中/无结果/空查询三态文案', () => {
    const { unmount } = render(
      <SearchPanel open chromeBackground="#fff" chromeColor="#000" searching results={[]} onSearch={() => {}} onSelect={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: '词' } });
    expect(screen.getByText('搜索中…')).toBeDefined();
    unmount();

    renderPanel({ results: [] });
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: '词' } });
    expect(screen.getByText('未找到「词」')).toBeDefined();
  });

  it('取消：清空输入、通知清结果并关闭', async () => {
    const { onSearch, onClose } = renderPanel();
    fireEvent.change(screen.getByLabelText('搜索全书'), { target: { value: 'hello' } });
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('hello'), { timeout: 1000 });
    fireEvent.click(screen.getByText('取消'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('open=false 时透明且不响应指针', () => {
    renderPanel({ open: false });
    const panel = screen.getByTestId('search-panel');
    expect(panel.className).toContain('opacity-0');
    expect(panel.className).toContain('pointer-events-none');
  });
});
