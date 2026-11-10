import '@testing-library/jest-dom';
import '@testing-library/jest-dom';

// Polyfill IndexedDB for jsdom (used by offlineCacheService)
import 'fake-indexeddb/auto';

// Mock window.matchMedia for jsdom (used by themeService)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Node ≥22 的原生全局 localStorage 残缺（无 clear，连 constructor 都不可访问），
// 在 vitest jsdom 环境里会遮蔽 jsdom 注入的完整 Storage（实测 node v25.8.1）。
// 这里用自建完整 Storage（Map 支撑，W3C 全接口）覆盖，仅原生实现残缺时触发。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
}

function nativeStorageIsBroken(): boolean {
  try {
    return typeof localStorage === 'undefined' || typeof localStorage.clear !== 'function';
  } catch {
    return true; // 原生对象连属性访问都抛错
  }
}

if (nativeStorageIsBroken()) {
  const storage = new MemoryStorage();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage,
    });
  } catch {
    /* 保持现状 */
  }
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage,
    });
  } catch {
    /* globalThis 已覆盖即可满足裸引用 */
  }
}
