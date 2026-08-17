import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    proxy: {
      // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
      // the app's HTML and the socket fails with an opaque error that looks like a server problem.
      "/api": {
        target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
        ws: true,
      },
    },
  },
});
