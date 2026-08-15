/**
 * chromeThemeManager — 浏览器镀铬主题管理器单测
 *
 * 覆盖：enter/update/exit 三态语义、引用计数、确定性还原（还原首次初始值）、
 * 页面恢复重放（pageshow/visibilitychange）、重置钩子。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  enterChromeTheme,
  exitChromeTheme,
  resetChromeThemeManagerForTests,
  updateChromeTheme,
} from './chromeThemeManager';

const DEFAULT_META = '#3b82f6';

beforeEach(() => {
  resetChromeThemeManagerForTests();
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.setAttribute('content', DEFAULT_META);
  document.head.appendChild(meta);
});

describe('chromeThemeManager', () => {
  it('enter 应用主题背景到 theme-color + html/body；update 更新；exit 还原首次初始值', () => {
    enterChromeTheme('#2c2c2e');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe('#2c2c2e');
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');

    updateChromeTheme('#000000');
    expect(meta?.getAttribute('content')).toBe('#000000');
    expect(document.body.style.background).toBe('rgb(0, 0, 0)');

    exitChromeTheme();
    expect(meta?.getAttribute('content')).toBe(DEFAULT_META);
    expect(document.documentElement.style.background).toBe('');
    expect(document.body.style.background).toBe('');
  });

  it('主题切换走 update 不触发中间还原（引用计数不变）', () => {
    enterChromeTheme('#ffffff');
    updateChromeTheme('#2c2c2e');
    // 若无 update 语义（exit+enter），此处会先还原为初始值（白）再应用——管理器保证不还原
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    exitChromeTheme();
    expect(document.body.style.background).toBe('');
  });

  it('引用计数：两个实例并存，一个退出后仍保持主题背景，全部退出才还原', () => {
    enterChromeTheme('#2c2c2e');
    enterChromeTheme('#2c2c2e'); // 第二个实例
    exitChromeTheme();
    expect(document.body.style.background).toBe('rgb(44, 44, 46)'); // 仍有活跃实例
    exitChromeTheme();
    expect(document.body.style.background).toBe(''); // 归零还原
  });

  it('还原目标为首次 enter 时记录的初始值（非倒数第二次主题色）', () => {
    document.documentElement.style.background = 'rgb(10, 20, 30)';
    document.body.style.background = 'rgb(40, 50, 60)';
    enterChromeTheme('#ffffff');
    updateChromeTheme('#2c2c2e');
    updateChromeTheme('#000000');
    exitChromeTheme();
    expect(document.documentElement.style.background).toBe('rgb(10, 20, 30)');
    expect(document.body.style.background).toBe('rgb(40, 50, 60)');
  });

  it('页面恢复重放：根背景被外部还原为白后，pageshow 重放当前主题背景', () => {
    enterChromeTheme('#2c2c2e');
    // 模拟 iOS 快照恢复：根背景被还原为书架白色（组件 effect 不重跑的场景）
    document.documentElement.style.background = 'rgb(255, 255, 255)';
    document.body.style.background = 'rgb(255, 255, 255)';
    window.dispatchEvent(new Event('pageshow'));
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
  });

  it('visibilitychange→visible 时重放当前主题背景', () => {
    enterChromeTheme('#2c2c2e');
    document.body.style.background = 'rgb(255, 255, 255)';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
  });

  it('无活跃阅读器时（已 exit），pageshow 不重放（不污染书架/全局外观）', () => {
    enterChromeTheme('#2c2c2e');
    exitChromeTheme();
    document.body.style.background = 'rgb(255, 255, 255)';
    window.dispatchEvent(new Event('pageshow'));
    expect(document.body.style.background).toBe('rgb(255, 255, 255)');
  });

  it('阅读态禁用 body 背景过渡（仅保留 color 过渡），退出还原初始 transition（状态栏不采样中间色）', () => {
    // 模拟全局 CSS：body 带 background 0.3s 过渡（index.css 深色模式动画）
    document.body.style.transition = 'background 0.3s ease, color 0.3s ease';
    enterChromeTheme('#2c2c2e');
    // 进入阅读：body 过渡改为仅 color，background 立即生效无渐变
    expect(document.body.style.transition).toBe('color 0.3s ease');
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    // 主题切换（update）同样无 background 过渡
    updateChromeTheme('#000000');
    expect(document.body.style.transition).toBe('color 0.3s ease');
    expect(document.body.style.background).toBe('rgb(0, 0, 0)');
    // 退出阅读：还原初始 transition（全局动画恢复）与初始背景
    exitChromeTheme();
    expect(document.body.style.transition).toBe('background 0.3s ease, color 0.3s ease');
    expect(document.body.style.background).toBe('');
  });
});
