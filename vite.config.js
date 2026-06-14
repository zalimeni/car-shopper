import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from https://<user>.github.io/car-shopper/ in production, so the
// build needs that base path. Dev/preview stay at the root.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/car-shopper/" : "/",
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
  },
}));
