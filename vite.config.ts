import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  // Tailwind 4 through its Vite plugin: no PostCSS config, no autoprefixer.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 6500,
    host: true, // Enables listening on all network interfaces for local phone QR scanning testing
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:6501',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:6501',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 6500,
    host: true,
    strictPort: true,
  },
});
