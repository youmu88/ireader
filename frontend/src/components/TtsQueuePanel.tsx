/**
 * TtsQueuePanel — TTS 预生成队列可视化面板（从 BookshelfPage 提取，迁移至统一 Modal 体系）
 *
 * 职责：展示语音生成任务列表、批量选择、取消/删除/清除操作
 * 获得 Modal 基础设施：portal 渲染、ESC 关闭、body scroll-lock、z-modal 层级、入场动画
 */
import { Modal, Button, IconButton } from './ui';

export interface TTSJob {
  id: string;
  bookId: string;
  bookTitle: string;
  voice: string;
  speed: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  totalChunks: number;
  completedChunks: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TtsQueuePanelProps {
  open: boolean;
  ttsJobs: TTSJob[];
  selectedJobIds: Set<string>;
  onToggleJobSelection: (id: string) => void;
  onSelectAllJobs: () => void;
  onDeselectAllJobs: () => void;
  onBatchCancelSelected: () => void;
  onBatchDeleteSelected: () => void;
  onCancelJob: (jobId: string) => void;
  onClearTerminated: () => void;
  onClearAllJobs: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

const STATUS_LABEL: Record<string, string> = { pending: '排队中', running: '生成中', completed: '已完成', failed: '失败' };
const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-ios-warning-subtle text-ios-warning',
  running: 'bg-ios-primary-subtle text-ios-primary',
  completed: 'bg-ios-success-subtle text-ios-success',
  failed: 'bg-ios-danger-subtle text-ios-danger',
};

export function TtsQueuePanel({
  open, ttsJobs, selectedJobIds,
  onToggleJobSelection, onSelectAllJobs, onDeselectAllJobs,
  onBatchCancelSelected, onBatchDeleteSelected, onCancelJob,
  onClearTerminated, onClearAllJobs, onRefresh, onClose,
}: TtsQueuePanelProps) {
  const hasActive = ttsJobs.some(j => j.status === 'pending' || j.status === 'running');
  const terminatedCount = ttsJobs.filter(j => j.status === 'completed' || j.status === 'failed').length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-lg"
      panelClassName="!p-0 max-h-[70vh] flex flex-col overflow-hidden"
      bodyClassName="flex-1 flex flex-col min-h-0 overflow-hidden"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-ios-border">
        <h3 className="text-base font-semibold flex items-center gap-1.5 text-ios-text">
          🎙 语音生成队列
          {hasActive && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-ios-primary">
              <span className="w-2 h-2 rounded-full animate-pulse bg-ios-primary" />
              任务进行中
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onRefresh}>🔄 刷新</Button>
          <IconButton onClick={onClose} variant="ghost" size="sm" className="text-xl" aria-label="关闭">&times;</IconButton>
        </div>
      </div>

      {/* 批量选择工具栏 */}
      {ttsJobs.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-ios-border bg-ios-bg-alt">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onSelectAllJobs}>☑ 全选</Button>
            <Button variant="secondary" size="sm" onClick={onDeselectAllJobs}>□ 取消全选</Button>
          </div>
          {selectedJobIds.size > 0 && (
            <div className="flex items-center gap-1.5">
              <Button variant="warning" size="sm" onClick={onBatchCancelSelected} title="取消选中的排队/运行中任务">⏹ 取消选中</Button>
              <Button variant="danger" size="sm" onClick={onBatchDeleteSelected} title="删除选中的任务（不限状态）">🗑 删除选中</Button>
            </div>
          )}
        </div>
      )}

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
        {ttsJobs.length === 0 ? (
          <p className="text-center py-8 text-sm text-ios-text-muted">暂无语音生成任务</p>
        ) : (
          ttsJobs.slice(0, 30).map(job => {
            const pct = job.totalChunks > 0 ? Math.min(job.completedChunks / job.totalChunks, 1) : 0;
            const isSelected = selectedJobIds.has(job.id);
            return (
              <div
                key={job.id}
                className={`border rounded-xl p-3 cursor-pointer transition-all duration-200 ${
                  isSelected ? 'border-ios-primary bg-ios-primary-subtle' : 'border-ios-border bg-ios-bg-card'
                }`}
                onClick={() => onToggleJobSelection(job.id)}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                      isSelected ? 'bg-ios-primary border-ios-primary' : 'border-ios-border'
                    }`}>
                      {isSelected && <span className="text-white text-[10px] font-bold">✓</span>}
                    </div>
                    <span className="text-sm font-medium truncate text-ios-text">{job.bookTitle}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {(job.status === 'pending' || job.status === 'running') && (
                      <Button onClick={(e) => { e.stopPropagation(); onCancelJob(job.id); }} variant="danger" size="sm" title="取消此任务">✕ 取消</Button>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[job.status] || ''}`}>
                      {STATUS_LABEL[job.status] || job.status}
                    </span>
                  </div>
                </div>
                {(job.status === 'running' || job.status === 'pending') && (
                  <div className="mt-2 ml-6">
                    <div className="flex items-center justify-between text-xs text-ios-text-muted mb-1">
                      <span>{job.completedChunks || 0} / {job.totalChunks || '?'} 段</span>
                      <span>{Math.round(pct * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full overflow-hidden bg-ios-border">
                      <div className="h-full rounded-full transition-all duration-500 bg-ios-primary" style={{ width: `${Math.round(pct * 100)}%` }} />
                    </div>
                  </div>
                )}
                {job.status === 'failed' && job.error && (
                  <p className="mt-1.5 ml-6 text-xs text-ios-danger truncate" title={job.error}>❌ {job.error}</p>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-ios-border">
        <span className="text-xs text-ios-text-muted">{ttsJobs.length} 个任务</span>
        <div className="flex items-center gap-2">
          {terminatedCount > 0 && (
            <Button variant="secondary" size="sm" onClick={onClearTerminated}>🧹 清除已完成/失败</Button>
          )}
          {hasActive && (
            <Button variant="danger" size="sm" onClick={onClearAllJobs}>🗑 清除全部排队任务</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default TtsQueuePanel;
