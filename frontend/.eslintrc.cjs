/**
 * ESLint 配置 — 最小化规则集
 * 核心目的：禁止业务层新增原生 <button>，防回潮（设计体系统一）
 * UI 基础组件（Button/IconButton）内部渲染原生 button 不受限制。
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  ignorePatterns: ['dist', 'node_modules', '*.config.*'],
  overrides: [
    {
      files: ['src/**/*.{ts,tsx}'],
      excludedFiles: [
        'src/components/ui/Button.tsx',
        'src/components/ui/IconButton.tsx',
        'src/components/ui/ToggleSwitch.tsx',
      ],
      rules: {
        'no-restricted-syntax': ['error', {
          selector: 'JSXOpeningElement[name.name="button"]',
          message: '禁止使用原生 <button>，请使用 <Button> 或 <IconButton> 组件（components/ui/）。',
        }],
      },
    },
  ],
};
