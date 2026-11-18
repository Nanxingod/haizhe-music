import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // 以下几条是最新预设带来的"风格类"规则，在这个项目里属于有意为之的写法，
      // 降到 warn/off 以便 `npm run lint` 不再被几十条噪音淹没（构建不依赖 lint）。
      // 真问题（未使用变量、hooks 依赖顺序等）仍然保持 error。
      '@typescript-eslint/no-explicit-any': 'off',        // (window as any).electronAPI 等
      'no-empty': ['warn', { allowEmptyCatch: true }],     // 大量"失败就算了"的 catch
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',                          // 播放进度用 ref 避免重渲染
      'react-hooks/purity': 'warn',                        // 播放头插值需要 render 期读 performance.now
      'react-refresh/only-export-components': 'off',       // 组件文件里会导出常量/事件名
    },
  },
])
