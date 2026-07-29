import type { PlayerState } from '../services/ttsPlayer';

export interface TtsOverlayProps {
  ttsError: string | null;
  onDismissError: () => void;
  ttsState: PlayerState;
  ttsSegmentText: string;
}

/** TTS 浮层：错误横幅 + 当前朗读分段指示（从 ReaderPage 提取） */
export function TtsOverlay({ ttsError, onDismissError, ttsState, ttsSegmentText }: TtsOverlayProps) {
  return (
    <>
      {ttsError && (
        <div className="absolute top-0 left-0 right-0 z-10 mx-auto max-w-xl mt-2">
          <div className="bg-ios-danger-subtle border border-ios-danger rounded-lg px-4 py-2 flex items-center justify-between shadow-sm">
            <span className="text-xs sm:text-sm text-ios-danger flex-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> {ttsError}
            </span>
            <button onClick={onDismissError} className="text-xs px-2 py-1 rounded bg-ios-danger-subtle text-ios-danger ml-2 shrink-0">关闭</button>
          </div>
        </div>
      )}
      {ttsState !== 'idle' && ttsSegmentText && (
        <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
          <div className="mx-auto max-w-3xl px-3 sm:px-6 pb-16">
            <div className="bg-ios-primary-subtle rounded-lg p-3 border border-ios-primary">
              <p className="text-sm text-ios-primary line-clamp-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> {ttsSegmentText}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
