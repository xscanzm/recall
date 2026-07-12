import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const brandAssets = ["logo.png", "logo-512.png", "favicon.ico"];

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-recall-brand-assets",
      async writeBundle() {
        const output = resolve(import.meta.dirname, "dist");
        await mkdir(output, { recursive: true });
        await Promise.all(
          brandAssets.map((asset) =>
            copyFile(
              resolve(import.meta.dirname, "../src/renderer/public", asset),
              resolve(output, asset),
            ),
          ),
        );
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        productDemo: resolve(import.meta.dirname, "product-demo.html"),
      },
    },
  },
});
