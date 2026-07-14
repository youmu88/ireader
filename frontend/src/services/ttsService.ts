/**
 * 前端 TTS 服务
 * 封装后端 TTS API 调用，包括设置管理、音色查询、连接测试、语音合成
 */

import { getToken } from './authService';

/**
 * 获取认证请求头（自动附加 Bearer token）
 */
function getAuthHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface TTSource {
  id: string;
  name: string;
  description: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
}

export interface TTSSettings {
  id: number;
  enabled: boolean;
  source: string;
  voiceId: string;
  speed: number;
  apiUrl: string | null;
  apiKey: string | null;
  preGenerateConcurrency: number;
  firstChunkMaxSize: number;
  normalChunkMaxSize: number;
  autoPreSynthesize?: boolean;
  updatedAt: string;
}

export interface HealthResult {
  success: boolean;
  status?: string;
  service?: string;
  memory_mb?: number;
  error?: string;
}

const API_BASE = '/api/tts';

/**
 * 获取 TTS 源列表
 */
export async function fetchSources(): Promise<TTSource[]> {
  const res = await fetch(`${API_BASE}/sources`);
  if (!res.ok) throw new Error('Failed to fetch TTS sources');
  const json = await res.json();
  return json.data || [];
}

/**
 * 获取指定 TTS 源的音色列表
 * 支持自定义 API URL/Key（用于在保存设置前预览自定义源的音色）
 */
export async function fetchVoices(source: string, apiUrl?: string, apiKey?: string): Promise<VoiceInfo[]> {
  let url = `${API_BASE}/voices?source=${encodeURIComponent(source)}`;
  if (apiUrl) url += `&apiUrl=${encodeURIComponent(apiUrl)}`;
  if (apiKey) url += `&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to fetch voices');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to fetch voices');
  return json.data?.voices || [];
}

/**
 * 测试 TTS 服务连接
 * 支持自定义 API URL/Key（用于在保存设置前测试自定义源的连通性）
 */
export async function testConnection(source: string, apiUrl?: string, apiKey?: string): Promise<HealthResult> {
  let url = `${API_BASE}/health?source=${encodeURIComponent(source)}`;
  if (apiUrl) url += `&apiUrl=${encodeURIComponent(apiUrl)}`;
  if (apiKey) url += `&apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (res.status === 502) {
    return { success: false, error: 'TTS service unavailable' };
  }
  return res.json();
}

/**
 * 获取 TTS 设置
 */
export async function fetchTTSSettings(): Promise<TTSSettings> {
  const res = await fetch(`${API_BASE}/settings`, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to fetch TTS settings');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to fetch TTS settings');
  return json.data;
}

/**
 * 保存 TTS 设置
 */
export async function saveTTSSettings(settings: Partial<TTSSettings>): Promise<TTSSettings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error('Failed to save TTS settings');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to save TTS settings');
  return json.data;
}

/**
 * 清除 TTS 音频缓存
 */

/**
 * 合成一段 TTS 语音（用于试听）
 * 调用 POST /api/tts，返回音频 Blob
 */
export async function synthesizeSpeech(
  input: string,
  voice?: string,
  speed?: number,
  ttsSource?: string,
): Promise<Blob> {
  const res = await fetch(`${API_BASE}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({
      input,
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      speed: speed ?? 1.0,
      tts_source: ttsSource || undefined,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '合成失败');
    throw new Error(errText);
  }
  return res.blob();
}

export async function clearTTSCache(): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE}/cache/clear`, { method: 'POST', headers: getAuthHeaders() });
  if (!res.ok) throw new Error('Failed to clear TTS cache');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to clear TTS cache');
  return { deleted: json.deleted };
}
