# Design Tokens + 统一组件库设计文档（迭代 B）

> 版本：v1.0 | 日期：2026-07-29 | 状态：开发中

## 1. 背景与问题

项目已有基础色彩变量（`:root`/`.dark` 16 个 color tokens）和 Tailwind `ios.*` 映射，但存在三个系统性缺口：

1. **Token 覆盖不全**：只有颜色，缺语义状态色（success/warning/danger）、z-index 层级、动画时长/缓动、排版、阴影语义层。组件内大量 `style={{ background: 'var(--color-primary)' }}` 手写内联。
2. **无统一基础组件**：`alert()` / `window.confirm()` 散落 5 处（原生弹窗体验割裂）；ReaderPage 手写 copiedToast；BookshelfPage 手写 fixed overlay Modal。
3. **硬编码颜色残留**：`bg-gray-50`/`border-blue-500`/`text-gray-500` 等 Tailwind 默认色绕过主题变量，暗色模式下不协调。

## 2. 目标

- 建立完整 Design tokens CSS 变量体系（7 大类），light/dark 双主题
- 交付统一组件库第一批：Button / Toast / Modal
- 替换全部原生 alert/confirm + 手写 toast/modal，验证组件库可用性
- 零破坏：纯增量 + 定向替换，不批量迁移页面级按钮（下一迭代）

## 3. Design Tokens 体系

### 3.1 Token 分类（存储于 index.css `:root` / `.dark`）

| 类别 | Token 前缀 | 示例 | 主题敏感 |
|------|-----------|------|----------|
| 品牌/语义色 | `--color-*` | `--color-primary`, `--color-danger` | ✅ |
| 状态色 | `--color-success/warning/danger` | `--color-success-subtle` | ✅ |
| 遮罩 | `--color-overlay` | `rgba(0,0,0,0.4)` | ✅ |
| 间距 | `--space-*` | `--space-4: 16px` | ❌ |
| 圆角 | `--radius-*` | `--radius-lg: 16px` | ❌ |
| 阴影 | `--shadow-*` | `--shadow-overlay` | ✅（dark 更深） |
| 层级 | `--z-*` | `--z-modal: 400` | ❌ |
| 动画 | `--duration-*`, `--ease-*` | `--duration-normal: 250ms` | ❌ |
| 排版 | `--text-*`, `--leading-*` | `--text-lg: 17px` | ❌ |

### 3.2 z-index 层级规范

```
dropdown(100) < sticky(200) < drawer(300) < modal(400) < toast(500)
```

### 3.3 Tailwind 映射（tailwind.config.js）

- `colors.ios.*`：新增 success/warning/danger/overlay 及 subtle 变体
- `zIndex`：dropdown/sticky/drawer/modal/toast
- 组件内部优先使用 Tailwind token class（如 `bg-ios-danger`），减少内联 style

## 4. 组件库设计（frontend/src/components/ui/）

### 4.1 Button

```tsx
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;   // 默认 'primary'
  size?: ButtonSize;         // 默认 'md'
  loading?: boolean;         // spinner + 禁用交互
  fullWidth?: boolean;
}
```

- 全部样式走 token 变量，dark 自动适配
- loading 时渲染 SVG spinner，pointer-events 禁用
- 继承全局按压反馈（index.css button:active scale）

### 4.2 Toast

**架构**：模块级 store（发布订阅）+ `<ToastProvider>` 渲染栈。命令式 API 可在 React 组件外调用。

```tsx
toast.success('已复制');
toast.error('删除失败', { duration: 4000 });
toast.info('提示');
toast.warning('注意');
```

- 位置：顶部居中（top safe-area 下方）
- 默认时长：普通 2500ms / error 3500ms
- 堆叠上限 4 条，超出移除最旧
- 入场 slide-down + fade，离场 fade + shrink
- z-index: `--z-toast`(500)

### 4.3 Modal

**声明式**：
```tsx
<Modal open={bool} onClose={fn} title="标题">内容</Modal>
```

**命令式 confirm**（替代 window.confirm）：
```tsx
const ok = await confirm({
  title: '删除确认',
  message: '此操作不可恢复',
  confirmText: '删除',
  danger: true,
});
```

- 架构同 Toast：模块级 store + `<ConfirmProvider>`
- 交互：backdrop 点击关闭 / ESC 关闭 / body scroll lock
- 入场：overlay fade + panel pop-in（复用现有 `animate-pop-in`）
- 无障碍：`role="dialog"` `aria-modal` `aria-labelledby`
- z-index: `--z-modal`(400)
- 底部按钮使用 Button 组件（dogfooding）

### 4.4 barrel export（ui/index.ts）

```ts
export { Button } from './Button';
export { ToastProvider, toast } from './Toast';
export { Modal, ConfirmProvider, confirm } from './Modal';
```

## 5. 集成计划（第一批）

| 位置 | 现状 | 替换为 |
|------|------|--------|
| main.tsx | 无 Provider | 挂载 ToastProvider + ConfirmProvider |
| ReaderPage L226 | `window.confirm('重新解析...')` | `await confirm({...})` |
| ReaderPage L243 | `alert(err)` | `toast.error(err)` |
| ReaderPage L516-523 | 手写 copiedToast JSX + state | `toast.success('已复制到剪贴板')` |
| BookshelfPage L137 | `window.confirm('删除...')` | `await confirm({danger:true})` |
| BookshelfPage L143,174 | `alert(err)` ×2 | `toast.error(err)` |
| BookshelfPage Edit Modal | 手写 fixed overlay | `<Modal>` + `<Button>` |
| App.tsx loading | `bg-gray-50`/`border-blue-500` 硬编码 | token class |

## 6. 测试计划

| 文件 | 用例 |
|------|------|
| Button.test.tsx | 渲染 children / 点击触发 / disabled 阻断 / loading 阻断+spinner / variant class |
| Toast.test.tsx | toast.success 显示 / 自动消失 / 多条堆叠 |
| Modal.test.tsx | open 渲染 title / backdrop 关闭 / confirm() 确认=true / 取消=false / ESC 关闭 |

## 7. 开发执行计划

### 迭代 B-1：基础设施（本轮）
- [x] 调研现状（tokens/组件/alert-confirm 清点）
- [x] 设计文档落盘
- [x] index.css token 扩展（7 大类 + dark 变体）
- [x] tailwind.config.js 映射扩展
- [x] ui/Button.tsx + ui/Toast.tsx + ui/Modal.tsx + ui/index.ts
- [x] 3 个测试文件（23 用例全绿）
- [x] 集成：main.tsx / ReaderPage / BookshelfPage(20处) / App.tsx
- [x] tsc --noEmit 零错误
- [x] vitest run 全绿（22 files / 175 tests）
- [x] version 2.32.0 + commit + push + deploy

### 迭代 B-2（后续）
- [ ] 页面级按钮批量迁移至 Button
- [ ] UploadQueue / TocDrawer 迁移至 Modal/Drawer 体系
- [ ] 硬编码颜色全量清扫（bg-gray-* / text-blue-*）
- [ ] Input / Switch / Badge 第二批组件
