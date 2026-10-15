import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_READING_MODE,
  loadReadingMode,
  saveReadingMode,
} from './readingMode';

afterEach(() => {
  localStorage.clear();
});

describe('readingMode（阅读模式持久化）', () => {
  it('默认分页（用户拍板：paged 为默认）', () => {
    expect(DEFAULT_READING_MODE).toBe('paged');
    expect(loadReadingMode()).toBe('paged');
  });

  it('save 后 load 读回（scrolled / paged 双向）', () => {
    saveReadingMode('scrolled');
    expect(loadReadingMode()).toBe('scrolled');
    saveReadingMode('paged');
    expect(loadReadingMode()).toBe('paged');
  });

  it('损坏存储值回退默认 paged', () => {
    localStorage.setItem('ireader_reading_mode', 'page-turn-xyz');
    expect(loadReadingMode()).toBe('paged');
  });

  it('空串存储值回退默认 paged', () => {
    localStorage.setItem('ireader_reading_mode', '');
    expect(loadReadingMode()).toBe('paged');
  });
});
