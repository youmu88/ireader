import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../services/themeService';
import {
  fetchSources,
  fetchVoices,
  fetchModels,
  fetchTTSSettings,
  saveTTSSettings,
  testConnection,
  clearTTSCache,
  synthesizeSpeech,
  type TTSource,
  type VoiceInfo,
  type ModelInfo,
  type TTSSettings,
  type HealthResult,
} from '../services/ttsService';

import { APP_VERSION } from '../version';
import axios from 'axios';
import { Button, IconButton, ToggleSwitch } from '../components/ui';

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
  const [selectedVoice, setSelectedVoice] = useState('alloy');
  const [speed, setSpeed] = useState(1.0);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  // @ts-ignore
  const [showApiKey, setShowApiKey] = useState(false);
  // @ts-ignore
  const [connectionStatus, setConnectionStatus] = useState<HealthResult | null>(null);
  // @ts-ignore
  const [testing, setTesting] = useState(false);
  // @ts-ignore
  const [fetchingVoices, setFetchingVoices] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
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

  const handleToggleNoCache = (next: boolean) => {
    setNoCache(next);
    try { localStorage.setItem(NO_CACHE_KEY, next ? 'true' : 'false'); } catch { /* ignore */ }
  };

  // ── 自动预合成开关 ──
  const [autoPreSynthesize, setAutoPreSynthesize] = useState(false);

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
        setSelectedVoice(settings.voiceId || 'alloy');
        setSpeed(settings.speed ?? 1.0);
        setApiUrl(settings.apiUrl || '');
        setApiKey(settings.apiKey || '');
        setModel(settings.model || '');
        setAutoPreSynthesize(settings.autoPreSynthesize ?? false);
        // 先渲染页面，再后台拉取音色列表（避免阻塞 UI）
        setLoading(false);
        // ⭐ 后台异步拉取音色：不阻塞设置页面渲染
        fetchVoicesInBackground(settings.apiUrl || undefined, settings.apiKey || undefined);
      } catch (err) {
        console.warn('Failed to load TTS settings:', err);
        setLoading(false);
      }
    }
    load();
  }, []);

  // ⭐ 后台异步拉取音色列表
  async function fetchVoicesInBackground(apiUrl?: string, apiKey?: string) {
    try {
      const voiceList = await fetchVoices(apiUrl, apiKey);
      setVoices(voiceList);
    } catch {
      setVoices([]);
    }
  }

  // 手动获取音色（使用当前 API URL/Key）
  // @ts-ignore
  async function handleFetchVoices() {
    setFetchingVoices(true);
    try {
      const voiceList = await fetchVoices(apiUrl || undefined, apiKey || undefined);
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
      const result = await testConnection(apiUrl || undefined, apiKey || undefined);
      setConnectionStatus(result);
    } catch (err) {
      setConnectionStatus({ success: false, error: 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  }

  // Fetch models
  // @ts-ignore
  async function handleFetchModels() {
    setFetchingModels(true);
    try {
      const modelList = await fetchModels(apiUrl || undefined, apiKey || undefined);
      setModels(modelList);
    } catch {
      setModels([]);
    } finally {
      setFetchingModels(false);
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
        source: 'openai',
        voiceId: selectedVoice,
        speed,
        apiUrl: apiUrl || null,
        apiKey: apiKey || null,
        model: model || null,
        autoPreSynthesize,
      });
      setTtsSettings(updated);
      setSaveMessage('✓ 设置已保存');

      // 同步完整语音身份到 localStorage，供离线播放器和本地缓存匹配使用。
      try {
        localStorage.setItem('ireader_tts_source', 'openai');
        localStorage.setItem('ireader_tts_voice', selectedVoice);
        localStorage.setItem('ireader_tts_synthesisRate', String(speed));
        // backward compat: 旧 key 保留一份，逐步废弃
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
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 animate-fade-in">
        {/* ── 导航栏 ── */}
        <div className="flex items-center gap-3 mb-6">
          <IconButton onClick={() => setShowTTSDetail(false)} aria-label="返回" variant="subtle" size="sm">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </IconButton>
          <h1 className="text-[28px] sm:text-[34px] font-bold tracking-tight"
            style={{ color: 'var(--color-text)' }}>
            TTS 服务
          </h1>
        </div>

        {/* ── TTS 服务配置 ── */}
        <div className="mb-6">
          <h2 className="text-xs font-semibold tracking-widest uppercase px-1 mb-2"
            style={{ color: 'var(--color-text-muted)' }}>
            TTS 服务配置
          </h2>
          <div className="rounded-2xl overflow-hidden shadow-ios-sm"
            style={{ background: 'var(--color-bg-card)' }}>
            {/* API 地址 */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: 'var(--color-text-muted)' }}>
                服务地址 <span className="text-[10px] opacity-60">（必填）</span>
              </label>
              <div className="flex items-center gap-2">
                <input type="text" value={apiUrl}
                  onChange={e => setApiUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="flex-1 px-3 py-2 rounded-xl text-sm bg-transparent border"
                  style={{
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                  }} />
                <Button onClick={handleTestConnection} loading={testing}
                  variant="secondary" size="sm">
                  测试
                </Button>
              </div>
              {connectionStatus && (
                <div className="mt-2 text-xs px-2 py-1 rounded-lg"
                  style={{
                    background: connectionStatus.success ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)',
                    color: connectionStatus.success ? '#34c759' : '#ff3b30',
                  }}>
                  {connectionStatus.success
                    ? `✓ 连接成功${connectionStatus.models ? ' · 可用模型 ' + connectionStatus.models.length + ' 个' : ''}`
                    : `✗ ${connectionStatus.error || '连接失败'}`}
                </div>
              )}
            </div>

            {/* 模型 */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>模型</span>
                <Button onClick={handleFetchModels} loading={fetchingModels}
                  variant="ghost" size="sm">
                  刷新
                </Button>
              </div>
              <input type="text" list="tts-model-list" value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="tts-1"
                className="w-full px-3 py-2 rounded-xl text-sm bg-transparent border"
                style={{
                  color: 'var(--color-text)',
                  borderColor: 'var(--color-border)',
                }} />
              <datalist id="tts-model-list">
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </datalist>
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
                <IconButton onClick={() => setShowApiKey(!showApiKey)} aria-label={showApiKey ? '隐藏密钥' : '显示密钥'} variant="ghost" size="xs">
                  {showApiKey ? '🙈' : '👁'}
                </IconButton>
              </div>
            </div>

            {/* 缺省音色 */}
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>缺省音色</span>
                <Button onClick={handleFetchVoices} loading={fetchingVoices}
                  variant="ghost" size="sm">
                  刷新
                </Button>
              </div>
              {voices.length > 0 ? (
                <><select value={selectedVoice}
                  onChange={e => setSelectedVoice(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl text-sm bg-transparent border"
                  style={{
                    color: 'var(--color-text)',
                    borderColor: 'var(--color-border)',
                  }}>
                  {voices.map(v => (
                    <option key={v.id} value={v.id}>{v.name || v.id}</option>
                  ))}
                </select>
                <div className="flex items-center gap-2 mt-2" style={{ display: 'flex' }}>
                  <Button onClick={handlePreviewVoice} loading={previewing} size="sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    {previewing ? '播放中…' : '试听'}
                  </Button>
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
            {/* 合成语速（影响音频生成和缓存身份） */}
            <div className="px-4 py-3.5"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>合成语速</span>
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{speed.toFixed(1)}x</span>
              </div>
              <p className="text-[11px] mb-1" style={{ color: 'var(--color-text-muted)' }}>影响语音生成和缓存，调整后需重新合成。播放倍速请在阅读器中调节。</p>
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
              <ToggleSwitch checked={autoPreSynthesize} onChange={setAutoPreSynthesize} aria-label="自动预合成" />
            </div>

            {/* 实时合成 */}
            <div className="flex items-center justify-between px-4 py-3.5">
              <div>
                <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>实时合成</span>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>每次播放实时生成，不缓存</p>
              </div>
              <ToggleSwitch checked={noCache} onChange={handleToggleNoCache} aria-label="实时合成" />
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
            <Button onClick={handleClearCache} disabled={clearing}
              variant="ghost"
              fullWidth
              className="!justify-between !h-auto py-3.5 rounded-none tap-row"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <span className="text-sm font-medium">清除音频缓存</span>
              <span className="text-xs text-ios-text-muted">
                {clearing ? '清除中…' : clearMessage || ''}
              </span>
            </Button>
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
        <Button onClick={handleSave} loading={saving} fullWidth size="lg">
          保存设置
        </Button>

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
                  style={{ color: 'var(--color-warning)' }}>
                  <circle cx="12" cy="12" r="5" />
                  <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                  <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ color: 'var(--color-accent-1)' }}>
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
            <ToggleSwitch checked={theme === 'dark'} onChange={() => toggleTheme()} aria-label="深色模式" />
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
              <IconButton onClick={() => { const v = Math.max(12, fontSize - 1); setFontSize(v); try { const cur = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}'); localStorage.setItem(READER_PREFS_KEY, JSON.stringify({...cur, fontSize: v})); } catch {} }}
                aria-label="缩小字体" variant="subtle" size="xs">A−</IconButton>
              <span className="text-xs w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
              <IconButton onClick={() => { const v = Math.min(32, fontSize + 1); setFontSize(v); try { const cur = JSON.parse(localStorage.getItem(READER_PREFS_KEY) || '{}'); localStorage.setItem(READER_PREFS_KEY, JSON.stringify({...cur, fontSize: v})); } catch {} }}
                aria-label="放大字体" variant="subtle" size="xs">A+</IconButton>
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
          <Button onClick={() => setShowTTSDetail(true)}
            variant="row" fullWidth justify="between" className="px-4 py-3.5">
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
                  {model || '未设置模型'} · {selectedVoice}
                </p>
              </div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ color: 'var(--color-text-tertiary)' }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Button>
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
      <Button onClick={handleLogout} variant="secondary" fullWidth size="lg"
        className="!bg-ios-bg-card !text-ios-danger shadow-ios-sm">
        退出登录
      </Button>

      <div className="h-12" />
    </div>
  );
}
