import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the domain root on Vercel.
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Third-party code in its own chunks: they change only when a dependency
        // is upgraded, so browsers keep them cached across app deploys, and the
        // app chunk stays under Vite's 500 kB warning.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "supabase", test: /node_modules[\\/]@supabase[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
