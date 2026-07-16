/**
 * OpenAI-Compatible TTS Proxy Service
 *
 * 连接任意兼容 OpenAI TTS API 的服务，统一接口：
 *   POST /v1/audio/speech  → 语音合成（标准 OpenAI 格式）
 *   GET  /v1/audio/voices  → 音色列表（扩展端点，多数兼容服务支持）
 *   GET  /v1/models        → 模型列表（标准 OpenAI 端点）
 *   GET  /health           → 健康检查（回退）
 *
 * 用户需在设置中配置 apiUrl（必填）和 apiKey（可选），
 * 系统自动探测可用模型和音色。
 */
import { config } from 'dotenv';

config();

const DEFAULT_API_URL = process.env.TTS_API_URL || 'http://127.0.0.1:8883';
const DEFAULT_API_KEY = process.env.TTS_API_KEY || undefined;
const DEFAULT_MODEL = process.env.TTS_DEFAULT_MODEL || 'tts-1';
const TTS_REQUEST_TIMEOUT_MS = parseInt(process.env.TTS_REQUEST_TIMEOUT_MS || '30000', 10);

export interface TTSOptions {
  input: string;
  voice?: string;
  speed?: number;
  model?: string;
  response_format?: string;
  apiUrl: string;  // 必填：TTS 服务基础 URL
  apiKey?: string;  // 可选：Bearer 认证
}

export interface VoiceInfo {
  id: string;
  name: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  owned_by?: string;
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
  models?: ModelInfo[];
  error?: string;
}

export interface VoicesResult {
  success: boolean;
  data?: { voices: VoiceInfo[] };
  error?: string;
}

export interface ModelsResult {
  success: boolean;
  data?: { models: ModelInfo[] };
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
 * 获取 TTS 源描述（统一为 OpenAI 兼容）
 */
export function getSources(): TTSource[] {
  return [
    { id: 'openai', name: 'OpenAI 兼容 TTS', description: '标准 OpenAI TTS API 接口，支持任意兼容服务' },
  ];
}

/**
 * 规范化基础 URL（移除尾部斜杠）
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 获取默认配置（用于无用户设置时的回退）
 */
export function getDefaultConfig() {
  return {
    apiUrl: DEFAULT_API_URL,
    apiKey: DEFAULT_API_KEY,
    model: DEFAULT_MODEL,
  };
}

/**
 * 构建请求头
 */
function buildHeaders(apiKey?: string, contentType = 'application/json'): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * 检查 TTS 服务健康状态
 * 优先尝试 GET /v1/models（标准 OpenAI 端点），回退到 GET /health
 */
export async function checkHealth(
  apiUrl?: string,
  apiKey?: string,
): Promise<HealthResult> {
  const baseUrl = normalizeBaseUrl(apiUrl || DEFAULT_API_URL);
  const key = apiKey || DEFAULT_API_KEY;

  // 1. 尝试标准 OpenAI 端点 /v1/models
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: buildHeaders(key),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const data = await response.json();
      const models = normalizeModels(data);
      return {
        success: true,
        status: 'ok',
        service: 'openai-compatible',
        models,
      };
    }
  } catch { /* 回退到 /health */ }

  // 2. 回退到 /health
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: buildHeaders(key),
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    return { success: true, ...data };
  } catch {
    return { success: false, error: 'TTS service unavailable' };
  }
}

/**
 * 归一化模型列表：从 /v1/models 响应中提取模型信息
 */
function normalizeModels(data: any): ModelInfo[] {
  if (Array.isArray(data?.data)) {
    return data.data.map((m: any) => ({
      id: m.id,
      name: m.id,
      owned_by: m.owned_by,
    }));
  }
  if (Array.isArray(data?.models)) {
    return data.models.map((m: any) => ({
      id: typeof m === 'string' ? m : m.id,
      name: typeof m === 'string' ? m : (m.name || m.id),
      owned_by: typeof m === 'string' ? undefined : m.owned_by,
    }));
  }
  return [];
}

/**
 * 获取可用模型列表
 * GET /v1/models → 标准 OpenAI 端点
 */
export async function getModels(
  apiUrl?: string,
  apiKey?: string,
): Promise<ModelsResult> {
  const baseUrl = normalizeBaseUrl(apiUrl || DEFAULT_API_URL);
  const key = apiKey || DEFAULT_API_KEY;

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: buildHeaders(key),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { success: false, error: `Models request failed: ${response.status}` };
    }
    const data = await response.json();
    const models = normalizeModels(data);
    return { success: true, data: { models } };
  } catch {
    return { success: false, error: 'TTS service unavailable' };
  }
}

/**
 * 归一化音色列表：不同后端返回统一 { id, name } 格式
 * 兼容多种格式：
 *   - { voices: [{ id, name }] }         → 标准
 *   - { voices: ["voice1", "voice2"] }    → 字符串数组
 *   - { chinese: [...], english: [...] }  → Kokoro 格式
 *   - { data: [{ id, name }] }            → OpenAI models 风格
 */
function normalizeVoices(data: any): VoiceInfo[] {
  // 标准格式: { voices: [{ id, name }] }
  if (Array.isArray(data?.voices)) {
    return data.voices.map((v: any) => {
      if (typeof v === 'string') return { id: v, name: v };
      return { id: v.id || v.voice_id || v.name, name: v.name || v.id || v.voice_id };
    });
  }

  // Kokoro 格式: { chinese: [...], english: [...] }
  if (data?.chinese || data?.english) {
    const allIds = [...(data.chinese || []), ...(data.english || [])];
    return allIds.map((id: string) => ({ id, name: id }));
  }

  // OpenAI models 风格: { data: [{ id, ... }] }
  if (Array.isArray(data?.data)) {
    return data.data
      .filter((m: any) => typeof m === 'object' && m.id)
      .map((m: any) => ({ id: m.id, name: m.name || m.id }));
  }

  return [];
}

/**
 * 获取音色列表
 * GET /v1/audio/voices → 扩展端点（多数兼容服务支持）
 */
export async function getVoices(
  apiUrl?: string,
  apiKey?: string,
): Promise<VoicesResult> {
  const baseUrl = normalizeBaseUrl(apiUrl || DEFAULT_API_URL);
  const key = apiKey || DEFAULT_API_KEY;

  try {
    const response = await fetch(`${baseUrl}/v1/audio/voices`, {
      headers: buildHeaders(key),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { success: false, error: `Voices request failed: ${response.status}` };
    }
    const data = await response.json();
    const voices = normalizeVoices(data);
    return { success: true, data: { voices } };
  } catch {
    return { success: false, error: 'TTS service unavailable' };
  }
}

/**
 * 合成语音：标准 OpenAI TTS API
 * POST /v1/audio/speech → { model, input, voice, response_format, speed }
 */
export async function synthesize(options: TTSOptions): Promise<SynthesizeResult> {
  const {
    input,
    voice = 'alloy',
    speed = 1.0,
    model = DEFAULT_MODEL,
    response_format = 'wav',
    apiUrl,
    apiKey,
  } = options;

  if (!input?.trim()) {
    return { success: false, error: 'input is required', status: 400 };
  }

  if (!apiUrl) {
    return { success: false, error: 'apiUrl is required', status: 400 };
  }

  const baseUrl = normalizeBaseUrl(apiUrl);
  const key = apiKey || DEFAULT_API_KEY;

  try {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: buildHeaders(key),
      body: JSON.stringify({ model, input, voice, response_format, speed }),
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
