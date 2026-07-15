import { describe, expect, it, vi } from 'vitest';
import { SerialReaderNavigator } from './ReaderNavigator';

describe('SerialReaderNavigator', () => {
  it('映射 previous/next 并返回成功', async () => {
    const previous = vi.fn();
    const next = vi.fn();
    const navigator = new SerialReaderNavigator(previous, next);
    await expect(navigator.navigate('previous')).resolves.toBe(true);
    await expect(navigator.navigate('next')).resolves.toBe(true);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('翻页未完成时拒绝并发请求', async () => {
    let finish!: () => void;
    const next = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const navigator = new SerialReaderNavigator(vi.fn(), next);
    const first = navigator.navigate('next');
    await expect(navigator.navigate('next')).resolves.toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toBe(true);
  });

  it('底层翻页失败时释放锁并返回 false', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const next = vi.fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce(undefined);
    const navigator = new SerialReaderNavigator(vi.fn(), next);
    await expect(navigator.navigate('next')).resolves.toBe(false);
    await expect(navigator.navigate('next')).resolves.toBe(true);
    consoleError.mockRestore();
  });
});
