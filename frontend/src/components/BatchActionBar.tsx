/**
 * BatchActionBar — 书架批量选择操作栏（从 BookshelfPage 提取）
 *
 * 数据驱动的 actions 数组，新增批量操作只需在数组中追加一项。
 */
import { Button, type ButtonVariant } from './ui';

export interface BatchAction {
  id: string;
  label: string;
  icon: string;
  /** 按钮视觉变体（默认 primary） */
  variant?: ButtonVariant;
  disabled: boolean;
  loading?: boolean;
  onClick: () => void;
}

export interface BatchActionBarProps {
  selectedCount: number;
  totalCount: number;
  onToggleSelectAll: () => void;
  onExit: () => void;
  actions: BatchAction[];
}

export function BatchActionBar({ selectedCount, totalCount, onToggleSelectAll, onExit, actions }: BatchActionBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 px-4 py-3 bg-ios-bg-card border-t border-ios-border shadow-[0_-2px_12px_rgba(0,0,0,0.06)]">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ios-text-secondary">
            已选择 <strong className="text-ios-primary">{selectedCount}</strong> 本
          </span>
          <span className="text-ios-border">|</span>
          <Button variant="text" size="sm" onClick={onToggleSelectAll}>
            {selectedCount > 0 && selectedCount >= totalCount ? '☐ 全不选' : '☑ 全选'}
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={onExit}>取消</Button>
          {actions.map(action => (
            <Button
              key={action.id}
              variant={action.variant ?? 'primary'}
              size="sm"
              loading={action.loading}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {action.icon} {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default BatchActionBar;
