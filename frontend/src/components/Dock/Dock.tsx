/** Dock 页签定义 */

/**
 * iOS Safari 已知问题：页面任意祖先/同级含 backdrop-filter（毛玻璃顶栏 SafeGlass、Dock 自身毛玻璃）时，
 * position:fixed 元素在滚动过程中会渲染错位（WebKit bug，表现为 dock 被带到页面中间）。
 * workaround：nav 外层加 translateZ(0) 强制独立合成层，滚动时由合成器固定位置。
 */

import { Button } from '../ui/Button';

/** Dock 页签定义 */
export interface DockTab {
  id: string;
  label: string;
  icon: 'shelf' | 'library' | 'settings';
}

export interface DockProps {
  tabs: DockTab[];
  /** 当前激活路径 */
  currentPath: string;
  onNavigate?: (path: string) => void;
}

function TabIcon({ name, active }: { name: DockTab['icon']; active: boolean }) {
  const stroke = 'currentColor';
  // 选中态笔画加粗（iOS 选中图标视觉权重更高）
  const sw = active ? 2.1 : 1.8;
  switch (name) {
    case 'shelf':
      return (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          {active && <line x1="9" y1="7" x2="16" y2="7" />}
        </svg>
      );
    case 'library':
      return (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      );
    case 'settings':
      return (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}

/**
 * iOS 原生底部 Dock（毛玻璃拟态 Tab Bar）
 *
 * 设计要点（iOS Tab Bar 风格）：
 * - 每个 tab 为「图标 + 文字」纵向排列；选中态：iOS 蓝图标（笔画加粗）+ 轻微上浮放大 + 文字高亮 + 底部指示条
 * - 无 hover/按压背景：ghost 变体 hover 椭圆背景用 hover:!bg-transparent 消除（原实现点击时胶囊盖不住图标）
 * - 高度自适应：!h-auto 覆盖 Button md 固定 h-10，避免 26px 图标 + 文字纵向溢出按钮边界
 * - 按压反馈：active:scale-90 弹性缩放（不产生任何椭圆/胶囊背景）
 */
export function Dock({ tabs, currentPath, onNavigate }: DockProps) {
  // 根路径 '/' 需精确匹配；其余按照前缀匹配子路径
  const isActiveTab = (tabId: string) =>
    tabId === '/' ? currentPath === '/' : currentPath === tabId || currentPath.startsWith(tabId + '/');
  const activeId = tabs.find((t) => isActiveTab(t.id))?.id ?? tabs[0]?.id;

  return (
    <nav
      data-testid="dock"
      aria-label="底部导航"
      className="fixed bottom-0 left-0 right-0 z-40"
      style={{ transform: 'translateZ(0)' }}
    >
      {/* 毛玻璃容器 */}
      <div className="backdrop-blur-2xl bg-white/70 dark:bg-black/60 border-t border-black/5 dark:border-white/10"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto max-w-md px-6 pb-2 pt-2">
          <div className="flex items-center justify-around">
            {tabs.map((tab) => {
              const active = tab.id === activeId;
              return (
                <Button
                  key={tab.id}
                  variant="ghost"
                  type="button"
                  data-active={active ? 'true' : 'false'}
                  onClick={() => onNavigate?.(tab.id)}
                  aria-label={tab.label}
                  aria-current={active ? 'page' : undefined}
                  className="relative !flex !flex-col items-center !h-auto px-4 pt-1.5 pb-1 rounded-full transition-transform duration-200 active:scale-90 hover:!bg-transparent"
                  style={{
                    color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    gap: '3px',
                  }}
                >
                  <span className={`transition-transform duration-200 ${active ? '-translate-y-0.5 scale-110' : ''}`}>
                    <TabIcon name={tab.icon} active={active} />
                  </span>
                  <span className={`text-[10px] font-medium transition-colors duration-200 ${active ? 'text-ios-primary' : 'text-ios-text-muted'}`}>
                    {tab.label}
                  </span>
                  {/* 选中指示条 */}
                  <span
                    className={`absolute bottom-0 left-1/2 -translate-x-1/2 w-4 h-[3px] rounded-full transition-all duration-200 ${
                      active ? 'bg-ios-primary opacity-100' : 'opacity-0'
                    }`}
                  />
                </Button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}

export default Dock;
