import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'node:path'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    sourcemap: true,
    // Stable, distinct names reduce CRX entry mix-ups between SW and content
    rollupOptions: {
      input: {
        bubble: resolve(__dirname, 'src/bubble/index.html'),
        // Control panel is opened as a tab (no action default_popup); must be a build entry.
        popup: resolve(__dirname, 'src/popup/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // Prevent pre-bundling issues with chrome types in tests/build
  optimizeDeps: {
    exclude: ['@crxjs/vite-plugin'],
  },
})
