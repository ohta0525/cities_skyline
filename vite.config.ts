import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 相対パスにして、GitHub Pages のサブパスでも動くようにする
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
