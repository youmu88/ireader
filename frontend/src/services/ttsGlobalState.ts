/**
 * TTS 全局状态管理 — 订阅、快照、持久化、设置缓存
 *
 * 将全局播放器状态（供 BookshelfPage 等外部组件订阅）和
 * localStorage 持久化逻辑从 TTSPlayer 中分离，消除耦合。
 */

// ===== 类型定义 =====

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

export interface GlobalPlayerInfo {
  state: PlayerState;
  bookId?: string;
  bookTitle?: string;
  chapterTitle?: string;
  progress: number;
  currentIndex: number;
  totalChunks: number;
}

// ===== 全局状态订阅 =====

type GlobalStateListener = (info: GlobalPlayerInfo) => void;
const globalListeners: Set<GlobalStateListener> = new Set();

export function subscribeGlobalPlayer(listener: GlobalStateListener): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

/** 通知所有全局状态监听器 */
export function notifyGlobalListeners(info: GlobalPlayerInfo): void {
  for (const listener of globalListeners) {
    try { listener(info); } catch { /* ignore */ }
  }
}

// ===== 全局快照（provider 模式，避免循环依赖） =====

type SnapshotProvider = () => GlobalPlayerInfo | null;
let snapshotProvider: SnapshotProvider = () => null;

export function setSnapshotProvider(provider: SnapshotProvider): void {
  snapshotProvider = provider;
}

/** 获取当前全局播放器状态快照（用于非响应式场景） */
export function getGlobalPlayerSnapshot(): GlobalPlayerInfo | null {
  return snapshotProvider();
}

// ===== 最后播放记录（localStorage） =====

const LS_LAST_PLAYBACK = 'ireader_last_playback';

export interface LastPlaybackInfo {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  progress: number;
  currentIndex: number;
  timestamp: number;
}

/** 持久化当前播放状态到 localStorage */
export function savePlaybackToLocalStorage(info: Omit<LastPlaybackInfo, 'timestamp'>): void {
  try {
    localStorage.setItem(LS_LAST_PLAYBACK, JSON.stringify({ ...info, timestamp: Date.now() }));
  } catch { /* 静默 */ }
}

export function getLastPlaybackFromLocalStorage(): LastPlaybackInfo | null {
  try {
    const raw = localStorage.getItem(LS_LAST_PLAYBACK);
    if (!raw) return null;
    return JSON.parse(raw) as LastPlaybackInfo;
  } catch { return null; }
}

/**
 * 清除最后播放记录（用户在 ReaderPage 主动停止时调用）
 */
export function clearPlaybackFromLocalStorage(): void {
  try {
    localStorage.removeItem(LS_LAST_PLAYBACK);
  } catch { /* 静默 */ }
}

// ===== TTS 设置缓存（减少播放启动时的网络请求） =====

const TTS_SETTINGS_CACHE_KEY = 'ireader_tts_settings_cache';
/** TTS 设置缓存有效期（毫秒） */
const TTS_SETTINGS_CACHE_TTL = 5 * 60 * 1000; // 5分钟

/** 从 localStorage 读取缓存的 TTS 设置 */
export function getCachedTTSSettings(): { source: string; voiceId: string; speed: number } | null {
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed._cachedAt > TTS_SETTINGS_CACHE_TTL) {
      localStorage.removeItem(TTS_SETTINGS_CACHE_KEY);
      return null;
    }
    return { source: parsed.source, voiceId: parsed.voiceId, speed: parsed.speed };
  } catch { return null; }
}

/** 将 TTS 设置写入 localStorage 缓存 */
export function saveCachedTTSSettings(settings: { source?: string; voiceId?: string; speed?: number }): void {
  try {
    localStorage.setItem(TTS_SETTINGS_CACHE_KEY, JSON.stringify({
      source: settings.source,
      voiceId: settings.voiceId,
      speed: settings.speed,
      _cachedAt: Date.now(),
    }));
  } catch { /* 静默 */ }
}
