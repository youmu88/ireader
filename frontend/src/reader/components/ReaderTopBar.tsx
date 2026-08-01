/**
 * ReaderTopBar — 阅读器顶栏（Apple Books 风格）
 *
 * 布局：‹ 书库（返回） | 书名（居中截断） | 目录 · aA
 * 颜色随阅读主题（chromeBackground/chromeColor 由 ReaderPage 按主题注入）。
 */

export interface ReaderTopBarProps {
  title: string;
  chromeBackground: string;
  chromeColor: string;
  onBack: () => void;
  onOpenToc: () => void;
  onOpenFontSettings: () => void;
}

export function ReaderTopBar({
  title,
  chromeBackground,
  chromeColor,
  onBack,
  onOpenToc,
  onOpenFontSettings,
}: ReaderTopBarProps) {
  return (
    <div
      className="flex items-center h-14 px-2 backdrop-blur-xl border-b"
      style={{ background: chromeBackground, color: chromeColor, borderColor: 'rgba(128,128,128,0.25)' }}
    >
      <button
        onClick={onBack}
        className="flex items-center gap-0.5 px-2 py-1.5 rounded-lg text-[15px] active:opacity-40 transition-opacity"
      >
        <svg width="11" height="18" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 2 L2 10 L10 18" />
        </svg>
        书库
      </button>
      <p className="flex-1 text-center text-[15px] font-medium truncate px-2">{title}</p>
      <div className="flex items-center">
        <button onClick={onOpenToc} aria-label="目录" className="p-2.5 rounded-lg active:opacity-40 transition-opacity">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="16" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <button
          onClick={onOpenFontSettings}
          aria-label="字体与主题"
          className="px-2.5 py-2 rounded-lg active:opacity-40 transition-opacity text-[17px] leading-none font-medium tracking-tight"
        >
          aA
        </button>
      </div>
    </div>
  );
}
