import { describe, expect, it } from 'vitest';
import {
  buildRenditionThemeCss,
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

  it('深色主题 chrome 背景接近不透明（对标深色底栏，不依赖 backdrop-filter）', () => {
    // 深色主题（gray/black）：alpha >= 0.98，blur 失效时底栏仍为深色
    expect(READER_THEMES.gray.chromeBackground).toBe('rgba(38,38,40,0.98)');
    expect(READER_THEMES.black.chromeBackground).toBe('rgba(24,24,26,0.98)');
    // 浅色主题也足够不透明，防止透出正文文字
    expect(READER_THEMES.white.chromeBackground).toBe('rgba(249,249,249,0.96)');
    expect(READER_THEMES.sepia.chromeBackground).toBe('rgba(243,234,220,0.96)');
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

describe('buildRenditionThemeCss', () => {
  it('生成主题色 + 行距 CSS 文本（!important 覆盖书籍自带样式）', () => {
    const css = buildRenditionThemeCss(READER_THEMES.sepia, 1.75);
    expect(css).toContain('body { color: #5f4b32 !important; background: #f8f1e4 !important; line-height: 1.75 !important; }');
    // html 根元素同样注入：EPUB 书 CSS 常在 html 上设背景（如白底），
    // 只注 body 会让书自带底色在正文四周/章节间隙透出 → 设置主题色后版面不变
    expect(css).toContain('html { background: #f8f1e4 !important; color: #5f4b32 !important; }');
    expect(css).toContain('h1, h2, h3, h4, h5, h6 { color: #5f4b32 !important; line-height: 1.75 !important; }');
    expect(css).toContain('a { color: #5f4b32 !important; }');
  });

  it('行距同时注入段落/标题子元素选择器（修复书籍 p 显式 line-height 覆盖导致三档无效）', () => {
    const css = buildRenditionThemeCss(READER_THEMES.black, 2.0);
    expect(css).toContain('p, div, span, li, blockquote, td, th { color: #e5e5ea !important; line-height: 2 !important; }');
    expect(css).toContain('h1, h2, h3, h4, h5, h6 { color: #e5e5ea !important; line-height: 2 !important; }');
    // 紧凑档同样覆盖子元素
    const compact = buildRenditionThemeCss(READER_THEMES.white, 1.5);
    expect(compact).toContain('p, div, span, li, blockquote, td, th { color: #1c1c1e !important; line-height: 1.5 !important; }');
  });
});
