/**
 * ReaderTopBar —— 阅读器顶栏组件（Phase 5.5 从 ReaderPage 剥离，独立文件）
 */
import type { PlayerState } from '../services/ttsPlayer';

export interface ReaderTopBarProps {
  title: string;
  onBack: () => void;
  onToggleToc?: () => void;
  fontSize?: number;
  onFontSizeChange?: (s: number) => void;
  fontFamily?: 'sans' | 'serif' | 'mono';
  onFontFamilyChange?: (f: 'sans' | 'serif' | 'mono') => void;
  lineHeight?: number;
  onLineHeightChange?: (lh: number) => void;
  readingMode: 'scroll' | 'paginated';
  onToggleReadingMode: () => void;
  ttsState?: PlayerState;
  ttsActive?: boolean;
  onStartTTS?: () => void;
  onStopTTS?: () => void;
  cacheStatus?: { chapterCount: number; totalChapters: number; hasAudio: boolean } | null;
  cachingInProgress?: boolean;
  onCacheChapter?: () => void;
  onCacheFullBook?: () => void;
  onClearCache?: () => void;
}

export function ReaderTopBar({
  title,
  onBack,
  onToggleToc,
  fontSize,
  onFontSizeChange,
  fontFamily,
  onFontFamilyChange,
  lineHeight,
  onLineHeightChange,
  readingMode,
  onToggleReadingMode,
  ttsState,
  ttsActive,
  onStartTTS,
  onStopTTS,
  cacheStatus,
  cachingInProgress,
  onCacheChapter,
  onCacheFullBook,
  onClearCache,
}: ReaderTopBarProps) {
  return (
    <div className="glass flex items-center justify-between px-2 sm:px-4 py-1 sm:py-2 overflow-x-auto scrollbar-hide"
      style={{ borderBottom: '0.5px solid var(--color-border)' }}>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-sm tap-active px-2 py-1 rounded-lg transition-all duration-200"
          style={{ color: 'var(--color-primary)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="hidden sm:inline">返回</span>
        </button>
        <h1 className="text-sm font-medium truncate max-w-[120px] sm:max-w-xs"
          style={{ color: 'var(--color-text)' }}>
          {title}
        </h1>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>v0.1.0</span>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* TTS 朗读按钮 */}
        {onStartTTS && (
          <button
            onClick={ttsActive ? onStopTTS : onStartTTS}
            disabled={ttsState === 'loading'}
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
            style={{
              background: ttsActive ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
              color: ttsActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}
            title={ttsActive ? '停止朗读' : '朗读本章'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {ttsState === 'playing' ? (
                <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>
              ) : (
                <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></>
              )}
            </svg>
            <span className="hidden sm:inline">{ttsState === 'playing' ? '朗读中' : ttsState === 'paused' ? '已暂停' : ttsState === 'loading' ? '加载中' : '朗读'}</span>
          </button>
        )}
        {/* 离线缓存按钮 */}
        {onCacheChapter && (
          <>
            <button
              onClick={onCacheChapter}
              disabled={cachingInProgress}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
              style={{
                background: cacheStatus?.chapterCount ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                color: cacheStatus?.chapterCount ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              }}
              title="缓存当前章节到本地（离线可用）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span className="hidden sm:inline">{cachingInProgress ? '缓存中' : '缓存'}</span>
            </button>
            <button
              onClick={onCacheFullBook}
              disabled={cachingInProgress}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              title="缓存全书到本地（离线可用）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              <span className="hidden sm:inline">全书</span>
            </button>
            {cacheStatus && cacheStatus.chapterCount > 0 && (
              <>
                <span className="text-xs" style={{ color: 'var(--color-primary)' }} title="已缓存章节数">
                  {cacheStatus.chapterCount}/{cacheStatus.totalChapters}
                </span>
                <button
                  onClick={onClearCache}
                  className="w-6 h-6 flex items-center justify-center rounded-full tap-icon"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="清除本地缓存"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
          </>
        )}
        {onToggleToc && (
          <button
            onClick={onToggleToc}
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span className="hidden sm:inline">目录</span>
          </button>
        )}
        {/* 字体族选择 */}
        {onFontFamilyChange && (
          <select
            value={fontFamily || 'sans'}
            onChange={(e) => onFontFamilyChange(e.target.value as 'sans' | 'serif' | 'mono')}
            className="text-xs px-2 py-1.5 rounded-lg border-none cursor-pointer"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text)' }}
          >
            <option value="sans">无衬线</option>
            <option value="serif">衬线</option>
            <option value="mono">等宽</option>
          </select>
        )}
        {/* 阅读模式切换 */}
        <button
          onClick={onToggleReadingMode}
          className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
          style={{
            background: readingMode === 'paginated' ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
            color: readingMode === 'paginated' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
          }}
          title="切换阅读模式"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {readingMode === 'paginated' ? (
              <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>
            ) : (
              <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
            )}
          </svg>
          <span className="hidden sm:inline">{readingMode === 'paginated' ? '翻页' : '滚动'}</span>
        </button>
        {/* 字号控制 */}
        {onFontSizeChange && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onFontSizeChange(Math.max(12, (fontSize || 18) - 2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
            >
              A-
            </button>
            <span className="text-xs w-5 text-center" style={{ color: 'var(--color-text-secondary)' }}>{fontSize || 18}</span>
            <button
              onClick={() => onFontSizeChange(Math.min(36, (fontSize || 18) + 2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
            >
              A+
            </button>
          </div>
        )}
        {/* 行高控制 */}
        {onLineHeightChange && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onLineHeightChange(Math.max(1.2, (lineHeight || 1.8) - 0.2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              disabled={(lineHeight || 1.8) <= 1.2}
            >
              行-
            </button>
            <span className="text-xs w-5 text-center" style={{ color: 'var(--color-text-secondary)' }}>{(lineHeight || 1.8).toFixed(1)}</span>
            <button
              onClick={() => onLineHeightChange(Math.min(3.0, (lineHeight || 1.8) + 0.2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              disabled={(lineHeight || 1.8) >= 3.0}
            >
              行+
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReaderTopBar;
