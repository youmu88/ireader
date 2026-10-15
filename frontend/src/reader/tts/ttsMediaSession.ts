/**
 * ttsMediaSession — MediaSession 锁屏/通知中心控制（Phase 2 4.2-2）
 *
 * 浏览器不支持时全部 no-op；播放会话状态变化由 useTtsSession 驱动。
 */

interface MediaMetadataLike {
  title: string;
  artist?: string;
  album?: string;
}

interface MediaSessionLike {
  metadata: MediaMetadataLike | null;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: string, handler: ((details?: unknown) => void) | null): void;
}

function getMediaSession(): MediaSessionLike | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { mediaSession?: MediaSessionLike }) : undefined;
  return nav?.mediaSession ?? null;
}

export interface TtsMediaInfo {
  bookTitle: string;
  chapterTitle: string;
}

/** 更新锁屏元数据（书名 + 当前章节） */
export function updateMediaMetadata(info: TtsMediaInfo): void {
  const ms = getMediaSession();
  if (!ms || typeof MediaMetadata === 'undefined') return;
  ms.metadata = new MediaMetadata({
    title: info.chapterTitle,
    artist: info.bookTitle,
    album: 'iReader',
  }) as unknown as MediaMetadataLike;
}

export function setMediaPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  const ms = getMediaSession();
  if (!ms) return;
  try {
    ms.playbackState = state;
  } catch { /* ignore */ }
}

export interface TtsMediaHandlers {
  play?: () => void;
  pause?: () => void;
  stop?: () => void;
  nextSegment?: () => void;
  prevSegment?: () => void;
}

/** 注册锁屏控制按键；传入 null 清除全部 */
export function setMediaActionHandlers(handlers: TtsMediaHandlers | null): void {
  const ms = getMediaSession();
  if (!ms) return;
  const map: Array<[string, (() => void) | undefined]> = handlers
    ? [
        ['play', handlers.play],
        ['pause', handlers.pause],
        ['stop', handlers.stop],
        ['nexttrack', handlers.nextSegment],
        ['previoustrack', handlers.prevSegment],
      ]
    : [];
  for (const [action, handler] of map) {
    try {
      ms.setActionHandler(action, handler ?? null);
    } catch { /* 部分动作浏览器不支持 */ }
  }
}
