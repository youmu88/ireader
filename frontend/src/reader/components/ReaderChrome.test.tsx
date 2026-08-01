import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderChrome } from './ReaderChrome';
import { ReaderBottomBar } from './ReaderBottomBar';
import type { ReaderLocation } from '../types';

describe('ReaderChrome', () => {
  it('visible=true 时底栏滑入（translate-y-0）', () => {
    render(<ReaderChrome visible>BOTTOM</ReaderChrome>);
    expect(screen.getByTestId('reader-chrome-bottom').className).toContain('translate-y-0');
  });

  it('visible=false 时底栏下滑隐藏且禁用指针', () => {
    render(<ReaderChrome visible={false}>BOTTOM</ReaderChrome>);
    const bottom = screen.getByTestId('reader-chrome-bottom');
    expect(bottom.className).toContain('translate-y-full');
    expect(bottom.className).toContain('pointer-events-none');
  });
});

describe('ReaderBottomBar', () => {
  const baseLoc: ReaderLocation = {
    cfi: 'epubcfi(/6/2!/4)',
    percentage: 0.42,
    pageInChapter: 3,
    pagesInChapter: 11,
  };

  it('全局页码就绪：显示「第 X 页，共 Y 页」与百分比，滑块可用', () => {
    render(
      <ReaderBottomBar
        location={{ ...baseLoc, globalPage: 210, totalPages: 500 }}
        locationsReady
        chromeBackground="#fff"
        chromeColor="#000"
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText('第 210 页，共 500 页')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
    expect((screen.getByLabelText('阅读进度') as HTMLInputElement).disabled).toBe(false);
  });

  it('页码计算中：显示章节内页码，滑块禁用', () => {
    render(
      <ReaderBottomBar
        location={baseLoc}
        locationsReady={false}
        chromeBackground="#fff"
        chromeColor="#000"
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText('本章第 3 页 / 共 11 页')).toBeDefined();
    expect(screen.getByText('页码计算中…')).toBeDefined();
    expect((screen.getByLabelText('阅读进度') as HTMLInputElement).disabled).toBe(true);
  });

  it('拖动滑块触发 onSeek（0-1 百分比）', () => {
    const onSeek = vi.fn();
    render(
      <ReaderBottomBar
        location={{ ...baseLoc, globalPage: 210, totalPages: 500 }}
        locationsReady
        chromeBackground="#fff"
        chromeColor="#000"
        onSeek={onSeek}
      />,
    );
    fireEvent.change(screen.getByLabelText('阅读进度'), { target: { value: '600' } });
    expect(onSeek).toHaveBeenCalledWith(0.6);
  });
});
