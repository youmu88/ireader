#!/usr/bin/env node
/**
 * 构建后处理：为旧浏览器提供兼容性降级
 * 
 * 将 Vite 构建产物的 ES Module 格式 JS 转换为传统 script 可加载格式，
 * 并修改 index.html 实现自动检测加载。
 * 
 * 用法: node scripts/bundle-compat.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const DIST_DIR = join(import.meta.dirname, '..', 'frontend', 'dist');
const DEPLOY_DIR = '/home/ubuntu/.ireader/app/frontend/dist';

// 读取 index.html
const htmlPath = join(DIST_DIR, 'index.html');
const html = readFileSync(htmlPath, 'utf-8');

// 解析 script 标签
const scriptMatch = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
if (!scriptMatch) {
  console.error('未找到 <script type="module"> 标签');
  process.exit(1);
}

const jsPath = join(DIST_DIR, scriptMatch[1].replace(/^\//, ''));
const jsFileName = scriptMatch[1];

console.log(`[1/3] 主 JS 文件: ${jsFileName}`);

// 读取 JS bundle（ES Module 格式）
const jsContent = readFileSync(jsPath, 'utf-8');

// 创建传统版 JS 文件名（把 module 中的 import/export 移除）
// 注意：Vite 构建的 ES Module bundle 内部已经使用 var/IIFE 封装，
// 外部仅靠 type="module" 隔离作用域。改为传统 script 时，
// 需要将其包装到 IIFE 中防止全局变量污染。
const compatJsName = jsFileName.replace('.js', '.compat.js');
const compatJsPath = join(DIST_DIR, compatJsName.replace(/^\//, ''));

// Vite 的 ES Module bundle 结构通常是:
// var xxx = (() => { ... })();
// 或 import / export 语句
// 
// 对于 Vite 构建的 SPA bundle，它实际已经是 IIFE 形式，
// 只需移除顶层的 export/import 语句即可

// 简单处理：移除所有顶层的 "export {" 语句和 static import
let compatJs = jsContent
  // 移除顶层 export 语句
  .replace(/^export \{[\s\S]*?\};\s*$/gm, '')
  .replace(/^export var /gm, 'var ')
  .replace(/^export const /gm, 'const ')
  .replace(/^export let /gm, 'let ')
  .replace(/^export function /gm, 'function ')
  .replace(/^export class /gm, 'class ')
  .replace(/^export default /gm, 'var __default__ = ')
  // 移除顶层的 import.meta 相关
  .replace(/\bimport\.meta\b/g, '({})');

// 包装到 IIFE 中防止全局污染
compatJs = `(function(){
"use strict";
${compatJs}
})();`;

writeFileSync(compatJsPath, compatJs);
console.log(`[2/3] 传统版 JS 已生成: ${compatJsName} (${(compatJs.length / 1024).toFixed(1)} KB)`);

// 修改 index.html：保留 module 版本（给新浏览器）+ 添加 nomodule 回退
const newHtml = html
  .replace(
    /<script type="module" crossorigin src="([^"]+)"><\/script>/,
    `<script type="module" crossorigin src="$1"></script>\n    <script nomodule crossorigin src="${compatJsName}"></script>`
  );

writeFileSync(htmlPath, newHtml);
console.log(`[3/3] index.html 已更新，添加了 nomodule 回退`);

// 如果部署目录存在，同步部署
if (existsSync(DEPLOY_DIR)) {
  console.log(`\n同步到部署目录: ${DEPLOY_DIR}`);
  
  // 同步 HTML
  writeFileSync(join(DEPLOY_DIR, 'index.html'), newHtml);
  
  // 同步 compat JS
  const deployCompatPath = join(DEPLOY_DIR, compatJsName.replace(/^\//, ''));
  writeFileSync(deployCompatPath, compatJs);
  
  console.log('✓ 已同步到部署目录');
}

console.log('\n✅ 兼容处理完成！');
console.log('现代浏览器: 加载 type="module" 版本');
console.log('旧浏览器: 加载 nomodule 回退版本');
