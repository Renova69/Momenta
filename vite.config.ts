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
      '@': path.resolve(import.meta.dirname, './src'),
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
  build: {
    // Vite 6's default, kept on purpose. Vite 8 raised its own to Safari 16.4
    // and Chrome 111, and a guest's phone is whatever they brought to the
    // wedding: below that floor the bundle would not parse and the album would
    // open blank, where today it opens with plainer styling.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
  },
});
