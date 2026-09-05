import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 3020 so a running deployment's app (3010) and API (3001) are untouched while the shell is
// developed against them.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 3020, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
