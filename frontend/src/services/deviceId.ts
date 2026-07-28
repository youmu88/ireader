/**
 * deviceId —— 稳定设备标识
 *
 * 首次访问时生成 UUID 并持久化到 localStorage，后续读取同一值。
 * 用于阅读进度多设备冲突合并时标识写入来源。
 */

const LS_KEY = 'ireader_device_id';

let cached: string | null = null;

/** 获取当前设备的稳定唯一标识 */
export function getDeviceId(): string {
  if (cached) return cached;

  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch { /* 隐私模式等 */ }

  const id = crypto.randomUUID();
  try {
    localStorage.setItem(LS_KEY, id);
  } catch { /* 存储不可用，仅内存缓存 */ }

  cached = id;
  return id;
}
