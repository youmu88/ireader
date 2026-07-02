import { useState, useEffect } from 'react';
import { useTheme } from '../services/themeService';
import {
  fetchSources,
  fetchVoices,
  fetchTTSSettings,
  saveTTSSettings,
  testConnection,
  clearTTSCache,
  type TTSource,
  type VoiceInfo,
  type TTSSettings,
  type HealthResult,
} from '../services/ttsService';

// 预设 TTS 服务的默认 URL
const PRESET_DEFAULT_URLS: Record<string, string> = {
  kokoro: 'http://127.0.0.1:8880',
  megatts3: 'http://127.0.0.1:8882',
  edgetts: 'http://127.0.0.1:8883',
};

export default function SettingsPage() {
  const { theme, setTheme, toggleTheme } = useTheme();

  // TTS settings state
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [sources, setSources] = useState<TTSource[]>([]);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [selectedSource, setSelectedSource] = useState('kokoro');
  const [selectedVoice, setSelectedVoice] = useState('zh-CN-XiaoxiaoNeural');
  const [speed, setSpeed] = useState(1.0);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<HealthResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetchingVoices, setFetchingVoices] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveMessage, setSaveMessage] = useState('');
  // ── 实时合成（noCache）开关 ──
  const NO_CACHE_KEY = 'ireader_tts_noCache';
  const [noCache, setNoCache] = useState(() => {
    try { return localStorage.getItem(NO_CACHE_KEY) === 'true'; } catch { return true; }
  });

  const handleToggleNoCache = () => {
    const next = !noCache;
    setNoCache(next);
    try { localStorage.setItem(NO_CACHE_KEY, next ? 'true' : 'false'); } catch { /* ignore */ }
  };

  // 判断当前是否为自定义模式
  const isCustomSource = selectedSource === 'custom';

  // 获取当前有效的 API URL
  // - 用户手动输入了 URL 则用用户输入的值（无论是否 custom 模式）
  // - 否则 fallback 到预设源的默认 URL
  function getEffectiveApiUrl(): string | undefined {
    return apiUrl || PRESET_DEFAULT_URLS[selectedSource] || undefined;
  }

  // 获取当前有效的 API Key
  function getEffectiveApiKey(): string | undefined {
    return apiKey || undefined;
  }

  // Load initial data
  useEffect(() => {
    async function load() {
      try {
        const [srcList, settings] = await Promise.all([
          fetchSources(),
          fetchTTSSettings(),
        ]);
        setSources(srcList);
        setTtsSettings(settings);
        setSelectedSource(settings.source || 'kokoro');
        setSelectedVoice(settings.voiceId || 'zh-CN-XiaoxiaoNeural');
        setSpeed(settings.speed ?? 1.0);
        setApiUrl(settings.apiUrl || '');
        setApiKey(settings.apiKey || '');
        try {
          const effectiveUrl = settings.apiUrl || PRESET_DEFAULT_URLS[settings.source || 'kokoro'];
          const voiceList = await fetchVoices(settings.source || 'kokoro', effectiveUrl, settings.apiKey || undefined);
          setVoices(voiceList);
        } catch {
          setVoices([]);
        }
      } catch (err) {
        console.warn('Failed to load TTS settings:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // 当 source 切换时，更新 apiUrl 显示（预设源自动填充默认地址）
  useEffect(() => {
    if (!isCustomSource) {
      const defaultUrl = PRESET_DEFAULT_URLS[selectedSource];
      if (defaultUrl && !apiUrl) {
        setApiUrl(defaultUrl);
      }
    }
  }, [selectedSource]);

  // 手动获取音色（使用当前 API URL/Key）
  async function handleFetchVoices() {
    setFetchingVoices(true);
    try {
      const voiceList = await fetchVoices(selectedSource, getEffectiveApiUrl(), getEffectiveApiKey());
      setVoices(voiceList);
      if (voiceList.length > 0 && !voiceList.find(v => v.id === selectedVoice)) {
        setSelectedVoice(voiceList[0].id);
      }
    } catch {
      setVoices([]);
    } finally {
      setFetchingVoices(false);
    }
  }

  // Test connection
  async function handleTestConnection() {
    setTesting(true);
    setConnectionStatus(null);
    try {
      const result = await testConnection(selectedSource, getEffectiveApiUrl(), getEffectiveApiKey());
      setConnectionStatus(result);
    } catch (err) {
      setConnectionStatus({ success: false, error: 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  }

  // Clear TTS cache
  async function handleClearCache() {
    setClearing(true);
    setClearMessage(null);
    try {
      const result = await clearTTSCache();
      setClearMessage(`✓ 已清除 ${result.deleted} 条缓存`);
      setTimeout(() => setClearMessage(''), 3000);
    } catch (err: any) {
      setClearMessage(`✗ ${err.message || '清除失败'}`);
    } finally {
      setClearing(false);
    }
  }

  // Save settings
  async function handleSave() {
    setSaving(true);
    setSaveMessage('');
    try {
      const updated = await saveTTSSettings({
        source: selectedSource,
        voiceId: selectedVoice,
        speed,
        apiUrl: isCustomSource ? (apiUrl || null) : null,
        apiKey: apiKey || null,
      });
      setTtsSettings(updated);
      setSaveMessage('✓ 设置已保存');
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (err) {
      setSaveMessage('✗ 保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      <h1 className="text-2xl font-bold mb-4 sm:mb-6">设置</h1>

      <div className="space-y-6">
        {/* Theme Section */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-4 transition-colors">
          <h2 className="text-lg font-semibold mb-3 sm:mb-4">主题设置</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                当前模式：{theme === 'dark' ? '🌙 暗色模式' : '☀️ 亮色模式'}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                切换应用的亮色/暗色外观
              </p>
            </div>
            <button
              onClick={toggleTheme}
              className={`relative w-14 h-7 rounded-full transition-colors ${
                theme === 'dark' ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                  theme === 'dark' ? 'translate-x-7.5' : 'translate-x-0.5'
                } flex items-center justify-center text-xs`}
              >
                {theme === 'dark' ? '🌙' : '☀️'}
              </span>
            </button>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={() => setTheme('light')}
              className={`flex-1 px-2 sm:px-3 py-2 sm:py-3 rounded-lg border-2 transition-colors ${
                theme === 'light'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-600 hover:border-gray-300'
              }`}
            >
              <div className="text-center">
                <span className="text-2xl block mb-1">☀️</span>
                <span className="text-xs font-medium">亮色</span>
              </div>
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`flex-1 px-2 sm:px-3 py-2 sm:py-3 rounded-lg border-2 transition-colors ${
                theme === 'dark'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-gray-200 dark:border-gray-600 hover:border-gray-300'
              }`}
            >
              <div className="text-center">
                <span className="text-2xl block mb-1">🌙</span>
                <span className="text-xs font-medium">暗色</span>
              </div>
            </button>
          </div>
        </section>

        {/* TTS Settings Section */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-4">
          <h2 className="text-lg font-semibold mb-3 sm:mb-4">听书设置</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">语音服务（选择 TTS 后端引擎）</label>
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm"
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {sources.find(s => s.id === selectedSource)?.description && (
                <p className="text-xs text-gray-400 mt-1">
                  {sources.find(s => s.id === selectedSource)?.description}
                </p>
              )}
              <p className="text-xs text-gray-400 mt-0.5">
                切换后可从对应服务获取音色列表；选「自定义 TTS API」可接入兼容 OpenAI 格式的任意 TTS 服务
              </p>
            </div>

            {/* API URL 输入（所有模式均可编辑） */}
            <div>
              <label className="block text-sm font-medium mb-1">
                API 服务地址
                {isCustomSource && <span className="text-red-400 ml-1">*</span>}
              </label>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={isCustomSource ? 'https://your-tts-server.com' : 'http://127.0.0.1:8880'}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm font-mono"
              />
              {!isCustomSource && (
                <p className="text-xs text-gray-400 mt-1">
                  ⚡ 预设源已自动填入默认地址，如需使用其他地址可直接修改
                </p>
              )}
              {isCustomSource && (
                <p className="text-xs text-gray-400 mt-1">
                  TTS API 需兼容 OpenAI 格式：<code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">POST /v1/audio/speech</code>
                </p>
              )}
            </div>

            {/* API Key 输入（可选） */}
            <div>
              <label className="block text-sm font-medium mb-1">
                API Key
                <span className="text-xs text-gray-400 ml-1">（可选）</span>
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="输入 API Key 或留空"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-gray-400 hover:text-gray-600"
                >
                  {showApiKey ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            {/* 音色选择（手动拉取） */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium">音色</label>
                <button
                  onClick={handleFetchVoices}
                  disabled={fetchingVoices || (isCustomSource && !apiUrl)}
                  className="text-xs px-2 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded hover:bg-blue-100 disabled:opacity-40"
                >
                  {fetchingVoices ? '获取中...' : '🔄 从服务器获取音色'}
                </button>
              </div>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm"
                disabled={voices.length === 0}
              >
                {voices.length === 0 ? (
                  <option value="">无可用音色（点击「从服务器获取音色」）</option>
                ) : (
                  voices.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))
                )}
              </select>
              {voices.length > 0 && (
                <p className="text-xs text-gray-400 mt-1">共 {voices.length} 个可用音色</p>
              )}
            </div>

            {/* 实时合成开关 */}
            <div className="flex items-center justify-between py-2">
              <div>
                <label className="text-sm font-medium">实时合成模式</label>
                <p className="text-xs text-gray-400 mt-0.5">
                  开启：每次朗读都实时合成音频（准确但稍慢）<br />
                  关闭：复用已缓存的音频（快速，但切换书籍后可能读到旧缓存）
                </p>
              </div>
              <button
                onClick={handleToggleNoCache}
                className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${
                  noCache ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    noCache ? 'translate-x-6' : 'translate-x-0.5'
                  } flex items-center justify-center text-[10px]`}
                >
                  {noCache ? '✓' : '⏺'}
                </span>
              </button>
            </div>

            {/* 语速 */}
            <div>
              <label className="block text-sm font-medium mb-1">语速: {speed.toFixed(1)}x</label>
              <input
                type="range" min="0.5" max="2.0" step="0.1"
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-gray-500">
                <span>慢 0.5x</span>
                <span>快 2.0x</span>
              </div>
            </div>

            {/* Connection Test & Cache Clear */}
            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={handleTestConnection} disabled={testing}
                className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 text-sm">
                {testing ? '测试中...' : '🔌 测试连接'}
              </button>
              {connectionStatus && (
                <span className={`text-sm ${connectionStatus.success ? 'text-green-500' : 'text-red-500'}`}>
                  {connectionStatus.success
                    ? `✓ 已连接 (${connectionStatus.service || selectedSource})`
                    : `✗ ${connectionStatus.error}`}
                </span>
              )}
              <button onClick={handleClearCache} disabled={clearing}
                className="px-4 py-2 bg-orange-500 text-white rounded-md hover:bg-orange-600 disabled:opacity-50 text-sm ml-auto">
                {clearing ? '清理中...' : '🗑 清除缓存'}
              </button>
              {clearMessage && (
                <span className={`text-sm ${clearMessage.startsWith('✓') ? 'text-green-500' : 'text-red-500'}`}>
                  {clearMessage}
                </span>
              )}
            </div>

            {/* Save Button */}
            <div className="flex items-center gap-3 pt-2">
              <button onClick={handleSave} disabled={saving}
                className="px-6 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:opacity-50 text-sm">
                {saving ? '保存中...' : '💾 保存设置'}
              </button>
              {saveMessage && (
                <span className={`text-sm ${saveMessage.startsWith('✓') ? 'text-green-500' : 'text-red-500'}`}>
                  {saveMessage}
                </span>
              )}
            </div>
          </div>
        </section>

        {/* About Section */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-3 sm:p-4">
          <h2 className="text-lg font-semibold mb-3">关于</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            iReader v0.1.0 — 图书阅读与听书服务端软件
          </p>
          <p className="text-xs text-gray-400 mt-2">
            TTS 后端: {ttsSettings?.source || 'edgetts'} · 音色: {ttsSettings?.voiceId || 'zh-CN-XiaoxiaoNeural'}
          </p>
        </section>
      </div>
    </div>
  );
}
