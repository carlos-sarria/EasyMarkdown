import { defineConfig } from 'vite';

// Use TAURI_DEV_HOST when running inside a Tauri dev session on a remote host.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Prevent Vite from obscuring Rust compilation errors.
  clearScreen: false,

  server: {
    host: host || false,
    port: 1420,
    strictPort: true,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't trigger HMR for Rust source changes.
      ignored: ['**/src-tauri/**'],
    },
  },

  // Expose Tauri environment variables to the frontend.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    // Tauri targets Chrome 105 on Windows, Safari 13 on macOS/Linux.
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // Disable minification for debug builds; esbuild is fast enough for production.
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
