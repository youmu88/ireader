/**
 * ReaderControlPanel —— 阅读器底部控制面板（Phase 6.1 从 ReaderPage 剥离）
 *
 * 包含：TTS 播放栏 + 阅读设置（字号/行距/字体/模式）+ 章节导航 + 复制 + 缓存管理
 */
import type { PlayerState } from '../services/ttsPlayer';
import type { FontFamily, ReadingMode } from '../reader/hooks/useReaderSettings';

export interface ReaderControlPanelProps {
  // 导航
  onBack: () => void;
  onSearch: () => void;
  onToggleToc: () => void;
  showToc: boolean;
  chapterTitle: string;
  // TTS
  ttsState: PlayerState;
  ttsProgress: number;
  onStartTTS: () => void;
  onPauseTTS: () => void;
  onResumeTTS: () => void;
  onStopTTS: () => void;
  onSeek: (progress: number) => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  // 睡眠定时器
  sleepTimerMinutes: number | null;
  onSetSleepTimer: (minutes: number | null) => void;
  // 设置
  fontSize: number;
  setFontSize: (v: number) => void;
  lineHeight: number;
  setLineHeight: (v: number) => void;
  fontFamily: FontFamily;
  setFontFamily: (v: FontFamily) => void;
  readingMode: ReadingMode;
  onToggleReadingMode: () => void;
  // 章节导航
  currentChapterIndex: number;
  totalChapters: number;
  bookFormat?: string;
  pageIndex: number;
  totalPages: number;
  onPageTurn: (dir: 'prev' | 'next') => void;
  // 复制
  selectedText: string;
  onCopy: () => void;
  // 缓存
  cachingInProgress: boolean;
  cacheProgressText: string;
  cacheStatus: { chapterCount: number; totalChapters: number; hasAudio: boolean; audioChapterCount?: number } | null;
  onCacheChapter: () => void;
  onCacheFullBook: () => void;
  onClearTextCache: () => void;
  onClearAudioCache: () => void;
  // 关闭
  onClose: () => void;
}

export function ReaderControlPanel(props: ReaderControlPanelProps) {
  const {
    onBack, onSearch, onToggleToc, showToc, chapterTitle,
    ttsState, ttsProgress, onStartTTS, onPauseTTS, onResumeTTS, onStopTTS, onSeek,
    onPrevChapter, onNextChapter,
    sleepTimerMinutes, onSetSleepTimer,
    fontSize, setFontSize, lineHeight, setLineHeight, fontFamily, setFontFamily,
    readingMode, onToggleReadingMode,
    currentChapterIndex, totalChapters, bookFormat, pageIndex, totalPages, onPageTurn,
    selectedText, onCopy,
    cachingInProgress, cacheProgressText, cacheStatus,
    onCacheChapter, onCacheFullBook, onClearTextCache, onClearAudioCache,
    onClose,
  } = props;

  return (
    <>
      {/* 半透明背景 */}
      <div className="absolute inset-0 z-30 bg-black/30" onClick={onClose} />

      {/* 底部控制面板 */}
      <div className="absolute bottom-0 left-0 right-0 z-40">
        <div className="pointer-events-auto glass-bar rounded-2xl shadow-2xl mx-auto max-w-3xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
          <div className="p-5 space-y-4">
            {/* ── 第一行：返回 + 搜索 + 书名 + 目录 ── */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <button onClick={onBack} className="flex items-center gap-1.5 text-base rounded-full px-4 py-2 transition-all duration-200 tap-active"
                  style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="15 18 9 12 15 6"/></svg> 返回
                </button>
                <button onClick={onSearch} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'var(--color-bg-alt)' }} title="搜索">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
              </div>
              <h2 className="text-base font-medium truncate max-w-[45%] text-center" style={{ color: 'var(--color-text-secondary)' }}>
                {chapterTitle}
              </h2>
              <button onClick={onToggleToc} className="text-sm px-4 py-2 rounded-full font-medium transition-all duration-200 tap-active"
                style={{ background: showToc ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)', color: showToc ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                目录
              </button>
            </div>

            {/* ── 播放栏 ── */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <button onClick={(e) => { e.stopPropagation(); onPrevChapter(); }} className="w-9 h-9 rounded-full flex items-center justify-center tap-icon active:scale-85 transition-transform" style={{background: 'var(--color-bg-alt)'}} title="上一章">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                  </button>
                  {ttsState === 'playing' ? (
                    <button onClick={(e) => { e.stopPropagation(); onPauseTTS(); }} className="w-11 h-11 rounded-full flex items-center justify-center tap-icon active:scale-90 transition-transform" style={{background: 'var(--color-primary)'}} title="暂停">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    </button>
                  ) : ttsState === 'loading' ? (
                    <button disabled className="w-11 h-11 rounded-full flex items-center justify-center cursor-wait" style={{background: 'var(--color-primary)'}} title="准备中…">
                      <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round"/></svg>
                    </button>
                  ) : (
                    <button onClick={(e) => { e.stopPropagation(); if (ttsState === 'paused') onResumeTTS(); else onStartTTS(); }} className="w-11 h-11 rounded-full flex items-center justify-center tap-icon active:scale-90 transition-transform" style={{background: 'var(--color-primary)'}} title={ttsState === 'paused' ? '继续' : '播放'}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); onNextChapter(); }} className="w-9 h-9 rounded-full flex items-center justify-center tap-icon active:scale-85 transition-transform" style={{background: 'var(--color-bg-alt)'}} title="下一章">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); onStopTTS(); }} className="w-9 h-9 rounded-full flex items-center justify-center tap-icon active:scale-85 transition-transform" style={{background: 'var(--color-bg-alt)'}} title="停止">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  </button>
                </div>
                {/* 定时按钮 */}
                <button
                  onClick={() => {
                    const opts: (number | null)[] = [null, 15, 30, 60];
                    const idx = opts.indexOf(sleepTimerMinutes);
                    onSetSleepTimer(opts[(idx + 1) % opts.length]);
                  }}
                  className="text-sm px-3 py-1.5 rounded-lg transition-all duration-200 tap-active"
                  style={{ background: sleepTimerMinutes ? 'var(--color-accent-2-subtle)' : 'var(--color-bg-alt)', color: sleepTimerMinutes ? 'var(--color-accent-2)' : 'var(--color-text-secondary)' }}
                >
                  <span className="inline-flex items-center gap-1"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>{sleepTimerMinutes ? `${sleepTimerMinutes}分` : '定时'}</span>
                </button>
              </div>
              {/* 进度条 */}
              <div
                className="rounded-full h-3 cursor-pointer relative group"
                style={{ background: 'var(--color-border)' }}
                onMouseDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  onSeek(pct);
                }}
              >
                <div className="h-full rounded-full transition-none" style={{ width: `${Math.round(ttsProgress * 100)}%`, background: 'var(--color-primary)' }} />
                <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${Math.round(ttsProgress * 100)}% - 8px)` }} />
              </div>
            </div>

            <div style={{ borderTop: '0.5px solid var(--color-border)' }} />

            {/* ── 阅读设置 ── */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>字号</span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setFontSize(Math.max(12, fontSize - 2))} className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all tap-icon" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A−</button>
                  <span className="text-sm w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
                  <button onClick={() => setFontSize(Math.min(36, fontSize + 2))} className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all tap-icon" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A+</button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>行距</span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setLineHeight(Math.max(1.2, lineHeight - 0.2))} disabled={lineHeight <= 1.2} className="w-10 h-10 rounded-full flex items-center justify-center text-sm disabled:opacity-40 transition-colors" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>−</button>
                  <span className="text-sm w-8 text-center" style={{ color: 'var(--color-text-muted)' }}>{lineHeight.toFixed(1)}</span>
                  <button onClick={() => setLineHeight(Math.min(3.0, lineHeight + 0.2))} disabled={lineHeight >= 3.0} className="w-10 h-10 rounded-full flex items-center justify-center text-sm disabled:opacity-40 transition-colors" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>+</button>
                </div>
              </div>
            </div>

            {/* 样式 */}
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>样式</span>
              <div className="flex items-center gap-2">
                <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value as FontFamily)}
                  className="text-sm px-3 py-1.5 rounded-lg border-none cursor-pointer outline-none"
                  style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                  <option value="sans">无衬线</option>
                  <option value="serif">衬线</option>
                  <option value="mono">等宽</option>
                </select>
                <button onClick={onToggleReadingMode}
                  className="text-sm px-3 py-1.5 rounded-lg font-medium transition-all duration-200 tap-active"
                  style={{ background: readingMode === 'paginated' ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)', color: readingMode === 'paginated' ? 'var(--color-primary)' : 'var(--color-text-secondary)' }}>
                  {readingMode === 'paginated' ? '📖 翻页' : '📜 滚动'}
                </button>
              </div>
            </div>

            {/* ── 章节导航 ── */}
            <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-center">
                <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                  {currentChapterIndex >= 0 ? `${currentChapterIndex + 1} / ${totalChapters}` : ''}
                </span>
              </div>
              {bookFormat && readingMode === 'paginated' && (
                <div className="flex items-center justify-between mt-1">
                  {bookFormat === 'txt' ? (
                    <>
                      <button onClick={() => onPageTurn('prev')} disabled={pageIndex === 0 && currentChapterIndex === 0}
                        className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一页
                      </button>
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{pageIndex + 1} / {totalPages}</span>
                      <button onClick={() => onPageTurn('next')} disabled={pageIndex >= totalPages - 1 && currentChapterIndex === totalChapters - 1}
                        className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                        下一页 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg>
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => onPageTurn('prev')} disabled={currentChapterIndex === 0}
                        className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一章
                      </button>
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{currentChapterIndex >= 0 ? `${currentChapterIndex + 1} / ${totalChapters}` : ''}</span>
                      <button onClick={() => onPageTurn('next')} disabled={currentChapterIndex === totalChapters - 1}
                        className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                        下一章 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── 复制 ── */}
            <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-center">
                <button onClick={onCopy} disabled={!selectedText}
                  className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-full transition-all duration-200 tap-active disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                  title={selectedText ? `复制已选中的 ${selectedText.length} 个字符` : '请先长按选择文字'}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  复制
                </button>
              </div>
            </div>

            {/* ── 缓存管理 ── */}
            <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-center gap-3">
                <button onClick={onCacheChapter} disabled={cachingInProgress} className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-200 tap-active" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }} title="缓存本章">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span>本章</span>
                  </span>
                </button>
                <button onClick={onCacheFullBook} disabled={cachingInProgress} className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-200 tap-active" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }} title="缓存全书">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    <span>全书</span>
                  </span>
                </button>
                <button onClick={onClearTextCache} className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-150 tap-active" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }} title="清除文字缓存">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    <span>文字</span>
                  </span>
                </button>
                {(cacheStatus?.audioChapterCount ?? 0) > 0 && (
                  <button onClick={onClearAudioCache} className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-150 tap-active" style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }} title="清除语音缓存">
                    <span className="flex flex-col items-center gap-0.5">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      <span>语音</span>
                    </span>
                  </button>
                )}
              </div>
              {cachingInProgress && cacheProgressText && (
                <div className="flex items-center justify-center text-xs pt-1" style={{ color: 'var(--color-accent)' }}>{cacheProgressText}</div>
              )}
              {cacheStatus && cacheStatus.chapterCount > 0 && (
                <div className="flex items-center justify-center gap-3 text-xs pt-1 flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
                  <span>📖 {cacheStatus.chapterCount}/{cacheStatus.totalChapters} 章</span>
                  {cacheStatus.hasAudio && <span>🔊 语音已缓存</span>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default ReaderControlPanel;
