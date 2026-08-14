/**
 * ReaderTopBar — 阅读器顶部书眉（Apple Books 风格顶栏）
 *
 * 与底部 ReaderMenuBar 同一视觉语言：chromeBackground/chromeColor 随阅读主题注入
 * （切主题即时同步，与正文/底栏完全一致），半透明 + backdrop-blur + 细分隔线。
 *
 * 职责：
 *  - 返回书架入口（2.51.0 移除后回归——Safari 浏览器模式下系统手势/后退并不直观）
 *  - 书名居中展示
 *  - aA 字体/主题快捷入口（与底栏一致）
 *  - 沉浸式阅读说明入口：非 standalone 且深色主题时显示，解释「Safari 系统状态栏
 *    由 iOS 控制无法跟随主题，从主屏幕图标进入可全屏沉浸」这一平台事实
 *
 * 安全区：padding-top 走 env(safe-area-inset-top)——standalone 下顶栏从屏幕顶开始，
 * 状态栏区域即主题色，顶栏与页面一体；Safari 浏览器模式下该值为 0，顶栏自然落在系统状态栏下方。
 */
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface ReaderTopBarProps {
  title: string;
  chromeBackground: string;
  chromeColor: string;
  onBack: () => void;
  onOpenFontSettings: () => void;
  /** 非 standalone + 深色主题时显示沉浸式说明入口 */
  showImmersiveTip?: boolean;
  onShowImmersiveTip?: () => void;
}

export function ReaderTopBar({
  title,
  chromeBackground,
  chromeColor,
  onBack,
  onOpenFontSettings,
  showImmersiveTip = false,
  onShowImmersiveTip,
}: ReaderTopBarProps) {
  return (
    <div
      data-testid="reader-top-bar"
      className="backdrop-blur-xl border-b"
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        background: chromeBackground,
        color: chromeColor,
        borderColor: 'rgba(128,128,128,0.25)',
      }}
    >
      <div className="flex items-center h-14 px-2">
        <IconButton
          variant="ghost"
          onClick={onBack}
          aria-label="返回书架"
          className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </IconButton>
        <p className="flex-1 text-center text-[15px] font-medium truncate px-2">{title}</p>
        <div className="flex items-center">
          {showImmersiveTip && onShowImmersiveTip && (
            <IconButton
              variant="ghost"
              onClick={onShowImmersiveTip}
              aria-label="沉浸式阅读说明"
              className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </IconButton>
          )}
          <Button
            variant="ghost"
            onClick={onOpenFontSettings}
            aria-label="字体与主题"
            className="!h-auto !px-2.5 !py-2 !rounded-lg !text-current active:opacity-40 transition-opacity text-[17px] leading-none font-medium tracking-tight"
          >
            aA
          </Button>
        </div>
      </div>
    </div>
  );
}
