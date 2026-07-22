import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const rendererSourceMap = process.env.RECALL_RENDERER_SOURCEMAP === "1";

// Vite 仅负责 renderer 构建
// main 进程由 tsc 单独编译到 dist/main
export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: rendererSourceMap,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  plugins: [react()],
});
