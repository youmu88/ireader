/**
 * ReaderBottomBar — 阅读器底栏（Apple Books 风格）
 *
 * 进度滑块（全局页码就绪后可拖动跳转） + 页码文本：
 *  - 页码就绪：「第 X 页，共 Y 页」 + 百分比
 *  - 计算中：「本章第 x / y 页」 + 「页码计算中…」
 */
import type { ReaderLocation } from '../types';

export interface ReaderBottomBarProps {
  location: ReaderLocation | null;
  locationsReady: boolean;
  chromeBackground: string;
  chromeColor: string;
  onSeek: (percentage: number) => void;
}

export function ReaderBottomBar({
  location,
  locationsReady,
  chromeBackground,
  chromeColor,
  onSeek,
}: ReaderBottomBarProps) {
  const percentage = location?.percentage ?? 0;
  const showGlobal = locationsReady && location?.globalPage != null && location?.totalPages != null;
  const pageText = showGlobal
    ? `第 ${location!.globalPage} 页，共 ${location!.totalPages} 页`
    : location
      ? `本章第 ${location.pageInChapter} 页 / 共 ${location.pagesInChapter} 页`
      : '';

  return (
    <div
      className="px-5 pt-3 pb-6 backdrop-blur-xl border-t"
      style={{ background: chromeBackground, color: chromeColor, borderColor: 'rgba(128,128,128,0.25)' }}
    >
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(percentage * 1000)}
        disabled={!locationsReady}
        onChange={e => onSeek(Number(e.target.value) / 1000)}
        className="w-full cursor-pointer disabled:cursor-default disabled:opacity-30 accent-current"
        aria-label="阅读进度"
      />
      <div className="flex justify-between mt-2 text-xs" style={{ opacity: 0.7 }}>
        <span>{pageText}</span>
        <span>{locationsReady ? `${Math.round(percentage * 100)}%` : '页码计算中…'}</span>
      </div>
    </div>
  );
}
