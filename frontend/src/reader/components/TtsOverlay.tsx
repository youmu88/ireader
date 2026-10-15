/**
 * TtsOverlay — 听书迷你播放条（Phase 2 4.2-2）
 *
 * 独立于 ReaderChrome 渲染（菜单收起时仍可见）：当前段文本滚动展示 + 播放/暂停 +
 * 跳段 + 倍速 + 停止；章节标题与失败计数提示。
 */
import type { TtsStatus } from '../tts/useTtsSession';

export interface TtsOverlayProps {
  visible: boolean;
  status: TtsStatus;
  text: string;
  chapterTitle: string;
  rate: number;
  failedCount: number;
  chromeBackground: string;
  chromeColor: string;
  onToggle: () => void;
  onStop: () => void;
  onSkip: () => void;
  onRateChange: () => void;
}

const RATES = [1.0, 1.25, 1.5, 2.0] as const;

export function TtsOverlay({
  visible,
  status,
  text,
  chapterTitle,
  rate,
  failedCount,
  chromeBackground,
  chromeColor,
  onToggle,
  onStop,
  onSkip,
  onRateChange,
}: TtsOverlayProps) {
  if (!visible) return null;
  const playing = status === 'playing';
  const loading = status === 'loading';

  return (
    <div
      data-testid="tts-overlay"
      className="absolute left-3 right-3 z-40 rounded-2xl px-4 py-3 backdrop-blur-xl shadow-lg border"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        background: chromeBackground,
        color: chromeColor,
        borderColor: 'rgba(128,128,128,0.25)',
      }}
      role="region"
      aria-label="听书播放条"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="tts-toggle"
          onClick={onToggle}
          disabled={loading}
          className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-lg disabled:opacity-40"
          style={{ background: 'rgba(128,128,128,0.18)' }}
          aria-label={playing ? '暂停朗读' : '继续朗读'}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] opacity-60 truncate">
            {chapterTitle}{failedCount > 0 ? ` · ${failedCount} 段失败已跳过` : ''}
          </div>
          <div data-testid="tts-current-text" className="text-[13px] leading-snug truncate">
            {loading ? '正在准备朗读…' : (text || '…')}
          </div>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm"
          style={{ background: 'rgba(128,128,128,0.18)' }}
          aria-label="下一段"
        >
          ⏭
        </button>
        <button
          type="button"
          onClick={onRateChange}
          data-testid="tts-rate"
          className="shrink-0 h-9 px-2 rounded-full text-xs font-medium tabular-nums"
          style={{ background: 'rgba(128,128,128,0.18)' }}
          aria-label={`倍速 ${rate}x，点击切换`}
        >
          {rate}x
        </button>
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 h-9 px-3 rounded-full text-xs font-medium"
          style={{ background: 'rgba(128,128,128,0.18)' }}
          aria-label="停止朗读"
        >
          停止
        </button>
      </div>
      <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(128,128,128,0.18)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ background: 'rgba(10,132,255,0.9)', width: playing || status === 'paused' ? '100%' : '0%', opacity: playing ? 1 : 0.4 }}
        />
      </div>
    </div>
  );
}

export { RATES as TTS_RATES };
