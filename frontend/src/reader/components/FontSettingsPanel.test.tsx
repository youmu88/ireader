import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FontSettingsPanel } from './FontSettingsPanel';
import type { ReaderSettings } from '../types';
import { DEFAULT_READER_SETTINGS } from '../theme';

const renderPanel = (over: Partial<ReaderSettings> = {}, onChange = vi.fn()) => {
  const settings: ReaderSettings = { ...DEFAULT_READER_SETTINGS, ...over };
  render(
    <FontSettingsPanel
      open
      settings={settings}
      chromeBackground="#fff"
      chromeColor="#000"
      onChange={onChange}
      onClose={() => {}}
    />,
  );
  return onChange;
};

describe('FontSettingsPanel', () => {
  it('A＋ 按步进增大字号', () => {
    const onChange = renderPanel({ fontSize: 100 });
    fireEvent.click(screen.getByLabelText('增大字号'));
    expect(onChange).toHaveBeenCalledWith({ fontSize: 110 });
  });

  it('A− 按步进减小字号', () => {
    const onChange = renderPanel({ fontSize: 100 });
    fireEvent.click(screen.getByLabelText('减小字号'));
    expect(onChange).toHaveBeenCalledWith({ fontSize: 90 });
  });

  it('字号到上限时 A＋ 禁用，到下限时 A− 禁用', () => {
    renderPanel({ fontSize: 200 });
    expect((screen.getByLabelText('增大字号') as HTMLButtonElement).disabled).toBe(true);
    renderPanel({ fontSize: 60 });
    expect(screen.getAllByLabelText('减小字号')[1] && (screen.getAllByLabelText('减小字号')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('点击主题圆点切换主题', () => {
    const onChange = renderPanel();
    fireEvent.click(screen.getByLabelText('主题-棕褐'));
    expect(onChange).toHaveBeenCalledWith({ theme: 'sepia' });
    fireEvent.click(screen.getByLabelText('主题-黑色'));
    expect(onChange).toHaveBeenCalledWith({ theme: 'black' });
  });

  it('点击行距按钮切换行距', () => {
    const onChange = renderPanel();
    fireEvent.click(screen.getByText('宽松'));
    expect(onChange).toHaveBeenCalledWith({ lineHeight: 2.0 });
  });

  it('open=false 时面板透明且不响应指针', () => {
    render(
      <FontSettingsPanel
        open={false}
        settings={DEFAULT_READER_SETTINGS}
        chromeBackground="#fff"
        chromeColor="#000"
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const panel = screen.getByTestId('font-settings-panel');
    expect(panel.className).toContain('opacity-0');
    expect(panel.className).toContain('pointer-events-none');
  });

  it('点击遮罩触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <FontSettingsPanel
        open
        settings={DEFAULT_READER_SETTINGS}
        chromeBackground="#fff"
        chromeColor="#000"
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId('font-settings-panel').firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('滚动阻尼滑块（1-10）默认 3 级，拖动触发 onChange', () => {
    const onChange = renderPanel();
    const slider = screen.getByLabelText('滚动阻尼') as HTMLInputElement;
    expect(slider.value).toBe('3'); // 默认 3 级
    fireEvent.change(slider, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ scrollDamping: 7 });
  });
});
