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

export default function SettingsPage() {
  const { theme, setTheme, toggleTheme } = useTheme();

  // TTS settings state
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [sources, setSources] = useState<TTSource[]>([]);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [selectedSource, setSelectedSource] = useState('kokoro');
  const [selectedVoice, setSelectedVoice] = useState('zf_xiaobei');
  const [speed, setSpeed] = useState(1.0);
  const [connectionStatus, setConnectionStatus] = useState<HealthResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveMessage, setSaveMessage] = useState('');

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
        setSelectedVoice(settings.voiceId || 'zf_xiaobei');
        setSpeed(settings.speed ?? 1.0);
        try {
          const voiceList = await fetchVoices(settings.source || 'kokoro');
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

  // Load voices when source changes
  useEffect(() => {
    async function loadVoices() {
      try {
        const voiceList = await fetchVoices(selectedSource);
        setVoices(voiceList);
        if (voiceList.length > 0 && !voiceList.find(v => v.id === selectedVoice)) {
          setSelectedVoice(voiceList[0].id);
        }
      } catch {
        setVoices([]);
      }
    }
    loadVoices();
  }, [selectedSource]);

  // Test connection
  async function handleTestConnection() {
    setTesting(true);
    setConnectionStatus(null);
    try {
      const result = await testConnection(selectedSource);
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
      <div className="max-w-2xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-48 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">设置</h1>

      <div className="space-y-6">
        {/* Theme Section */}
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 transition-colors">
          <h2 className="text-lg font-semibold mb-4">主题设置</h2>
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
              className={`flex-1 px-3 py-3 rounded-lg border-2 transition-colors ${
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
              className={`flex-1 px-3 py-3 rounded-lg border-2 transition-colors ${
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
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-4">听书设置</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">语音服务</label>
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm"
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">音色</label>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-sm"
                disabled={voices.length === 0}
              >
                {voices.length === 0 ? (
                  <option value="">无可用音色（请先连接服务）</option>
                ) : (
                  voices.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))
                )}
              </select>
            </div>
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
                {testing ? '测试中...' : '测试连接'}
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
                {saving ? '保存中...' : '保存设置'}
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
        <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">关于</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            iReader v0.1.0 — 图书阅读与听书服务端软件
          </p>
          <p className="text-xs text-gray-400 mt-2">
            TTS 后端: {ttsSettings?.source || 'kokoro'} · 音色: {ttsSettings?.voiceId || 'zf_xiaobei'}
          </p>
        </section>
      </div>
    </div>
  );
}
