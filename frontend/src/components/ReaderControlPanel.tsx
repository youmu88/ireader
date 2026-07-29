/**
 * ReaderControlPanel —— 阅读器底部控制面板（Phase 6.1 从 ReaderPage 剥离）
 *
 * 包含：TTS 播放栏 + 阅读设置（字号/行距/字体/模式）+ 章节导航 + 复制 + 缓存管理
 */
import type { PlayerState } from '../services/ttsPlayer';
import type { FontFamily, ReadingMode } from '../reader/hooks/useReaderSettings';
import { Button } from './ui/Button';
import { IconButton } from './ui/IconButton';

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
  // 播放倍速
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
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
  cacheStatus: { chapterCount: number; totalChapters: number; audioChapterCount?: number; chapterBytes?: number; audioBytes?: number; totalBytes?: number } | null;
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
    sleepTimerMinutes, onSetSleepTimer, playbackRate, onPlaybackRateChange,
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
      <div className="absolute inset-0 z-30 bg-ios-overlay" onClick={onClose} />

      {/* 底部控制面板 */}
      <div className="absolute bottom-0 left-0 right-0 z-40">
        <div className="pointer-events-auto glass-bar rounded-2xl shadow-2xl mx-auto max-w-3xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
          <div className="p-5 space-y-4">
            {/* ── 第一行：返回 + 搜索 + 书名 + 目录 ── */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Button onClick={onBack} variant="pill" size="sm">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="15 18 9 12 15 6"/></svg> 返回
                </Button>
                <IconButton onClick={onSearch} aria-label="搜索" title="搜索">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </IconButton>
              </div>
              <h2 className="text-base font-medium truncate max-w-[45%] text-center" style={{ color: 'var(--color-text-secondary)' }}>
                {chapterTitle}
              </h2>
              <Button onClick={onToggleToc} variant="pill" size="sm" active={showToc}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                目录
              </Button>
            </div>

            {/* ── 播放栏 ── */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <IconButton onClick={(e) => { e.stopPropagation(); onPrevChapter(); }} aria-label="上一章" title="上一章">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                  </IconButton>
                  {ttsState === 'playing' ? (
                    <IconButton onClick={(e) => { e.stopPropagation(); onPauseTTS(); }} variant="primary" size="lg" aria-label="暂停" title="暂停">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    </IconButton>
                  ) : ttsState === 'loading' ? (
                    <IconButton disabled variant="primary" size="lg" aria-label="准备中" title="准备中…" className="cursor-wait">
                      <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="9" opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round"/></svg>
                    </IconButton>
                  ) : (
                    <IconButton onClick={(e) => { e.stopPropagation(); if (ttsState === 'paused') onResumeTTS(); else onStartTTS(); }} variant="primary" size="lg" aria-label={ttsState === 'paused' ? '继续' : '播放'} title={ttsState === 'paused' ? '继续' : '播放'}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </IconButton>
                  )}
                  <IconButton onClick={(e) => { e.stopPropagation(); onNextChapter(); }} aria-label="下一章" title="下一章">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                  </IconButton>
                  <IconButton onClick={(e) => { e.stopPropagation(); onStopTTS(); }} aria-label="停止" title="停止">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  </IconButton>
                </div>
                {/* 倍速按钮 */}
                <Button
                  onClick={() => {
                    const opts = [0.75, 1, 1.25, 1.5, 2];
                    const idx = opts.indexOf(playbackRate);
                    onPlaybackRateChange(opts[(idx + 1) % opts.length]);
                  }}
                  variant="pill"
                  size="xs"
                  active={playbackRate !== 1}
                  title="播放倍速"
                >
                  {playbackRate}x
                </Button>
                {/* 定时按钮 */}
                <Button
                  onClick={() => {
                    const opts: (number | null)[] = [null, 15, 30, 60];
                    const idx = opts.indexOf(sleepTimerMinutes);
                    onSetSleepTimer(opts[(idx + 1) % opts.length]);
                  }}
                  variant="pill"
                  size="xs"
                  active={!!sleepTimerMinutes}
                >
                  <span className="inline-flex items-center gap-1"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>{sleepTimerMinutes ? `${sleepTimerMinutes}分` : '定时'}</span>
                </Button>
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
                <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-ios-primary rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${Math.round(ttsProgress * 100)}% - 8px)` }} />
              </div>
            </div>

            <div style={{ borderTop: '0.5px solid var(--color-border)' }} />

            {/* ── 阅读设置 ── */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>字号</span>
                <div className="flex items-center gap-1.5">
                  <IconButton onClick={() => setFontSize(Math.max(12, fontSize - 2))} size="md" aria-label="缩小字号">A−</IconButton>
                  <span className="text-sm w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
                  <IconButton onClick={() => setFontSize(Math.min(36, fontSize + 2))} size="md" aria-label="放大字号">A+</IconButton>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>行距</span>
                <div className="flex items-center gap-1.5">
                  <IconButton onClick={() => setLineHeight(Math.max(1.2, lineHeight - 0.2))} disabled={lineHeight <= 1.2} size="md" aria-label="减小行距">−</IconButton>
                  <span className="text-sm w-8 text-center" style={{ color: 'var(--color-text-muted)' }}>{lineHeight.toFixed(1)}</span>
                  <IconButton onClick={() => setLineHeight(Math.min(3.0, lineHeight + 0.2))} disabled={lineHeight >= 3.0} size="md" aria-label="增大行距">+</IconButton>
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
                <Button onClick={onToggleReadingMode} variant="pill" size="xs" active={readingMode === 'paginated'}>
                  {readingMode === 'paginated' ? '📖 翻页' : '📜 滚动'}
                </Button>
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
                      <Button onClick={() => onPageTurn('prev')} disabled={pageIndex === 0 && currentChapterIndex === 0} variant="pill" size="xs">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一页
                      </Button>
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{pageIndex + 1} / {totalPages}</span>
                      <Button onClick={() => onPageTurn('next')} disabled={pageIndex >= totalPages - 1 && currentChapterIndex === totalChapters - 1} variant="pill" size="xs">
                        下一页 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg>
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button onClick={() => onPageTurn('prev')} disabled={currentChapterIndex === 0} variant="pill" size="xs">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一章
                      </Button>
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{currentChapterIndex >= 0 ? `${currentChapterIndex + 1} / ${totalChapters}` : ''}</span>
                      <Button onClick={() => onPageTurn('next')} disabled={currentChapterIndex === totalChapters - 1} variant="pill" size="xs">
                        下一章 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg>
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── 复制 ── */}
            <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-center">
                <Button onClick={onCopy} disabled={!selectedText} variant="pill" size="sm"
                  title={selectedText ? `复制已选中的 ${selectedText.length} 个字符` : '请先长按选择文字'}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  复制
                </Button>
              </div>
            </div>

            {/* ── 缓存管理 ── */}
            <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-center gap-3">
                <IconButton onClick={onCacheChapter} disabled={cachingInProgress} size="xl" aria-label="缓存本章" title="缓存本章">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    <span>本章</span>
                  </span>
                </IconButton>
                <IconButton onClick={onCacheFullBook} disabled={cachingInProgress} size="xl" aria-label="缓存全书" title="缓存全书">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    <span>全书</span>
                  </span>
                </IconButton>
                <IconButton onClick={onClearTextCache} size="xl" aria-label="清除文字缓存" title="清除文字缓存">
                  <span className="flex flex-col items-center gap-0.5">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    <span>文字</span>
                  </span>
                </IconButton>
                {(cacheStatus?.audioChapterCount ?? 0) > 0 && (
                  <IconButton onClick={onClearAudioCache} size="xl" aria-label="清除语音缓存" title="清除语音缓存">
                    <span className="flex flex-col items-center gap-0.5">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      <span>语音</span>
                    </span>
                  </IconButton>
                )}
              </div>
              {cachingInProgress && cacheProgressText && (
                <div className="flex items-center justify-center text-xs pt-1" style={{ color: 'var(--color-accent)' }}>{cacheProgressText}</div>
              )}
              {cacheStatus && cacheStatus.chapterCount > 0 && (
                <div className="flex items-center justify-center gap-3 text-xs pt-1 flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
                  <span>📖 {cacheStatus.chapterCount}/{cacheStatus.totalChapters} 章</span>
                  {(cacheStatus.audioChapterCount ?? 0) > 0 && <span>🔊 语音已缓存</span>}
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
