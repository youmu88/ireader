/**
 * TTS 全局常量（单一真源）
 *
 * 缺省音色/语速此前散落三处且不一致（index.ts 回退 Xiaoxiao / schema 默认 alloy /
 * init.ts 种子 Xiaoxiao），D10 修复收敛到本模块。
 */
export const DEFAULT_TTS_VOICE = 'alloy';

/**
 * TTS 分片档位（ai-agent 移植）——单一真源（schema/init/routes 缺省共用，禁止在调用点重写数字）：
 * - 首段 64 字：点开听书 ≤1s 快速出声（Kokoro RTF≈0.047，64 字合成 ≈0.3s）
 * - 第二段 64 字：章名播完后紧接的第二段也小档快速出声，给后续 400 字大段争取合成时间（消除段间空档）
 * - 其余段 400 字：配合句末换行（ensureSentenceLineBreaks）引擎按句分段合成不截断，
 *   相比旧 128 档碎片减半以上，减少播放衔接次数
 */
export const DEFAULT_FIRST_CHUNK_MAX = 64;
export const DEFAULT_SECOND_CHUNK_MAX = 64;
export const DEFAULT_NORMAL_CHUNK_MAX = 400;
export const DEFAULT_TTS_SPEED = 1.0;
