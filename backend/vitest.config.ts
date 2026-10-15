import { defineConfig } from 'vitest/config';

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
