# 前端兼容性策略文档

## 概述

本项目前端采用**渐进增强（Progressive Enhancement）** 策略，核心原则：

> **所有设备都能获取基础功能，新设备在此基础上叠加高级特性。**

## 设备分级

| 等级 | 判定条件 | 特性策略 |
|------|---------|---------|
| **高性能** | CPU ≥ 6 核，或内存 ≥ 8GB（或信息不可用时默认） | 全部特性启用：毛玻璃、弹性动画、高级 CSS 滤镜 |
| **中性能** | CPU 4 核，或内存 4GB | 部分动效降级，保留毛玻璃 |
| **低性能** | CPU ≤ 2 核，或内存 ≤ 2GB | 禁用毛玻璃，禁用按压缩放动画，减少所有动效 |

> **注意**：如果 CPU 核心数和内存信息均不可用（如部分旧浏览器），默认走"高性能"路径，确保不限制功能。

## 实现机制

### 1. CSS 层 — `@supports` + 媒体查询

- **`backdrop-filter` 不支持时的后备**：使用 `@supports not (backdrop-filter: blur(1px))` 检测，为所有 `.glass*` 类提供纯色回退背景。
- **`prefers-reduced-motion: reduce`**：系统辅助功能设置了"减少动效"时，禁用所有 CSS 动画、弹性过渡、按压缩放等效果。

位置：`frontend/src/index.css` 头部「渐进增强 — 设备兼容性策略」区块。

### 2. JS 运行时层 — 性能检测

- **文件**：`frontend/src/services/compatibilityService.ts`
- **检测指标**：
  - `navigator.hardwareConcurrency` — CPU 逻辑核心数
  - `navigator.deviceMemory` — 设备内存（GB，Chrome 专用，其他浏览器为 undefined）
  - `CSS.supports('backdrop-filter', ...)` — Feature Detection
  - `window.matchMedia('(prefers-reduced-motion: reduce)')` — 系统动效偏好
- **低性能设备标记**：在 `<html>` 元素上添加 `.low-perf` 类，CSS 据此降级毛玻璃和动画。

### 3. React Context 层 — 组件消费

- `useTheme().compatibility` 返回 `CompatibilityInfo` 对象，组件可据此条件渲染高级功能。
- 示例：
  ```tsx
  const { compatibility } = useTheme();
  if (compatibility.disableGlass) {
    // 使用纯色背景替代毛玻璃
  }
  ```

## 支持的浏览器范围

| 浏览器 | 最低版本 | 备注 |
|--------|---------|------|
| Safari | 13+ | macOS 10.15+。Safari 13 开始支持 `backdrop-filter` |
| Chrome | 90+ | 全面支持 |
| Firefox | 90+ | 全面支持 |
| Edge | 90+ | 基于 Chromium |

> **历史兼容**：更低版本的 Safari（≤12）也能加载页面，但毛玻璃效果会回退为纯色背景，动效禁用。基础阅读功能不受影响。

## 验证方法

1. **低性能模拟**：在 Chrome DevTools → Performance → CPU throttling 选择 "4x slowdown"，检查页面是否自动降级
2. **无 `backdrop-filter` 测试**：Chrome DevTools → Rendering → 勾选 "Disable `backdrop-filter`"，检查毛玻璃区域是否显示纯色背景
3. **减少动效测试**：系统设置中开启"减少动效"（macOS: 系统设置 → 辅助功能 → 显示 → 减少动态效果），检查所有动画是否禁用
