/**
 * readingMode — 阅读模式（分页 / 连续滚动）全局持久化
 *
 * Phase 1（D1 修复）：回归双阅读模式。
 *  - paged：epub.js 原生分栏分页（flow:'paginated'），点按分区/横滑/键盘翻页，对齐微信读书/Apple Books
 *  - scrolled：连续滚动拼接容器（现状渲染管线不变），点按分区/横滑翻屏
 * 默认 paged（用户拍板）；设置经 localStorage 全局持久化，「设置 → 外观 → 阅读模式」调节，
 * 阅读器装配时（load options.mode）读取——两种模式 renderTo 参数不同，切换后下次进入阅读生效。
 */

export type ReadingMode = 'paged' | 'scrolled';

/** 默认阅读模式（用户拍板：分页为默认，对齐主流阅读器习惯） */
export const DEFAULT_READING_MODE: ReadingMode = 'paged';

/** 全局设置 localStorage 键 */
const STORAGE_KEY = 'ireader_reading_mode';

function normalize(raw: unknown): ReadingMode {
  return raw === 'scrolled' ? 'scrolled' : raw === 'paged' ? 'paged' : DEFAULT_READING_MODE;
}

/** 读取全局阅读模式（缺失/损坏回退默认 paged） */
export function loadReadingMode(): ReadingMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_READING_MODE : normalize(raw);
  } catch {
    return DEFAULT_READING_MODE;
  }
}

/** 持久化全局阅读模式 */
export function saveReadingMode(mode: ReadingMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, normalize(mode));
  } catch { /* 存储不可用时静默 */ }
}
