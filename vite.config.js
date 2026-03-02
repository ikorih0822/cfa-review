import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ⚠️ base の値をあなたのGitHubリポジトリ名に変更してください
// 例: リポジトリ名が "cfa-review" なら '/cfa-review/'
export default defineConfig({
  plugins: [react()],
  base: '/cfa-review/',
})
