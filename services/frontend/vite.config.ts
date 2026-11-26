import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode: _mode }) => ({
  server: {
    // This computer only: the proxy below reaches the API as localhost, so a dev server open to the
    // network would open the API to it too (localHostOnly in the backend).
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      // Sign in with ChatGPT returns the browser here; the backend checks the one-time state.
      '/auth/callback': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "zod": path.resolve(__dirname, "./node_modules/zod"),
      "@/routes": path.resolve(__dirname, "./src/routes"),
      "@/hooks": path.resolve(__dirname, "./src/shared/hooks"),
      "@/lib": path.resolve(__dirname, "./src/shared/lib"),
      "@/ui": path.resolve(__dirname, "./src/shared/ui"),
      "@modules": path.resolve(__dirname, "./src/modules"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    exclude: ['node_modules', 'tests/e2e/**'],
    globals: true,
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./tests/coverage",
    },
  },
  build: {
    assetsInlineLimit: 0, // Don't inline assets
  },
}));
