/**
 * Compatibility Service — 设备兼容性检测与性能分级
 *
 * 纯函数模块（不含 JSX / React Context），供 themeService 调用。
 * 策略：渐进增强（Progressive Enhancement）
 * - 老旧设备：使用保守兼容技术，禁用高开销动效/毛玻璃
 * - 新设备：默认使用现代特性，提供最佳体验
 * - 通过 Feature Detection + 性能指标分级，非硬编码浏览器版本
 *
 * 使用方式：import { detectCompatibility } from './compatibilityService';
 */

// ── 设备性能等级 ──

export type DeviceTier = 'low' | 'medium' | 'high';

export interface CompatibilityInfo {
  /** 设备性能等级 */
  tier: DeviceTier;
  /** 是否应禁用毛玻璃效果（低性能设备） */
  disableGlass: boolean;
  /** 是否应减少动效（低性能设备 + prefers-reduced-motion） */
  reducedMotion: boolean;
  /** CPU 逻辑核心数（navigator.hardwareConcurrency） */
  cpuCores: number;
  /** 设备内存（GB，navigator.deviceMemory，可能为 undefined） */
  deviceMemory: number | undefined;
  /** 是否支持 backdrop-filter */
  supportsBackdropFilter: boolean;
}

// ── 性能检测函数 ──

function detectBackdropFilterSupport(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return false;
  }
  return CSS.supports('backdrop-filter', 'blur(1px)') ||
         CSS.supports('-webkit-backdrop-filter', 'blur(1px)');
}

function detectReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function detectDeviceTier(): { tier: DeviceTier; cpuCores: number; deviceMemory: number | undefined } {
  const cpuCores = navigator.hardwareConcurrency || 0;
  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;

  // 低性能：CPU <= 2 核，或 内存 <= 2GB（且内存信息可用）
  if (cpuCores > 0 && cpuCores <= 2) {
    return { tier: 'low', cpuCores, deviceMemory };
  }
  if (deviceMemory !== undefined && deviceMemory <= 2) {
    return { tier: 'low', cpuCores, deviceMemory };
  }

  // 中性能：CPU 4 核，或 内存 4GB
  if (cpuCores <= 4 || (deviceMemory !== undefined && deviceMemory <= 4)) {
    return { tier: 'medium', cpuCores, deviceMemory };
  }

  // 高性能：CPU >= 6 核且内存 >= 8GB（或信息不可用时默认为 high）
  return { tier: 'high', cpuCores, deviceMemory };
}

// ── 检测结果缓存（避免重复计算） ──

let cachedInfo: CompatibilityInfo | null = null;

/**
 * 检测设备兼容性并返回分级信息。
 * 结果会缓存，多次调用只计算一次。
 */
export function detectCompatibility(): CompatibilityInfo {
  if (cachedInfo) return cachedInfo;

  const { tier, cpuCores, deviceMemory } = detectDeviceTier();
  const supportsBackdropFilter = detectBackdropFilterSupport();
  const reducedMotion = detectReducedMotion();

  cachedInfo = {
    tier,
    cpuCores,
    deviceMemory,
    supportsBackdropFilter,
    reducedMotion,
    disableGlass: tier === 'low' || !supportsBackdropFilter,
  };

  return cachedInfo;
}
