import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// I0 dev: the web client talks to the local bridge over WebSocket. The bridge
// URL is overridable via VITE_BRIDGE_URL (e.g. through a tunnel) at I3.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
