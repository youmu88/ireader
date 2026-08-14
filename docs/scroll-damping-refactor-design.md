# iReader 滚动阻尼机制重构设计文档

> 版本：v1.0（评审稿）
> 日期：2026-08-03
> 范围：`frontend/src/reader/scrollDamping.ts` + `EpubBookController.ts` 集成 + `SettingsPage.tsx` 联动
> 状态：**设计评审中，尚未实施**（实施需用户确认后分阶段启动）

---

## 0. TL;DR（三句话结论）

1. **用户真实需求只有两个**：epub 连续滚动（epub.js 原生能力，`flow+manager` 两行配置，零自研）+ 一定阻尼感（位移缩放 + 惯性衰减，核心约 60 行）。其余都是实现债。
2. **"复杂"的根源是 Web 平台限制**：移动端要做触摸阻尼，必须拦截原生滚动（preventDefault），而拦截即杀死原生惯性，所以必须自建惯性引擎——这套引擎的**存在是必要的，形态是冗余的**。
3. **重构收敛为三层管线**（输入适配器 → 纯函数阻尼核心 → 滚动目标），砍掉三处实现债：①双参数插值模型统一为单一阻尼系数；②touch-action 引用计数移出装配函数、改由容器生命周期管理；③逐事件读 localStorage 改为缓存 + 变更广播。预期 `scrollDamping.ts` 由 **234 行 → ~160 行**，行为等价（1-10 级、默认 3、全局设置、触摸 + wheel 全部保留）。

---

## 1. 背景与目标

### 1.1 需求演进（历史 3 轮）

| 轮次 | 需求 | 落地内容 |
|------|------|---------|
| 第1轮 | 阅读界面上下滚动阻尼 1-10 级，默认 3 | wheel 拦截器 + aA 面板滑块 |
| 第2轮 | 改为全局设置；触摸滚动为主场景 | 迁入设置页；新增自研触摸惯性引擎 |
| 第3轮 | 修复阻尼导致垂直滚动失效 | 确诊根因（滚动目标是 `.epub-container` 而非 iframe 文档），实现「事件监听与滚动目标分离」 |
| **第4轮（本轮）** | **机制太复杂冗余，只需要连续滚动 + 一定阻尼感** | **本设计文档** |

### 1.2 本轮目标

- 深度剖析当前滚动机制的复杂度构成，逐项判定「必要 vs 冗余」
- 给出目标架构与重构方案（保持行为等价：1-10 级、全局设置、触摸 + wheel）
- 输出评审稿，待用户确认后分阶段实施

---

## 2. 现状剖析：机制全景

### 2.1 三层组成

```
┌─────────────────────────────────────────────────────────┐
│ ① epub.js 连续滚动层（库原生，非自研）                      │
│    flow:'scrolled-continuous' + manager:'continuous'      │
│    → ContinuousViewManager：多章节拼接进同一滚动容器        │
│    滚动容器 = 父页面 div.epub-container（overflow-y:scroll）│
│    iframe 内容文档 scrolling="no" 不滚动                    │
│    relocated 事件驱动章节衔接 / 进度                        │
├─────────────────────────────────────────────────────────┤
│ ② 触摸阻尼引擎（自研 ~100 行，移动端主场景）                │
│    事件挂 iframe 内容文档（capture 阶段）                   │
│    方向锁定（6px 阈值：垂直接管 / 水平交还原生）             │
│    touchmove preventDefault + 位移×系数 → 手动 scrollTop    │
│    touchend 后 rAF 惯性（指数衰减 exp(-k·dt)）              │
│    多指放行（捏合缩放交还原生）                             │
├─────────────────────────────────────────────────────────┤
│ ③ wheel 阻尼拦截（自研 ~15 行，桌面端）                     │
│    deltaMode 归一化（行/页）→ ×系数 → 手动 scrollTop        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 支撑设施（代码清单）

| 设施 | 位置 | 说明 |
|------|------|------|
| 设置持久化 | `scrollDamping.ts` `load/saveScrollDamping` | localStorage `ireader_scroll_damping`，1-10 默认 3 |
| 参数模型 | `dampingMultiplier` / `frictionCoeff` | 两套独立线性插值（MULT_AT_MIN/MAX + FRICTION_AT_MIN/MAX） |
| touch-action 引用计数 | `claimTouchAction` / `releaseTouchAction` + `touchActionState` WeakMap | 多 iframe 文档共享同一容器时防还原污染 |
| 容器解析 | `EpubBookController.load` `querySelector('.epub-container')` | 依赖 epub.js 内部类名 |
| 装配去重 | `dampingCleanups` Map + `attachDampingDoc` 幂等 | 每 iframe 文档仅装配一次 |
| 防御性跳过 | `attachDampingDoc` `!this.scrollTarget` 时静默跳过 | 容器解析失败不装配 |

### 2.3 `scrollDamping.ts` 行数分布（共 234 行）

| 区块 | 行数 | 判定 |
|------|------|------|
| 文件头注释 / 常量声明 | ~20 | 必要 |
| 设置持久化（load/save/clamp/levelT） | ~30 | 必要 |
| 参数模型（两套插值 + 4 组魔法常量） | ~30 | **冗余（可减半）** |
| wheel 拦截 | ~15 | 必要 |
| 触摸引擎（状态机 + 惯性 + 5 个 handler） | ~90 | 必要但形态臃肿 |
| touch-action 引用计数 | ~25 | **冗余（可移除）** |
| 装配与卸载 | ~25 | 必要 |

---

## 3. 复杂度与冗余诊断（深度分析）

### 3.1 逐项判定

| # | 现状 | 支撑用户需求？ | 诊断 |
|---|------|--------------|------|
| D1 | 触摸惯性引擎整体（状态机闭包） | ✅ 是（触摸阻尼的体感核心） | **必要**：Web 平台限制下无替代，但实现形态需结构化 |
| D2 | 双参数插值（multiplier + friction 独立常量组） | ⚠️ 间接 | **冗余**：两套参数描述同一件事（"级别越高越沉"），应统一为单一阻尼系数，friction 由 multiplier 推导 |
| D3 | touch-action 引用计数（WeakMap） | ❌ 否 | **冗余**：touch-action 是**容器属性**，与"每文档事件监听"天然解耦，应由容器生命周期管理（装配一次/还原一次），而非被 N 个文档装配共享计数 |
| D4 | `getLevel()` 每次 touchmove/wheel 读 localStorage | ❌ 否 | **冗余**：触摸 move 频率 60-120Hz，逐次 `getItem+Number+clamp` 无必要；改缓存 + 变更事件广播 |
| D5 | 防御性跳过（scrollTarget 缺失静默不装配） | ❌ 否 | **违规**（模块内部防御）：容器解析失败是集成前提被破坏，应 fail-fast 明确报错，而非静默降级 |
| D6 | `querySelector('.epub-container')` 内部类名依赖 | ❌ 否 | 低优先债：epub.js 稳定 class 风险低，可保留（上轮可选优化点，暂不优先） |
| D7 | velocity 单帧估算（dy/dt） | ⚠️ 间接 | 低优：改为多帧加权平均抗抖（可选） |
| D8 | wheel + touch 两套回调并存 | ⚠️ 间接 | 结构性：统一为"增量输入 → 共享阻尼核心"，消除重复的缩放/滚动逻辑 |

### 3.2 为什么触摸阻尼必然要自建引擎（平台约束，不是设计失误）

这是判断"哪些是债、哪些是刚需"的关键前提：

1. **阻尼感 = 拖动位移缩放**。Web 上唯一实现途径：拦截 `touchmove` + `preventDefault` + 手动 `scrollTop += Δ×系数`。
2. **preventDefault 杀死原生滚动（含原生惯性）** → 松手必须自建惯性，否则骤停生硬。→ 惯性引擎是刚需，不是过度设计。
3. **事件与滚动目标分离不可消除**：epub.js scrolled-continuous 的滚动容器在父页面 `.epub-container`，而触摸/滚轮事件在 iframe 内容文档内派发，iframe 事件**不跨文档冒泡**（第3轮 bug 的根因所在，也是修复后架构）。→ 事件挂 iframe 文档、滚动落父容器，是 epub.js 架构刚需。
4. **方向锁定 / 多指放行是必要的**：不判断方向会吞掉横滑返回手势（iOS 边缘滑动）与捏合缩放；这是移动端 Web 阅读器的标准护栏。

**结论**：触摸引擎的"存在"不是冗余，其"实现形态"是冗余（一团闭包状态机 + 与容器属性纠缠）。重构对象是形态，不是功能。

### 3.3 用户需求 vs 现状的映射

| 用户需求 | 现状支撑 | 自研代码量 |
|---------|---------|-----------|
| epub 连续滚动 | epub.js `scrolled-continuous` + `manager:'continuous'`（两行配置） | **0 行**（库能力） |
| 一定阻尼感 | multiplier 位移缩放 + 惯性衰减 | **~60 行**（必要核心） |
| —（无需求） | touch-action 引用计数、双参数插值、逐事件读存储、防御跳过 | **~70 行**（实现债，本轮清理目标） |

### 3.4 复杂度账本

- 现状 `scrollDamping.ts`：**234 行**（必要 ~160 / 债 ~70 / 头注释 ~20）
- 目标：**~160 行**，复杂度净降 ~30%，模块边界清晰、可测性提升
- 系统复杂度变化：**降**（铁律：只降不升）

---

## 4. 重构目标架构

### 4.1 三层管线（核心愿景）

```
┌─ 输入层（Input Adapters）───────────────────────────┐
│  WheelInput : wheel → delta(px)（deltaMode 归一化）  │
│  TouchInput : TouchGesture 状态机 → delta(px) + 惯性初速 │
└───────────────────────┬─────────────────────────────┘
                        ▼ delta / v
┌─ 阻尼核心（Damping Core，纯函数）─────────────────────┐
│  scaleDelta(delta, level)  位移缩放                   │
│  decay(v, level, dt)       惯性衰减（由 multiplier 推导摩擦）│
└───────────────────────┬─────────────────────────────┘
                        ▼ scrollTop 增量
┌─ 输出层（ScrollTarget）─────────────────────────────┐
│  div.epub-container.scrollTop += Δ                   │
└──────────────────────────────────────────────────────┘
```

### 4.2 模块组织（保持单文件，内部三段）

**决策**：不拆多文件（234→160 行不值得引入新文件/导入面），用类型 + 注释划清边界；若未来行数超 250 再拆 `damping-core.ts` / `input-adapters.ts`。

```ts
// ── ① 纯函数段（可单测，无 DOM）──
export function clampScrollDamping(level: number): number;   // 保留
export function dampingMultiplier(level: number): number;    // 保留 0.9→0.25
export function frictionCoeff(mult: number): number;         // ★ 签名改为入参 multiplier，由 multiplier 推导
export function scaleDelta(delta: number, level: number): number; // ★ 新增薄封装

// ── ② 输入段（DOM 事件 → 增量）──
class TouchGesture { /* 原闭包状态收敛为字段；可独立单测 */ }
class Momentum { start(v, level) / cancel() }               // ★ 惯性独立成类

// ── ③ 装配与生命周期段 ──
export function attachScrollDamping(doc, scrollTarget, getLevel): () => void; // ★ 不再管理 touch-action
export function claimContainerTouchAction(el): void;        // ★ 新增：容器级单次设置
export function releaseContainerTouchAction(el): void;      // ★ 新增：容器级单次还原

// ── 设置 ──
export function loadScrollDamping(): number;                 // 保留
export function saveScrollDamping(level): void;              // ★ 内部 dispatch 变更事件
```

### 4.3 关键设计决策

**决策 1：单一阻尼系数（消 D2）**

- `multiplier = 0.9 → 0.25`（1→10 级，线性，保留现状语义与手感曲线）
- `friction = FRICTION_BASE + (1 - multiplier) × FRICTION_SCALE`
  - 取 `FRICTION_BASE = 0.0012`、`FRICTION_SCALE = 0.0064` → 1 级 k≈0.0012（滑行远）、10 级 k≈0.006（几乎不滑），**与现状插值曲线完全一致**
- 删除 `FRICTION_AT_MIN/MAX` 两组常量（约 -15 行）；保留 `MOMENTUM_STOP_V`、`MOMENTUM_MAX_V`（惯性阈值，语义独立）

**决策 2：touch-action 容器生命周期化（消 D3，本轮最大简化）**

- 现状缺陷：`attachScrollDamping` 每文档装配都 claim 容器 → 必须引用计数（WeakMap + 幂等还原），间接且难推理
- 目标：touch-action 是**容器属性**，其生命周期 = 容器生命周期：
  - `Controller.load`：容器解析成功后 `claimContainerTouchAction(scrollTarget)`（一次）
  - `Controller.destroy`：`releaseContainerTouchAction(scrollTarget)`（一次）
  - `attachScrollDamping` 不再触碰 touch-action（-25 行，删 WeakMap）
- 语义更正确：多个 iframe 文档的事件监听共享同一容器，容器属性由容器持有者管理，天然无共享计数问题

**决策 3：level 缓存 + 变更广播（消 D4）**

- 装配时读一次 level 存入缓存；`getLevel` 从缓存读（不再逐事件读 localStorage）
- `saveScrollDamping` 内 `window.dispatchEvent(new CustomEvent('ireader:damping-changed', { detail: level }))`
- Controller 监听事件更新缓存（设置页改动 → 阅读器即时生效，与现状「动态读取」等效）
- 兼容：SSR/测试环境 `window` 不可用或事件不派发时，装配期快照兜底（不报错）

**决策 4：fail-fast（消 D5）**

- `attachDampingDoc` 中 scrollTarget 缺失时 `console.error('滚动容器解析失败，阻尼未装配：...')`，不再静默
- 边界判定：这是对**外部依赖**（epub.js DOM 结构）的边界校验，属合法防御（铁律：外部边界可防御），非模块内部兜底

**决策 5：事件/滚动目标分离保留（非债，不消）**

- 第3轮修复成果，epub.js 架构刚需；保留 `attachScrollDamping(doc, scrollTarget, getLevel)` 签名

**决策 6：输入统一抽象（消 D8）**

- wheel 与 touch 最终都产出「阻尼后增量」喂给同一 `scrollTarget.scrollTop += Δ`；共享 `scaleDelta`，消除重复缩放逻辑

### 4.4 触摸引擎结构化（TouchGesture / Momentum）

现状是 attachScrollDamping 内一团闭包（active/axis/velocity/momentumRaf + 5 handler + 2 辅助函数，~90 行）。目标：

```ts
class TouchGesture {
  // 状态收敛为字段：active / axis / startX / startY / lastY / lastT / velocity
  onStart(e: TouchEvent): void;
  onMove(e: TouchEvent): number | null;   // 返回阻尼后应滚动增量；null = 不接管（水平/多指）
  onEnd(e: TouchEvent): number | null;    // 返回惯性初速；null = 不启动惯性
  onCancel(): void;
}

class Momentum {
  start(v: number, level: number): void;  // rAF 指数衰减，内部封装 cancel
  cancel(): void;
}
```

收益：
- TouchGesture 可喂合成 TouchEvent 序列独立单测（断言接管/放行/方向锁定/增量缩放）
- Momentum 可 mock rAF 单测衰减曲线（断言指数衰减与停止阈值）
- attachScrollDamping 只剩"挂事件 + 卸载"，可读性显著提升

---

## 5. 行为等价性保障（重构红线）

以下语义**必须保持不变**，任何偏差即重构失败：

| 行为 | 现状 | 重构后 |
|------|------|--------|
| 阻尼级别 | 1-10，默认 3，全局 localStorage | 不变 |
| 触摸场景 | 移动端主场景，方向锁定/多指放行/惯性 | 不变 |
| wheel 场景 | 桌面端，deltaMode 归一化 | 不变 |
| 事件目标 | iframe 内容文档（capture） | 不变 |
| 滚动目标 | 父页面 `.epub-container` | 不变 |
| 设置联动 | 设置页滑块 → 阅读器即时生效 | 不变（改事件广播通道） |
| 边界钳制 | scrollTop 自然钳制（无橡皮筋回弹，沿用） | 不变 |
| 卸载 | destroy 全量清理 | 不变（touch-action 还原移到 destroy） |

---

## 6. 实施计划（分阶段，每阶段独立可交付可回滚）

> 顺序原则：**先测试后改码；每阶段跑全量单测 + 类型检查；行为等价重构阶段不 bump 功能版本**

| 阶段 | 内容 | 交付物 | 风险 |
|------|------|--------|------|
| P0 | 基线确认 | 2.58.1，`vitest run` 221 绿，`pnpm typecheck` 0 | 无 |
| P1 | 参数模型统一：`frictionCoeff(mult)` 改签名 + 删 FRICTION_AT_MIN/MAX + 曲线等价单测 | 纯重构 commit | 低（数学等价，测试锁死） |
| P2 | touch-action 移出装配：删 WeakMap/claim/release，Controller 加容器生命周期调用 | 重构 commit（删 ~25 行） | 低（单测改容器生命周期用例） |
| P3 | level 缓存 + `ireader:damping-changed` 广播：SettingsPage +1 行 dispatch，Controller 监听 | 重构 commit | 低（jsdom 可测事件） |
| P4 | TouchGesture / Momentum 类化 + 新单测（合成触摸序列 + rAF mock） | 重构 commit | 中（状态机搬移，靠测试兜底） |
| P5 | fail-fast（scrollTarget 缺失 console.error） | 小 commit | 低 |
| P6 | 回归 + 真机 + 版本 bump + CI | 版本 **2.59.0**（结构调整大，建议 minor） | 中（真机手感需验证） |

**预期改动文件**：`scrollDamping.ts`（-74 行）、`scrollDamping.test.ts`（结构同步）、`EpubBookController.ts`（±10 行）、`SettingsPage.tsx`（+1 行）、`version.ts`。

---

## 7. 风险与验证

### 7.1 风险清单

| 风险 | 等级 | 缓解 |
|------|------|------|
| 触摸/滚动回归（重构核心风险） | 高 | 221 单测兜底 + e2e + 真机双端验证；阶段推进、每阶段全量回归 |
| iOS Safari preventDefault 行为 | 已闭环（第3轮验证） | 保持事件挂 iframe 文档不变，不触碰已验证路径 |
| Android WebView 双重滚动风险 | 遗留（历史已知） | 本轮重构**不引入新风险**（不改变 preventDefault 策略）；真机验证时一并确认 |
| 事件广播通道在测试环境兼容 | 低 | jsdom 支持 CustomEvent；SSR 兜底快照 |
| 重构引入隐性行为漂移 | 中 | 红线清单（第5节）+ 曲线等价单测锁死手感 |

### 7.2 验证清单

- [ ] `pnpm typecheck`（backend + frontend）exit 0
- [ ] `vitest run` 全量绿（新增 TouchGesture/Momentum/容器生命周期用例）
- [ ] 真机 iOS Safari：触摸拖动缩放、松手惯性、横滑返回手势、捏合缩放、设置即时生效
- [ ] 真机 Android（如可用）：preventDefault 传播行为 + 双重滚动排查
- [ ] 桌面 Chrome：wheel 阻尼、deltaMode 行/页归一化

---

## 8. 待决策点（评审确认项）

| # | 决策点 | 推荐 | 说明 |
|---|--------|------|------|
| P1 | 触摸引擎结构化粒度 | 类化（TouchGesture/Momentum） | 闭包整理成本低但可测性不变；类化换取独立单测 |
| P2 | 版本号策略 | minor（2.59.0） | 行为等价但结构调整大；若团队偏好保守可 patch（2.58.2） |
| P3 | 实施节奏 | 确认后按 P1→P6 分阶段执行 | 每阶段一个 commit，可随时叫停 |
| P4 | Android 真机验证预算 | 需设备/浏览器栈 | 无 Android 设备时以 iOS Safari + 桌面验证为准，风险如实记录 |

---

## 9. 附录：关键事实链

### 9.1 滚动目标根因链（第3轮已确诊，重构的前提约束）

| 环节 | 证据 |
|------|------|
| 滚动容器是父页面 `.epub-container` | epub.js stage.js:49-51 创建 div.epub-container；74-77 overflow-y:scroll；default/index.js:90 `container=stage.getContainer()`、120-121 `scroller=this.container`（fullsize=false） |
| fullsize=false 的原因 | default/index.js:67-68：仅 renderTo 目标是 body/html 才 fullsize=true；本应用目标是普通 div（viewerRef）→ falsy |
| 事件在 iframe 内容文档 | iframe.js:88-92 iframe scrolling="no"/overflow:hidden 不滚动；触摸/滚轮事件 target 在 iframe 内；iframe 事件不跨文档冒泡 |

### 9.2 现状代码规模（基线快照）

- `scrollDamping.ts`：234 行（第2轮引入触摸引擎，第3轮事件/滚动目标分离 + 引用计数）
- 集成：`EpubBookController.attachDampingDoc`（幂等 Map + 防御跳过）、`load` 中 `querySelector('.epub-container')`
- 设置：`SettingsPage.tsx` 全局滑块（`loadScrollDamping`/`saveScrollDamping`）
- 测试：`scrollDamping.test.ts`（makeEnv 双目标 + 引用计数用例，第3轮同步）

### 9.3 重构红线（一句话）

**只删实现债（双参数/引用计数/逐事件读存储/静默跳过），不碰已验证的行为契约（事件挂 iframe、滚动落容器、方向锁定、多指放行、惯性衰减曲线、1-10 级语义）。**
