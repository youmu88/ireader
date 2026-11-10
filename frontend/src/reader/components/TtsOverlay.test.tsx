/**
 * TtsOverlay 组件测试（ai-agent 移植）：渲染/按钮回调/倍速循环/章内进度条拖动 seek
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TtsOverlay } from './TtsOverlay';

const base = {
  visible: true,
  status: 'playing' as const,
  text: '当前朗读的段落文本',
  chapterTitle: '第一章 开端',
  rate: 1.0,
  failedCount: 0,
  elapsed: 0,
  duration: 0,
  chromeBackground: '#ffffff',
  chromeColor: '#000000',
  onToggle: vi.fn(),
  onStop: vi.fn(),
  onSkip: vi.fn(),
  onRateChange: vi.fn(),
};

describe('TtsOverlay', () => {
  it('visible=false 不渲染', () => {
    const { container } = render(<TtsOverlay {...base} visible={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('展示当前段文本与章节标题', () => {
    render(<TtsOverlay {...base} />);
    expect(screen.getByTestId('tts-current-text')).toHaveTextContent('当前朗读的段落文本');
    expect(screen.getByText(/第一章 开端/)).toBeInTheDocument();
  });

  it('播放中点击切换按钮触发 onToggle（暂停语义由上层处理）', () => {
    const onToggle = vi.fn();
    render(<TtsOverlay {...base} onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('tts-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('停止/跳段/倍速回调', () => {
    const onStop = vi.fn();
    const onSkip = vi.fn();
    const onRateChange = vi.fn();
    render(<TtsOverlay {...base} onStop={onStop} onSkip={onSkip} onRateChange={onRateChange} />);
    fireEvent.click(screen.getByLabelText('停止朗读'));
    fireEvent.click(screen.getByLabelText('下一段'));
    fireEvent.click(screen.getByTestId('tts-rate'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onRateChange).toHaveBeenCalledTimes(1);
  });

  it('失败计数提示', () => {
    render(<TtsOverlay {...base} failedCount={3} />);
    expect(screen.getByText(/3 段失败已跳过/)).toBeInTheDocument();
  });

  it('loading 态展示准备文案且切换按钮禁用', () => {
    render(<TtsOverlay {...base} status="loading" text="" />);
    expect(screen.getByTestId('tts-current-text')).toHaveTextContent('正在准备朗读…');
    expect(screen.getByTestId('tts-toggle')).toBeDisabled();
  });

  it('进度条：拖动中仅改视觉不提交，松手（pointerup）才触发 onSeek', () => {
    const onSeek = vi.fn();
    render(<TtsOverlay {...base} elapsed={30} duration={100} onSeek={onSeek} />);
    const bar = screen.getByTestId('tts-progress');
    fireEvent.change(bar, { target: { value: '500' } });
    expect(onSeek).not.toHaveBeenCalled(); // 拖动中不中断播放
    fireEvent.pointerUp(bar);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0.5);
  });

  it('进度条：duration=0 或无 onSeek 时禁用（无时长模型不误导拖动）', () => {
    render(<TtsOverlay {...base} elapsed={0} duration={0} />);
    expect(screen.getByTestId('tts-progress')).toBeDisabled();
  });

  it('进度条时间标签按 mm:ss 渲染', () => {
    render(<TtsOverlay {...base} elapsed={30} duration={100} />);
    expect(screen.getByText('0:30')).toBeInTheDocument();
    expect(screen.getByText('1:40')).toBeInTheDocument();
  });
});
