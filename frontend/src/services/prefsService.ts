/**
 * 用户偏好同步服务 — 配置的服务端唯一权威源（按账号隔离）
 *
 * 设计（奥卡姆：消费模块的 localStorage 读写路径零侵入，仅写路径透传）：
 *   - savePref：立即写 localStorage（key 沿用各模块既有键名）+ 防抖 PUT 服务端
 *   - syncPrefsFromServer：登录后拉取云端偏好，按 updatedAt 双向合并：
 *       · 云端较新（或本地缺失）→ 覆盖本地缓存，并派发 ireader-prefs-synced 事件
 *         （主题等需要立即重放的消费方监听该事件）
 *       · 本地较新（离线期间的修改）→ 回写云端
 *   - 未登录 / 离线：跳过同步，行为与旧版一致（纯 localStorage，不影响离线使用）
 *
 * key 即各模块既有 localStorage 键名（ireader-theme / ireader_scroll_damping …），
 * 服务端透明存取，语义由消费方定义——新增配置项直接 savePref 即可（c1,c2… 扩展结构）。
 */
import { getToken } from './authService';

const DEBOUNCE_MS = 800;
/** 云端偏好覆盖本地后派发，消费方（如主题）监听并立即重放 */
export const PREFS_SYNCED_EVENT = 'ireader-prefs-synced';

const timers: Record<string, ReturnType<typeof setTimeout>> = {};

/** 本地时间戳键（记录本地最后修改时间，双向合并依据） */
function tsKey(key: string): string {
  return `${key}@ts`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 写偏好：立即落 localStorage + 防抖 PUT 服务端。
 * 值未变化时短路（不重复 PUT；时间戳缺失时仅补时间戳，兼容老数据）。
 */
export function savePref(key: string, value: string | number | boolean): void {
  const v = String(value);
  let prev: string | null = null;
  let ts: string | null = null;
  try {
    prev = localStorage.getItem(key);
    ts = localStorage.getItem(tsKey(key));
    localStorage.setItem(key, v);
    localStorage.setItem(tsKey(key), nowIso());
  } catch { /* 存储不可用静默 */ }

  if (prev === v && !timers[key]) {
    // 值未变化：无需 PUT（兼容老数据仅补时间戳的动作已在上方完成）
    if (ts) return;
    return;
  }
  if (timers[key]) clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    delete timers[key];
    void putPref(key, v);
  }, DEBOUNCE_MS);
}

async function putPref(key: string, value: string): Promise<void> {
  try {
    const token = getToken();
    if (!token) return; // 未登录：纯本地
    const res = await fetch(`/api/prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value }),
    });
    if (res.ok) {
      const json = await res.json();
      const updatedAt = json?.data?.updatedAt;
      if (updatedAt) {
        try { localStorage.setItem(tsKey(key), updatedAt); } catch { /* 静默 */ }
      }
    }
  } catch { /* 离线/网络失败：本地已落，下次 sync 回写 */ }
}

/**
 * 登录后同步：云端 ↔ 本地双向合并（updatedAt 新者胜）。
 * App 认证成功后调用；离线/未登录直接返回。
 */
export async function syncPrefsFromServer(): Promise<void> {
  try {
    const token = getToken();
    if (!token) return;
    const res = await fetch('/api/prefs', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const json = await res.json();
    const prefs = json?.data?.prefs as Record<string, { value: string; updatedAt: string }> | undefined;
    if (!prefs) return;

    let changed = false;
    try {
      for (const [key, remote] of Object.entries(prefs)) {
        const localVal = localStorage.getItem(key);
        const localTs = localStorage.getItem(tsKey(key)) || '';
        const remoteNewer = !localVal || !localTs || remote.updatedAt > localTs;
        if (remoteNewer) {
          // 云端较新（或本地缺失）：覆盖本地缓存
          localStorage.setItem(key, remote.value);
          localStorage.setItem(tsKey(key), remote.updatedAt);
          changed = true;
        } else if (localVal !== remote.value) {
          // 本地较新（离线期间的修改）：回写云端
          void putPref(key, localVal);
        }
      }
    } catch { /* 存储不可用静默 */ }

    if (changed) {
      window.dispatchEvent(new CustomEvent(PREFS_SYNCED_EVENT));
    }
  } catch { /* 离线/网络失败静默：下次登录再同步 */ }
}
