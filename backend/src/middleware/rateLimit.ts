/**
 * 登录限速器（Phase 0 安全加固，D7 配套）
 *
 * 内存滑动窗：同 IP 在窗口期内登录失败达到上限后拒绝尝试（HTTP 429）。
 * 目的：防暴力破解 + 缓解 pbkdf2Sync（10 万轮）的 CPU 消耗型 DoS。
 * 成功登录不计入失败；单实例内存实现满足当前私有化单机部署形态。
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FAILURES = 5;

export interface LoginRateLimiter {
  /** 该 IP 当前窗口内是否允许尝试登录 */
  allow(ip: string): boolean;
  /** 记录一次登录失败 */
  recordFailure(ip: string): void;
  /** 当前窗口内失败次数（观测/测试用） */
  failureCount(ip: string): number;
}

export function createLoginRateLimiter(
  windowMs: number = DEFAULT_WINDOW_MS,
  maxFailures: number = DEFAULT_MAX_FAILURES,
): LoginRateLimiter {
  /** ip → 窗口内失败时间戳列表 */
  const failures = new Map<string, number[]>();

  function prune(now: number): void {
    for (const [ip, arr] of failures) {
      const alive = arr.filter(t => now - t < windowMs);
      if (alive.length === 0) failures.delete(ip);
      else failures.set(ip, alive);
    }
  }

  return {
    allow(ip: string): boolean {
      prune(Date.now());
      const arr = failures.get(ip) || [];
      return arr.length < maxFailures;
    },

    recordFailure(ip: string): void {
      const now = Date.now();
      const arr = (failures.get(ip) || []).filter(t => now - t < windowMs);
      arr.push(now);
      failures.set(ip, arr);
    },

    failureCount(ip: string): number {
      const now = Date.now();
      return (failures.get(ip) || []).filter(t => now - t < windowMs).length;
    },
  };
}
