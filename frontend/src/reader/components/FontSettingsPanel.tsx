/**
 * FontSettingsPanel — aA 阅读设置面板（Apple Books 风格底部弹层）
 *
 * 内容：字号 A−/A＋（步进 10%，60-200）· 四色主题圆点 · 行距三档（紧凑/标准/宽松）· 滚动阻尼 1-10。
 * 始终渲染，open 控制透明度/位移动画，关闭时禁用指针。
 */
import type { ReaderSettings, ReaderTheme } from '../types';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP, LINE_HEIGHT_OPTIONS, READER_THEMES } from '../theme';
import { SCROLL_DAMPING_MAX, SCROLL_DAMPING_MIN } from '../scrollDamping';
import { Button } from '../../components/ui/Button';

export interface FontSettingsPanelProps {
  open: boolean;
  settings: ReaderSettings;
  chromeBackground: string;
  chromeColor: string;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onClose: () => void;
}

const LINE_HEIGHT_LABELS: Record<number, string> = { 1.5: '紧凑', 1.75: '标准', 2.0: '宽松' };

export function FontSettingsPanel({
  open,
  settings,
  chromeBackground,
  chromeColor,
  onChange,
  onClose,
}: FontSettingsPanelProps) {
  return (
    <div
      data-testid="font-settings-panel"
      className={`fixed inset-0 z-40 transition-opacity duration-200 ${
        open ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-hidden={!open}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* 底部弹层 */}
      <div
        className={`absolute bottom-0 left-0 right-0 rounded-t-2xl px-6 pt-5 pb-8 space-y-6 backdrop-blur-xl transition-transform duration-300 ease-out ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ background: chromeBackground, color: chromeColor }}
        role="dialog"
        aria-label="阅读设置"
      >
        {/* 字号 */}
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => onChange({ fontSize: settings.fontSize - FONT_SIZE_STEP })}
            disabled={settings.fontSize <= FONT_SIZE_MIN}
            aria-label="减小字号"
            className="!w-14 !h-11 !rounded-xl !p-0 border text-lg !text-current disabled:opacity-30 active:opacity-50 transition-opacity"
            style={{ borderColor: 'rgba(128,128,128,0.4)' }}
          >
            A−
          </Button>
          <span className="text-sm tabular-nums" style={{ opacity: 0.7 }}>{settings.fontSize}%</span>
          <Button
            variant="ghost"
            onClick={() => onChange({ fontSize: settings.fontSize + FONT_SIZE_STEP })}
            disabled={settings.fontSize >= FONT_SIZE_MAX}
            aria-label="增大字号"
            className="!w-14 !h-11 !rounded-xl !p-0 border text-xl !text-current disabled:opacity-30 active:opacity-50 transition-opacity"
            style={{ borderColor: 'rgba(128,128,128,0.4)' }}
          >
            A＋
          </Button>
        </div>

        {/* 主题 */}
        <div className="flex justify-center gap-6">
          {(Object.keys(READER_THEMES) as ReaderTheme[]).map(name => {
            const spec = READER_THEMES[name];
            const active = settings.theme === name;
            return (
              <Button
                key={name}
                variant="ghost"
                onClick={() => onChange({ theme: name })}
                aria-label={`主题-${spec.label}`}
                aria-pressed={active}
                className={`!w-11 !h-11 !rounded-full !p-0 border transition-transform !text-current ${active ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : ''}`}
                style={{ background: spec.background, borderColor: 'rgba(128,128,128,0.4)' }}
              />
            );
          })}
        </div>

        {/* 行距 */}
        <div className="flex justify-center gap-3">
          {LINE_HEIGHT_OPTIONS.map(lh => {
            const active = settings.lineHeight === lh;
            return (
              <Button
                key={lh}
                variant="ghost"
                onClick={() => onChange({ lineHeight: lh })}
                aria-pressed={active}
                className={`!h-auto !px-5 !py-2 !rounded-full text-sm border transition-colors !text-current ${active ? 'font-semibold' : ''}`}
                style={{
                  borderColor: 'rgba(128,128,128,0.4)',
                  background: active ? 'rgba(0,122,255,0.15)' : 'transparent',
                }}
              >
                {LINE_HEIGHT_LABELS[lh]}
              </Button>
            );
          })}
        </div>

        {/* 滚动阻尼（1-10，越高滚动越沉；仅作用于 wheel） */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ opacity: 0.7 }}>滚动阻尼</span>
            <span className="text-sm tabular-nums font-semibold">{settings.scrollDamping}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs shrink-0" style={{ opacity: 0.45 }}>轻</span>
            <input
              type="range"
              min={SCROLL_DAMPING_MIN}
              max={SCROLL_DAMPING_MAX}
              step={1}
              value={settings.scrollDamping}
              aria-label="滚动阻尼"
              onChange={e => onChange({ scrollDamping: Number(e.target.value) })}
              className="flex-1 cursor-pointer"
              style={{ accentColor: '#007aff' }}
            />
            <span className="text-xs shrink-0" style={{ opacity: 0.45 }}>重</span>
          </div>
        </div>
      </div>
    </div>
  );
}
