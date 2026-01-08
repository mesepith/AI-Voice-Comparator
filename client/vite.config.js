import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mac frontend port requested: 7078
// Backend requested: 7079
export default defineConfig({
  plugins: [react()],
  server: {
    port: 7078,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:7079",
      "/ws": {
        target: "ws://127.0.0.1:7079",
        ws: true,
      }
    }
  }
});
