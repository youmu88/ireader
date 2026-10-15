#!/usr/bin/env node
/**
 * 构建期 SW 版本注入（D22）
 *
 * 从 src/version.ts 读取 APP_VERSION，注入 dist/sw.js 的 CACHE_VERSION。
 * 规则：CACHE_VERSION = `v${APP_VERSION}`（版本变化 → SW 文件字节变化 → 浏览器重装 SW 并清理旧缓存）。
 * 由 package.json 的 build 脚本在 vite build 之后调用；dist/sw.js 或版本号缺失时报错退出（不静默）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = resolve(root, 'src/version.ts');
const swFile = resolve(root, 'dist/sw.js');

const versionSrc = readFileSync(versionFile, 'utf-8');
const match = versionSrc.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
if (!match) {
  console.error('[inject-sw-version] 无法从 src/version.ts 解析 APP_VERSION');
  process.exit(1);
}
const version = match[1];

if (!existsSync(swFile)) {
  console.error('[inject-sw-version] dist/sw.js 不存在（请先执行 vite build）');
  process.exit(1);
}

let sw = readFileSync(swFile, 'utf-8');
if (!/const CACHE_VERSION = '[^']*';/.test(sw)) {
  console.error('[inject-sw-version] dist/sw.js 中未找到 CACHE_VERSION 定义');
  process.exit(1);
}
sw = sw.replace(/const CACHE_VERSION = '[^']*';/, `const CACHE_VERSION = 'v${version}';`);
writeFileSync(swFile, sw);
console.log(`[inject-sw-version] CACHE_VERSION -> v${version}（来源 src/version.ts）`);
