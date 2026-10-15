/**
 * TTS 全局常量（单一真源）
 *
 * 缺省音色/语速此前散落三处且不一致（index.ts 回退 Xiaoxiao / schema 默认 alloy /
 * init.ts 种子 Xiaoxiao），D10 修复收敛到本模块。
 */
export const DEFAULT_TTS_VOICE = 'alloy';
export const DEFAULT_TTS_SPEED = 1.0;
