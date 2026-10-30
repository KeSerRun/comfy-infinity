import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = "http://127.0.0.1:8190";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api": gateway,
      "/health": gateway,
      "/logo.png": gateway,
      "/v1": gateway,
    },
  },
});
