import { describe, expect, it } from 'vitest';
import {
  buildRenditionTheme,
  DEFAULT_READER_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  LINE_HEIGHT_OPTIONS,
  READER_THEME_ORDER,
  READER_THEMES,
} from './theme';

describe('READER_THEMES（Apple Books 四主题）', () => {
  it('包含 white/sepia/gray/black 四个主题', () => {
    expect(READER_THEME_ORDER).toEqual(['white', 'sepia', 'gray', 'black']);
    for (const name of READER_THEME_ORDER) {
      const spec = READER_THEMES[name];
      expect(spec).toBeDefined();
      expect(spec.background).toMatch(/^#/);
      expect(spec.color).toMatch(/^#/);
      expect(spec.label.length).toBeGreaterThan(0);
    }
  });

  it('深色主题标记正确（gray/black 为深色）', () => {
    expect(READER_THEMES.white.dark).toBe(false);
    expect(READER_THEMES.sepia.dark).toBe(false);
    expect(READER_THEMES.gray.dark).toBe(true);
    expect(READER_THEMES.black.dark).toBe(true);
  });
});

describe('DEFAULT_READER_SETTINGS', () => {
  it('默认字号 100%，白色主题，行距在可选范围内', () => {
    expect(DEFAULT_READER_SETTINGS.fontSize).toBe(100);
    expect(DEFAULT_READER_SETTINGS.theme).toBe('white');
    expect(LINE_HEIGHT_OPTIONS).toContain(DEFAULT_READER_SETTINGS.lineHeight);
  });

  it('字号边界常量合理', () => {
    expect(FONT_SIZE_MIN).toBeLessThan(FONT_SIZE_MAX);
    expect(DEFAULT_READER_SETTINGS.fontSize).toBeGreaterThanOrEqual(FONT_SIZE_MIN);
    expect(DEFAULT_READER_SETTINGS.fontSize).toBeLessThanOrEqual(FONT_SIZE_MAX);
    expect((FONT_SIZE_MAX - FONT_SIZE_MIN) % FONT_SIZE_STEP).toBe(0);
  });
});

describe('buildRenditionTheme', () => {
  it('注入主题色与行距（!important 覆盖书籍自带样式）', () => {
    const styles = buildRenditionTheme(READER_THEMES.sepia, 1.75);
    expect(styles.body.color).toBe('#5f4b32 !important');
    expect(styles.body.background).toBe('#f8f1e4 !important');
    expect(styles.body['line-height']).toBe('1.75 !important');
    expect(styles['h1, h2, h3, h4, h5, h6'].color).toContain('!important');
    expect(styles.a.color).toContain('!important');
  });
});
