import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the domain root on Vercel.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
  },
});
