/**
 * 阅读主题定义 — 对标 Apple Books 四色主题
 * 页面容器背景与 rendition 注入样式共用同一份色值，保证观感一致。
 */
import type { ReaderSettings, ReaderTheme } from './types';

export interface ReaderThemeSpec {
  name: ReaderTheme;
  label: string;
  /** 阅读页背景 */
  background: string;
  /** 正文文字色 */
  color: string;
  /** 镀铬栏（顶栏/底栏/面板）背景：阅读背景同色系 + 半透明，配合 backdrop-blur */
  chromeBackground: string;
  /** 镀铬栏文字/图标色 */
  chromeColor: string;
  /** 深色主题标记（状态栏/面板配色用） */
  dark: boolean;
}

export const READER_THEMES: Record<ReaderTheme, ReaderThemeSpec> = {
  white: {
    name: 'white', label: '白色',
    background: '#ffffff', color: '#1c1c1e',
    chromeBackground: 'rgba(249,249,249,0.94)', chromeColor: '#1c1c1e',
    dark: false,
  },
  sepia: {
    name: 'sepia', label: '棕褐',
    background: '#f8f1e4', color: '#5f4b32',
    chromeBackground: 'rgba(243,234,220,0.94)', chromeColor: '#5f4b32',
    dark: false,
  },
  gray: {
    name: 'gray', label: '灰色',
    background: '#2c2c2e', color: '#d1d1d6',
    chromeBackground: 'rgba(38,38,40,0.94)', chromeColor: '#d1d1d6',
    dark: true,
  },
  black: {
    name: 'black', label: '黑色',
    background: '#000000', color: '#e5e5ea',
    chromeBackground: 'rgba(24,24,26,0.94)', chromeColor: '#e5e5ea',
    dark: true,
  },
};

export const READER_THEME_ORDER: ReaderTheme[] = ['white', 'sepia', 'gray', 'black'];

export const DEFAULT_READER_SETTINGS: ReaderSettings = { fontSize: 100, theme: 'white', lineHeight: 1.75, scrollMode: false };

export const FONT_SIZE_MIN = 60;
export const FONT_SIZE_MAX = 200;
export const FONT_SIZE_STEP = 10;
export const LINE_HEIGHT_OPTIONS: readonly number[] = [1.5, 1.75, 2.0];

/** 生成注入 epub.js rendition 的主题样式（颜色 + 行距；字号由 themes.fontSize 单独控制） */
export function buildRenditionTheme(spec: ReaderThemeSpec, lineHeight: number): Record<string, Record<string, string>> {
  const color = `${spec.color} !important`;
  return {
    body: {
      color,
      background: `${spec.background} !important`,
      'line-height': `${lineHeight} !important`,
    },
    'p, div, span, li, blockquote, td, th': { color },
    'h1, h2, h3, h4, h5, h6': { color },
    a: { color },
  };
}
