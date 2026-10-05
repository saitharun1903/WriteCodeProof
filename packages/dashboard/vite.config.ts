import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Settings come from the repo-root .env, like the rest of the project.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  if (!env.PORT || !env.DASHBOARD_PORT || !env.HOST) {
    throw new Error('Set HOST, PORT and DASHBOARD_PORT in .env (see .env.example)');
  }
  return {
    plugins: [react()],
    server: {
      host: env.HOST,
      port: Number(env.DASHBOARD_PORT),
      strictPort: true,
      // The dashboard talks to the API on PORT, as it does when the API serves it.
      proxy: { '/api': `http://${env.HOST}:${env.PORT}` },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
