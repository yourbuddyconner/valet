import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'path';

export default defineConfig(({ mode }) => ({
  plugins: [
    TanStackRouterVite({
      autoCodeSplitting: true,
    }),
    react()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Development builds: skip minification to preserve component names,
    // readable stack traces, and React DevTools support.
    minify: mode === 'development' ? false : 'esbuild',
    sourcemap: mode === 'development' ? true : false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks — change rarely, cache well
          'vendor-react': ['react', 'react-dom', 'react/jsx-runtime'],
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-sanitize'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-toast',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
}));
