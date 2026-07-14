import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../services/themeService';
import {
  fetchSources,
  fetchVoices,
  fetchTTSSettings,
  saveTTSSettings,
  testConnection,
  clearTTSCache,
  synthesizeSpeech,
  type TTSource,
  type VoiceInfo,
  type TTSSettings,
  type HealthResult,
} from '../services/ttsService';

import { APP_VERSION } from '../version';
import axios from 'axios';

// 预设 TTS 服务的默认 URL
const PRESET_DEFAULT_URLS: Record<string, string> = {
  kokoro: 'http://127.0.0.1:8880',
  megatts3: 'http://127.0.0.1:8882',
  edgetts: 'http://127.0.0.1:8883',
};

export default function SettingsPage() {
  // @ts-ignore
  const { theme, setTheme, toggleTheme } = useTheme();

  // TTS settings state
  // @ts-ignore
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  // @ts-ignore
  const [sources, setSources] = useState<TTSource[]>([]);
  // @ts-ignore
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [selectedSource, setSelectedSource] = useState('kokoro');
  const [selectedVoice, setSelectedVoice] = useState('zh-CN-XiaoxiaoNeural');
  const [speed, setSpeed] = useState(1.0);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // @ts-ignore
  const [showApiKey, setShowApiKey] = useState(false);
  // @ts-ignore
  const [connectionStatus, setConnectionStatus] = useState<HealthResult | null>(null);
  // @ts-ignore
  const [testing, setTesting] = useState(false);
  // @ts-ignore
  const [fetchingVoices, setFetchingVoices] = useState(false);
  // @ts-ignore
  const [clearing, setClearing] = useState(false);
  // @ts-ignore
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  // @ts-ignore
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showTTSDetail, setShowTTSDetail] = useState(false);
  // @ts-ignore
  const [saveMessage, setSaveMessage] = useState('');
  // @ts-ignore
  const [previewing, setPreviewing] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewText = '您好，欢迎使用语音朗读功能，这是您选择的音色效果。';

  // ── 试听音色（handlePreviewVoice） ──
  // @ts-ignore
  async function handlePreviewVoice() {
    if (previewing) return;
    setPreviewing(true);
    try {
      const blob = await synthesizeSpeech(
        previewText,
        selectedVoice,
        speed,
        selectedSource,
      );
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        setPreviewing(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };
      audio.onerror = () => {
        setPreviewing(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
      };
      await audio.play();
    } catch (err) {
      console.warn('试听失败:', err);
      setPreviewing(false);
    }
  }

  const NO_CACHE_KEY = 'ireader_tts_noCache';
  // @ts-ignore
  const [noCache, setNoCache] = useState(() => {
    try { return localStorage.getItem(NO_CACHE_KEY) === 'true'; } catch { return true; }
  });

  // @ts-ignore
  const handleToggleNoCache = () => {
    const next = !noCache;
    setNoCache(next);
    try { localStorage.setItem(NO_CACHE_KEY, next ? 'true' : 'false'); } catch { /* ignore */ }
  };

  // ── 自动预合成开关 ──
  const [autoPreSynthesize, setAutoPreSynthesize] = useState(false);

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
        setAutoPreSynthesize(settings.autoPreSynthesize ?? false);
        // 先渲染页面，再后台拉取音色列表（避免阻塞 UI）
        setLoading(false);
        // ⭐ 后台异步拉取音色：不阻塞设置页面渲染
        fetchVoicesInBackground(settings.source || 'kokoro', settings.apiUrl || undefined, settings.apiKey || undefined);
      } catch (err) {
        console.warn('Failed to load TTS settings:', err);
        setLoading(false);
      }
    }
    load();
  }, []);

  // ⭐ 后台异步拉取音色列表
  async function fetchVoicesInBackground(source: string, apiUrl?: string, apiKey?: string) {
    try {
      const effectiveUrl = apiUrl || PRESET_DEFAULT_URLS[source] || undefined;
      const voiceList = await fetchVoices(source, effectiveUrl, apiKey);
      setVoices(voiceList);
    } catch {
      setVoices([]);
    }
  }

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
  // @ts-ignore
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
  // @ts-ignore
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
  // @ts-ignore
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
  // @ts-ignore
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
        autoPreSynthesize,
      });
      setTtsSettings(updated);
      setSaveMessage('✓ 设置已保存');

      // ⭐ 同步音色/语速到 localStorage（供 ReaderPage 和播放器预热使用）
      try {
        localStorage.setItem('ireader_tts_voice', selectedVoice);
        localStorage.setItem('ireader_tts_speed', String(speed));
      } catch { /* ignore */ }
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (err) {
      setSaveMessage('✗ 保存失败');
    } finally {
      setSaving(false);
    }
  }


  // ── iOS 风格所需状态（由 iOS 美化新增） ──
  const READER_PREFS_KEY = 'ireader_reader_prefs';
  // 从阅读器偏好中读取初始值，与 ReaderPage 共享
  const [fontSize, setFontSize] = useState(() => {
    try {
      const raw = localStorage.getItem(READER_PREFS_KEY);
      if (raw) { const p = JSON.parse(raw); if (p.fontSize) return p.fontSize; }
    } catch {}
    return 18;
  });
  const [readerBg, setReaderBg] = useState(() => {
    try { return localStorage.getItem('ireader_reader_bg') || (document.documentElement.classList.contains('dark') ? '#1a1a2e' : '#ffffff'); } catch { return '#ffffff'; }
  });
  const BUILD_TIME = '2026-07-03';
  const RUNNING_ENV = typeof window !== 'undefined' && 'standalone' in window.navigator && (window.navigator as any).standalone ? 'PWA' : 'Web';
  const handleLogout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch {}
    window.location.href = '/';
  };

  // ── TTS 二级菜单（iOS 风格 drill-down） ──
  if (showTTSDetail) {
    const sourceOptions = [
      { id: 'kokoro', label: 'Kokoro' },
      { id: 'megatts3', label: 'MegaTTS3' },
      { id: 'edgetts', label: 'EdgeTTS' },
      { id: 'custom', label: '自定义' },
    ];
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-fade-in">
        {/* ── 导航栏 ── */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => setShowTTSDetail(false)}
            className="w-8 h-8 rounded-full flex items-center justify-center tap-icon"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-primary)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 className="text-[28px] sm:text-[34px] font-bold tracking-tight"
            style={{ color: 'var(--color-text)' }}>
            TTS 服务
          </h1>
        </div>

        {/* ── 服务源 ── */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
            style={{ color: 'var(--color-text-muted)' }}>
            服务源
          </h2>
          <div className="rounded-2xl overflow-hidden shadow-ios-sm"
            style={{ background: 'var(--color-bg-card)' }}>
            {/* TTS 引擎选择 */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <span className="text-xs font-medium mb-2 block" style={{ color: 'var(--color-text-muted)' }}>
                TTS 引擎
              </span>
              <div className="flex flex-wrap gap-2">
                {sourceOptions.map(s => (
                  <button key={s.id} onClick={() => {
                    setSelectedSource(s.id);
                    if (s.id !== 'custom') setApiUrl(PRESET_DEFAULT_URLS[s.id] || '');
                  }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all tap-icon"
                    style={{
                      background: selectedSource === s.id ? 'var(--color-primary)' : 'var(--color-bg-alt)',
                      color: selectedSource === s.id ? '#fff' : 'var(--color-text-secondary)',
                    }}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* API 地址 */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--color-text-muted)' }}>
                服务地址 {!isCustomSource && <span className="text-[10px] opacity-60">（预设）</span>}
              </label>
              <div className="flex items-center gap-2">
                <input type="text" value={apiUrl}
                  onChange={e => setApiUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8880"
                  className="flex-1 px-3 py-2 rounded-xl text-sm bg-transparent border"
                  style={{
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                  }} />
                <button onClick={handleTestConnection} disabled={testing}
                  className="px-3 py-2 rounded-xl text-xs font-medium tap-icon whitespace-nowrap"
                  style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                  {testing ? '测试中…' : '测试'}
                </button>
              </div>
              {connectionStatus && (
                <div className="mt-2 text-xs px-2 py-1 rounded-lg"
                  style={{
                    background: connectionStatus.success ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)',
                    color: connectionStatus.success ? '#34c759' : '#ff3b30',
                  }}>
                  {connectionStatus.success
                    ? `✓ 连接成功${connectionStatus.service ? ' · ' + connectionStatus.service : ''}`
                    : `✗ ${connectionStatus.error || '连接失败'}`}
                </div>
              )}
            </div>

            {/* API Key */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--color-text-muted)' }}>
                API Key <span className="text-[10px] opacity-60">（可选）</span>
              </label>
              <div className="flex items-center gap-2">
                <input type={showApiKey ? 'text' : 'password'} value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="flex-1 px-3 py-2 rounded-xl text-sm bg-transparent border"
                  style={{
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                  }} />
                <button onClick={() => setShowApiKey(!showApiKey)}
                  className="px-2 py-2 rounded-xl text-xs tap-icon"
                  style={{ color: 'var(--color-text-secondary)' }}>
                  {showApiKey ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            {/* 缺省音色 */}
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>缺省音色</span>
                <button onClick={handleFetchVoices} disabled={fetchingVoices}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium tap-icon"
                  style={{ background: 'var(--color-bg-alt)', color: 'var(--color-primary)' }}>
                  {fetchingVoices ? '加载中…' : '刷新'}
                </button>
              </div>
              {voices.length > 0 ? (
                <><select value={selectedVoice} onChange={e => setSelectedVoice(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-sm bg-transparent border appearance-none"
                  style={{
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 10px center',
                  }}>
                  {voices.map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                {/* 试听按钮 */}
                <div className="flex items-center gap-2 mt-2" style={{ display: 'flex' }}>
                  <button onClick={handlePreviewVoice} disabled={previewing}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all tap-icon"
                    style={{
                      background: previewing ? 'var(--color-bg-alt)' : 'var(--color-primary)',
                      color: previewing ? 'var(--color-text-muted)' : '#fff',
                    }}>
                    {previewing ? (
                      <><span className="inline-block w-3 h-3 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--color-border)', borderTopColor: 'var(--color-primary)' }} /> 播放中…</>
                    ) : (
                      <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg> 试听</>
                    )}
                  </button>
                  <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>约3秒</span>
                </div>
                </>) : (
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  {fetchingVoices ? '正在获取音色列表…' : '点击「刷新」获取可用音色'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── 参数 ── */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
            style={{ color: 'var(--color-text-muted)' }}>
            参数
          </h2>
          <div className="rounded-2xl overflow-hidden shadow-ios-sm"
            style={{ background: 'var(--color-bg-card)' }}>
            {/* 语速 */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>语速</span>
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{speed.toFixed(1)}x</span>
              </div>
              <input type="range" min="0.5" max="2.0" step="0.1" value={speed}
                onChange={e => setSpeed(parseFloat(e.target.value))}
                className="w-full" style={{ accentColor: 'var(--color-primary)' }} />
              <div className="flex justify-between text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                <span>0.5x</span><span>2.0x</span>
              </div>
            </div>

            {/* 自动预合成 */}
            <div className="flex items-center justify-between px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <div>
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>自动预合成</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>阅读时自动提前合成语音</p>
              </div>
              <button onClick={() => setAutoPreSynthesize(!autoPreSynthesize)}
                className={`relative w-[48px] h-[28px] rounded-full transition-all duration-200 ${autoPreSynthesize ? '' : 'opacity-50'}`}
                style={{ background: autoPreSynthesize ? 'var(--color-primary)' : 'var(--color-border)' }}>
                <div className={`absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-sm transition-all duration-200 ${autoPreSynthesize ? 'left-[23px]' : 'left-[3px]'}`} />
              </button>
            </div>

            {/* 实时合成 */}
            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>实时合成</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>每次播放实时生成，不缓存</p>
              </div>
              <button onClick={handleToggleNoCache}
                className={`relative w-[48px] h-[28px] rounded-full transition-all duration-200 ${noCache ? '' : 'opacity-50'}`}
                style={{ background: noCache ? 'var(--color-primary)' : 'var(--color-border)' }}>
                <div className={`absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-sm transition-all duration-200 ${noCache ? 'left-[23px]' : 'left-[3px]'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* ── 操作 ── */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
            style={{ color: 'var(--color-text-muted)' }}>
            操作
          </h2>
          <div className="rounded-2xl overflow-hidden shadow-ios-sm"
            style={{ background: 'var(--color-bg-card)' }}>
            <button onClick={handleClearCache} disabled={clearing}
              className="w-full flex items-center justify-between px-4 py-3.5 tap-row"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>清除音频缓存</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {clearing ? '清除中…' : clearMessage || ''}
              </span>
            </button>
          </div>
        </div>

        {/* ── 保存反馈 ── */}
        {saveMessage && (
          <div className="mb-4 text-center text-xs py-2 px-4 rounded-xl"
            style={{
              background: saveMessage.startsWith('✓') ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)',
              color: saveMessage.startsWith('✓') ? '#34c759' : '#ff3b30',
            }}>
            {saveMessage}
          </div>
        )}

        {/* ── 保存按钮 ── */}
        <button onClick={handleSave} disabled={saving}
          className="w-full py-3.5 rounded-2xl text-sm font-semibold text-center tap-active transition-all duration-200 shadow-ios-sm"
          style={{
            background: saving ? 'var(--color-bg-alt)' : 'var(--color-primary)',
            color: saving ? 'var(--color-text-muted)' : '#fff',
          }}>
          {saving ? '保存中…' : '保存设置'}
        </button>

        <div className="h-12" />
      </div>
    );
  }

  if (loading) {
    return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-fade-in flex items-center justify-center min-h-[50vh]">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--color-border)', borderTopColor: 'var(--color-primary)' }} />
        <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>加载中...</span>
      </div>
    </div>
  );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-fade-in">
      <h1 className="text-[28px] sm:text-[34px] font-bold tracking-tight mb-6 sm:mb-8"
        style={{ color: 'var(--color-text)' }}>
        设置
      </h1>

      {/* ── 外观 ── */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
          style={{ color: 'var(--color-text-muted)' }}>
          外观
        </h2>
        <div className="rounded-2xl overflow-hidden shadow-ios-sm"
          style={{ background: 'var(--color-bg-card)' }}>
          {/* 主题切换 */}
          <div className="flex items-center justify-between px-4 py-3.5 tap-row"
            style={{ borderBottom: '0.5px solid var(--color-border)' }}>
            <div className="flex items-center gap-3">
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ color: '#fbbf24' }}>
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ color: '#6366f1' }}>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
              <div>
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>深色模式</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {theme === 'dark' ? '当前：深色' : '当前：浅色'}
                </p>
              </div>
            </div>
            <button
              onClick={toggleTheme}
              className={`relative w-[48px] h-[28px] rounded-full transition-all duration-200 ${
                theme === 'dark' ? '' : 'opacity-50'
              }`}
              style={{
                background: theme === 'dark' ? 'var(--color-primary)' : 'var(--color-border)',
              }}
            >
              <div className={`absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-sm transition-all duration-200 ${
                theme === 'dark' ? 'left-[23px]' : 'left-[3px]'
              }`} />
            </button>
          </div>
          {/* 阅读字体大小 */}
          <div className="flex items-center justify-between px-4 py-3.5"
            style={{ borderBottom: '0.5px solid var(--color-border)' }}>
            <div className="flex items-center gap-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ color: 'var(--color-text-secondary)' }}>
                <polyline points="4 7 4 4 20 4 20 7" />
                <line x1="9" y1="20" x2="15" y2="20" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>阅读字体大小</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { const v = Math.max(12, fontSize - 1); setFontSize(v); try { const cur = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}'); localStorage.setItem(READER_PREFS_KEY, JSON.stringify({...cur, fontSize: v})); } catch {} }}
                className="w-7 h-7 rounded-full flex items-center justify-center text-sm tap-icon"
                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A−</button>
              <span className="text-xs w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
              <button onClick={() => { const v = Math.min(32, fontSize + 1); setFontSize(v); try { const cur = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}'); localStorage.setItem(READER_PREFS_KEY, JSON.stringify({...cur, fontSize: v})); } catch {} }}
                className="w-7 h-7 rounded-full flex items-center justify-center text-sm tap-icon"
                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A+</button>
            </div>
          </div>
          {/* 阅读背景色 */}
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ color: 'var(--color-text-secondary)' }}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>阅读背景色</span>
            </div>
            <div className="flex items-center gap-2">
              {['#ffffff', '#f5f0e8', '#e8f0f5', '#1a1a2e', '#2d2d2d'].map(color => (
                <button key={color} onClick={() => { setReaderBg(color); document.documentElement.style.setProperty('--reader-bg', color); try { localStorage.setItem('ireader_reader_bg', color); } catch {} }}
                  className="w-7 h-7 rounded-full border-2 transition-all duration-200 tap-icon"
                  style={{
                    background: color,
                    borderColor: readerBg === color ? 'var(--color-primary)' : 'var(--color-border)',
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── 语音 ── */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
          style={{ color: 'var(--color-text-muted)' }}>
          语音
        </h2>
        <div className="rounded-2xl overflow-hidden shadow-ios-sm"
          style={{ background: 'var(--color-bg-card)' }}>
          <button onClick={() => setShowTTSDetail(true)}
            className="w-full flex items-center justify-between px-4 py-3.5 tap-row">
            <div className="flex items-center gap-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ color: 'var(--color-text-secondary)' }}>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              <div className="text-left">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>TTS 服务</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {selectedSource} · {selectedVoice}
                </p>
              </div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ color: 'var(--color-text-tertiary)' }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── 关于 ── */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
          style={{ color: 'var(--color-text-muted)' }}>
          关于
        </h2>
        <div className="rounded-2xl overflow-hidden shadow-ios-sm"
          style={{ background: 'var(--color-bg-card)' }}>
          <div className="flex items-center justify-between px-4 py-3.5 tap-row"
            style={{ borderBottom: '0.5px solid var(--color-border)' }}>
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>版本</span>
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>v{APP_VERSION}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3.5 tap-row"
            style={{ borderBottom: '0.5px solid var(--color-border)' }}>
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>构建时间</span>
            <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>{BUILD_TIME}</span>
          </div>
          <div className="px-4 py-3.5">
            <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>运行环境</span>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{RUNNING_ENV}</p>
          </div>
        </div>
      </div>

      {/* ── 退出登录 ── */}
      <button
        onClick={handleLogout}
        className="w-full py-3.5 rounded-2xl text-sm font-semibold text-center tap-active transition-all duration-200 shadow-ios-sm"
        style={{ background: 'var(--color-bg-card)', color: '#ff3b30' }}
      >
        退出登录
      </button>

      <div className="h-12" />
    </div>
  );
}
