import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import BookshelfPage, { sortShelfBooks } from '../BookshelfPage';

const mkBook = (over: Partial<{ id: string; title: string; pinned: number; lastReadAt: string | null }> = {}) => ({
  id: over.id ?? 'b1',
  title: over.title ?? '书名',
  author: null,
  format: 'epub' as const,
  categoryId: null,
  coverPath: null,
  status: 'ready' as const,
  parseError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  pinned: over.pinned ?? 0,
  lastReadAt: over.lastReadAt ?? null,
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ isOfflineMode: false, exitOfflineMode: vi.fn() }),
}));

describe('BookshelfPage', () => {
  it('should render loading state initially', () => {
    render(
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <BookshelfPage />
      </BrowserRouter>
    );
    expect(screen.getByText('加载中...')).toBeDefined();
  });
});

describe('sortShelfBooks', () => {
  it('最近阅读优先（lastReadAt 降序），无阅读记录按书名升序', () => {
    const books = [
      mkBook({ id: 'a', title: 'Z书', lastReadAt: null }),
      mkBook({ id: 'b', title: 'A书', lastReadAt: '2026-08-01T10:00:00Z' }),
      mkBook({ id: 'c', title: 'M书', lastReadAt: '2026-07-01T10:00:00Z' }),
      mkBook({ id: 'd', title: 'B书', lastReadAt: null }),
    ];
    const sorted = sortShelfBooks(books);
    expect(sorted.map(b => b.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('置顶始终最前，其余按最近阅读', () => {
    const books = [
      mkBook({ id: 'x', title: 'X书', lastReadAt: '2026-09-01T10:00:00Z' }),
      mkBook({ id: 'y', title: 'Y书', lastReadAt: null, pinned: 1 }),
      mkBook({ id: 'z', title: 'Z书', lastReadAt: '2026-08-01T10:00:00Z' }),
    ];
    const sorted = sortShelfBooks(books);
    expect(sorted.map(b => b.id)).toEqual(['y', 'x', 'z']);
  });

  it('未读书籍之间严格按名称升序（多本未读场景）', () => {
    const books = [
      mkBook({ id: 'c', title: 'Z书', lastReadAt: null }),
      mkBook({ id: 'a', title: 'A书', lastReadAt: null }),
      mkBook({ id: 'b', title: 'M书', lastReadAt: null }),
    ];
    const sorted = sortShelfBooks(books);
    expect(sorted.map(b => b.id)).toEqual(['a', 'b', 'c']);
  });

  it('混合场景：已读按时间降序在前，未读按名称升序在后，未读不混入已读区间', () => {
    const books = [
      mkBook({ id: 'u2', title: '乙书', lastReadAt: null }),
      mkBook({ id: 'r1', title: 'X书', lastReadAt: '2026-08-01T10:00:00Z' }),
      mkBook({ id: 'u1', title: '甲书', lastReadAt: null }),
      mkBook({ id: 'r2', title: 'Y书', lastReadAt: '2026-09-01T10:00:00Z' }),
    ];
    const sorted = sortShelfBooks(books);
    expect(sorted.map(b => b.id)).toEqual(['r2', 'r1', 'u1', 'u2']);
  });
});
