import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development, requests to /api are forwarded to Django, so the browser
// never makes a cross-origin call and you do not need CORS while developing.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const djangoTarget = env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [react()],
    server: {
      host: true, // expose on your LAN so a phone can open the QR link
      port: 5173,
      proxy: {
        '/api': { target: djangoTarget, changeOrigin: true },
      },
    },
  };
});
