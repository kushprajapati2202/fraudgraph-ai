import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Node global, declared locally so the config type-checks without @types/node.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
    // Under WSL the repo lives on a Windows drive, where file-change events are not delivered: poll instead.
    watch: process.env.WSL_DISTRO_NAME ? { usePolling: true, interval: 400 } : undefined,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: { manualChunks: { cytoscape: ["cytoscape"], react: ["react", "react-dom", "react-router-dom"] } },
    },
  },
});
