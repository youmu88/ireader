/**
 * 前端 TTS 服务
 * 封装后端 TTS API 调用，包括设置管理、音色查询、连接测试、语音合成
 */

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
  preGenerateConcurrency: number;
  firstChunkMaxSize: number;
  normalChunkMaxSize: number;
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
 */
export async function fetchVoices(source: string): Promise<VoiceInfo[]> {
  const res = await fetch(`${API_BASE}/voices?source=${encodeURIComponent(source)}`);
  if (!res.ok) throw new Error('Failed to fetch voices');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to fetch voices');
  return json.data?.voices || [];
}

/**
 * 测试 TTS 服务连接
 */
export async function testConnection(source: string): Promise<HealthResult> {
  const res = await fetch(`${API_BASE}/health?source=${encodeURIComponent(source)}`);
  if (res.status === 502) {
    return { success: false, error: 'TTS service unavailable' };
  }
  return res.json();
}

/**
 * 获取 TTS 设置
 */
export async function fetchTTSSettings(): Promise<TTSSettings> {
  const res = await fetch(`${API_BASE}/settings`);
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
    headers: { 'Content-Type': 'application/json' },
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
export async function clearTTSCache(): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE}/cache/clear`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to clear TTS cache');
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Failed to clear TTS cache');
  return { deleted: json.deleted };
}
