import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/public/assets": "http://localhost:8000",
      "/sample_data": "http://localhost:8000",
      "/rivers": "http://localhost:8000",
      "/dams": "http://localhost:8000",
      "/dam": "http://localhost:8000",
      "/simulate": "http://localhost:8000",
      "/dem": "http://localhost:8000",
      "/weather": "http://localhost:8000",
      "/compare": "http://localhost:8000",
      "/report": "http://localhost:8000",
      "/failure-modes": "http://localhost:8000",
      "/api": "http://localhost:8000",
    },
  },
});
