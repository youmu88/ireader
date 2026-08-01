/**
 * TocPanel — 目录抽屉（Apple Books 风格左侧滑出）
 *
 * 目录：章节树递归渲染（子级缩进），当前章节高亮；点击跳转并关闭。
 * 书签 tab 已于 2.51.0 移除（书签功能整体下线）。
 * 始终渲染，open 控制遮罩透明度 + 抽屉位移，关闭时禁用指针。
 */
import type { TocItem } from '../types';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface TocPanelProps {
  open: boolean;
  toc: TocItem[];
  currentHref?: string;
  chromeBackground: string;
  chromeColor: string;
  onSelect: (href: string) => void;
  onClose: () => void;
}

/** 判断目录项是否为当前阅读位置（href 精确匹配或去除 fragment 后匹配） */
export function isActiveTocItem(itemHref: string, currentHref?: string): boolean {
  if (!currentHref) return false;
  return itemHref === currentHref || itemHref.split('#')[0] === currentHref;
}

interface TocRowProps {
  item: TocItem;
  depth: number;
  currentHref?: string;
  onSelect: (href: string) => void;
}

function TocRow({ item, depth, currentHref, onSelect }: TocRowProps) {
  const active = isActiveTocItem(item.href, currentHref);
  return (
    <>
      <Button
        variant="ghost"
        onClick={() => onSelect(item.href)}
        aria-current={active ? 'true' : undefined}
        className={`!w-full !justify-start !h-auto !px-0 !py-2.5 !pr-4 !rounded-none text-[15px] leading-snug !text-current active:opacity-40 transition-opacity ${active ? 'font-semibold text-blue-500' : ''}`}
        style={{ paddingLeft: 16 + depth * 20 }}
      >
        {item.label}
      </Button>
      {item.subitems?.map(sub => (
        <TocRow key={sub.id} item={sub} depth={depth + 1} currentHref={currentHref} onSelect={onSelect} />
      ))}
    </>
  );
}

export function TocPanel({
  open,
  toc,
  currentHref,
  chromeBackground,
  chromeColor,
  onSelect,
  onClose,
}: TocPanelProps) {
  return (
    <div
      data-testid="toc-panel"
      className={`fixed inset-0 z-40 transition-opacity duration-200 ${
        open ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-hidden={!open}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* 左侧抽屉 */}
      <div
        className={`absolute top-0 left-0 bottom-0 w-80 max-w-[85vw] flex flex-col backdrop-blur-xl border-r transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: chromeBackground, color: chromeColor, borderColor: 'rgba(128,128,128,0.25)' }}
        role="dialog"
        aria-label="目录"
      >
        <div
          className="flex items-center justify-between px-4 h-14 shrink-0 border-b"
          style={{ borderColor: 'rgba(128,128,128,0.25)' }}
        >
          <h2 className="text-[17px] font-semibold">目录</h2>
          <IconButton onClick={onClose} aria-label="关闭目录" variant="ghost" className="!w-auto !h-auto !p-2 !rounded-lg !text-current active:opacity-40 transition-opacity text-lg leading-none">
            &times;
          </IconButton>
        </div>

        <nav className="flex-1 overflow-y-auto py-2" aria-label="章节目录">
          {toc.length === 0 ? (
            <p className="px-4 py-8 text-sm text-center" style={{ opacity: 0.6 }}>本书暂无目录</p>
          ) : (
            toc.map(item => (
              <TocRow key={item.id} item={item} depth={0} currentHref={currentHref} onSelect={onSelect} />
            ))
          )}
        </nav>
      </div>
    </div>
  );
}
