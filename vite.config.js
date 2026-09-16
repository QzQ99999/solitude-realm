import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5180,
    open: false,
    // 禁用开发期模块缓存：浏览器每次都拿最新代码，避免旧逻辑残留
    headers: {
      'Cache-Control': 'no-store'
    }
  },
  build: {
    target: 'es2022'
  }
});
