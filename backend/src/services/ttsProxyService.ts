/**
 * TTS Proxy Service
 * 将请求转发到 Kokoro/MegaTTS3 后端（预设）或自定义 TTS API，归一化响应格式
 * 自定义 TTS API 需兼容 OpenAI TTS 格式：
 *   GET  /v1/audio/voices  → 音色列表
 *   POST /v1/audio/speech  → 语音合成
 *   GET  /health           → 健康检查
 */
import { config } from 'dotenv';

config();

const DEFAULT_TTS_URL = process.env.TTS_URL || 'http://127.0.0.1:8880';
const DEFAULT_MEGATTS3_URL = process.env.MEGATTS3_URL || 'http://127.0.0.1:8882';
const DEFAULT_EDGETTS_URL = process.env.EDGETTS_URL || 'http://127.0.0.1:8883';
const DEFAULT_TTS_SOURCE = process.env.TTS_DEFAULT_SOURCE || 'edgetts';
const TTS_REQUEST_TIMEOUT_MS = parseInt(process.env.TTS_REQUEST_TIMEOUT_MS || '30000', 10);

const PRESET_URLS: Record<string, string> = {
  kokoro: DEFAULT_TTS_URL,
  megatts3: DEFAULT_MEGATTS3_URL,
  edgetts: DEFAULT_EDGETTS_URL,
};

export interface TTSOptions {
  input: string;
  voice?: string;
  speed?: number;
  response_format?: string;
  tts_source?: string;
  apiUrl?: string;  // 自定义 API URL
  apiKey?: string;  // 可选 API Key
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
 * 获取可用的 TTS 源/预设列表
 */
export function getSources(): TTSource[] {
  return [
    { id: 'kokoro', name: 'Kokoro（默认）', description: '轻量级 TTS，支持多种音色' },
    { id: 'megatts3', name: 'MegaTTS3', description: '字节跳动高保真语音克隆 TTS' },
    { id: 'edgetts', name: 'Edge-TTS', description: '微软 Edge 在线 TTS（中英文，无需 GPU）' },
    { id: 'custom', name: '自定义 TTS API', description: '兼容 OpenAI TTS 格式的自定义服务' },
  ];
}

/**
 * 根据 source 和可选的 apiUrl 获取 TTS 后端基础 URL
 * - 如果传入了 apiUrl，直接使用（自定义模式）
 * - 否则从预设 URL 中查找
 * - 兜底返回默认 TTS_URL
 */
function getBaseUrl(source: string, apiUrl?: string): string {
  if (apiUrl) return apiUrl.replace(/\/+$/, '');
  return PRESET_URLS[source] || DEFAULT_TTS_URL;
}

/**
 * 构建请求头（如果 apiKey 存在则附加 Bearer 认证）
 */
function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * 检查 TTS 服务健康状态
 */
export async function checkHealth(
  source: string = DEFAULT_TTS_SOURCE,
  apiUrl?: string,
  apiKey?: string,
): Promise<HealthResult> {
  const baseUrl = getBaseUrl(source, apiUrl);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: buildHeaders(apiKey),
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
 * 支持自定义 API URL（apiUrl）和 API Key（apiKey）
 */
export async function getVoices(
  source: string = DEFAULT_TTS_SOURCE,
  apiUrl?: string,
  apiKey?: string,
): Promise<VoicesResult> {
  const baseUrl = getBaseUrl(source, apiUrl);
  try {
    const response = await fetch(`${baseUrl}/v1/audio/voices`, {
      headers: buildHeaders(apiKey),
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
    apiUrl,
    apiKey,
  } = options;

  if (!input?.trim()) {
    return { success: false, error: 'input is required', status: 400 };
  }

  const baseUrl = getBaseUrl(tts_source, apiUrl);

  try {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: buildHeaders(apiKey),
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
