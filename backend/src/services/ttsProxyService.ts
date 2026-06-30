/**
 * TTS Proxy Service
 * 将请求转发到 Kokoro/MegaTTS3 后端，归一化响应格式
 */
import { config } from 'dotenv';

config();

const DEFAULT_TTS_URL = process.env.TTS_URL || 'http://127.0.0.1:8880';
const DEFAULT_MEGATTS3_URL = process.env.MEGATTS3_URL || 'http://127.0.0.1:8882';
const DEFAULT_TTS_SOURCE = process.env.TTS_DEFAULT_SOURCE || 'kokoro';
const TTS_REQUEST_TIMEOUT_MS = parseInt(process.env.TTS_REQUEST_TIMEOUT_MS || '30000', 10);

export interface TTSOptions {
  input: string;
  voice?: string;
  speed?: number;
  response_format?: string;
  tts_source?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
}

export interface TTSource {
  id: string;
  name: string;
  description: string;
}

export interface HealthResult {
  success: boolean;
  status?: string;
  service?: string;
  memory_mb?: number;
  error?: string;
}

export interface VoicesResult {
  success: boolean;
  data?: { voices: VoiceInfo[] };
  error?: string;
}

export interface SynthesizeResult {
  success: boolean;
  audio?: Buffer;
  contentType?: string;
  error?: string;
  status?: number;
}

/**
 * 获取可用的 TTS 源列表
 */
export function getSources(): TTSource[] {
  return [
    { id: 'kokoro', name: 'Kokoro（默认）', description: '轻量级 TTS，支持多种音色' },
    { id: 'megatts3', name: 'MegaTTS3', description: '字节跳动高保真语音克隆 TTS' },
  ];
}

/**
 * 根据 source 获取 TTS 后端基础 URL
 */
function getBaseUrl(source: string): string {
  return source === 'megatts3' ? DEFAULT_MEGATTS3_URL : DEFAULT_TTS_URL;
}

/**
 * 检查 TTS 服务健康状态
 */
export async function checkHealth(source: string = DEFAULT_TTS_SOURCE): Promise<HealthResult> {
  const baseUrl = getBaseUrl(source);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    return { success: true, ...data };
  } catch {
    return { success: false, error: 'TTS service unavailable' };
  }
}

/**
 * Kokoro 音色名称映射
 */
const KOKORO_NAME_MAP: Record<string, string> = {
  'zf_xiaobei': '小北', 'zf_xiaoni': '小妮', 'zf_xiaoxiao': '潇潇',
  'zf_xiaoyi': '小仪', 'zm_yunjian': '云剑', 'zm_yunxi': '云希',
  'zm_yunxia': '云夏', 'zm_yunyang': '云扬',
  'af_heart': 'Heart', 'af_bella': 'Bella', 'af_nicole': 'Nicole',
  'af_sarah': 'Sarah', 'af_sky': 'Sky', 'am_adam': 'Adam',
  'am_michael': 'Michael', 'bm_george': 'George', 'bf_emma': 'Emma',
};

/**
 * 归一化音色列表：不同后端返回统一 { id, name } 格式
 */
function normalizeVoices(data: any): VoiceInfo[] {
  if (Array.isArray(data.voices)) {
    return data.voices;
  }
  if (data.chinese || data.english) {
    const allIds = [...(data.chinese || []), ...(data.english || [])];
    return allIds.map((id: string) => ({ id, name: KOKORO_NAME_MAP[id] || id }));
  }
  return [];
}

/**
 * 获取指定 TTS 源的音色列表
 */
export async function getVoices(source: string = DEFAULT_TTS_SOURCE): Promise<VoicesResult> {
  const baseUrl = getBaseUrl(source);
  try {
    const response = await fetch(`${baseUrl}/v1/audio/voices`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    const voices = normalizeVoices(data);
    return { success: true, data: { voices } };
  } catch {
    return { success: false, error: 'TTS service unavailable' };
  }
}

/**
 * 合成语音：将文本发送到 TTS 后端，返回音频二进制
 */
export async function synthesize(options: TTSOptions): Promise<SynthesizeResult> {
  const {
    input,
    voice = 'alloy',
    speed = 1.0,
    response_format = 'wav',
    tts_source = DEFAULT_TTS_SOURCE,
  } = options;

  if (!input?.trim()) {
    return { success: false, error: 'input is required', status: 400 };
  }

  const baseUrl = getBaseUrl(tts_source);

  try {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, voice, speed, response_format }),
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown');
      return { success: false, error: `TTS failed: ${errText.slice(0, 200)}`, status: response.status };
    }

    const audioBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/wav';
    return { success: true, audio: Buffer.from(audioBuffer), contentType };
  } catch (error) {
    return { success: false, error: 'TTS service unavailable', status: 502 };
  }
}
