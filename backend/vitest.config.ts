import { defineConfig } from 'vitest/config';
import fs from 'fs';
import path from 'path';

// 安全加固 D34 后 secUserEmail.json 不再入库（.gitignore）：
// CI/全新 clone 环境无此文件，注册类测试会 403。此处（每个 worker 加载配置时执行）
// 确保白名单文件存在（写入后保留供本机开发使用；pnpm test 的 cwd 即 backend/）。
const whitelistPath = path.resolve(process.cwd(), 'secUserEmail.json');
if (!fs.existsSync(whitelistPath)) {
  fs.writeFileSync(whitelistPath, JSON.stringify(['youmu88@gmail.com', '276935214@qq.com'], null, 2), 'utf-8');
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // 安全加固 D6 后 JWT_SECRET 无默认兜底：测试环境注入专用测试密钥（长度>32）
    env: {
      JWT_SECRET: 'vitest-only-test-secret-0123456789abcdef',
    },
  },
});
