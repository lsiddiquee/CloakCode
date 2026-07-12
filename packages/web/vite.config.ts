import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// HMR defaults OFF for stable mobile/LAN testing — the HMR websocket through
// container/host networking can trigger reconnect/full-reload loops on a phone.
// Re-enable explicitly with CLOAKCODE_HMR=on.
const hmrEnabled = process.env["CLOAKCODE_HMR"] === "on";

// The client talks to the bridge over a SAME-ORIGIN `/bridge` WebSocket, which
// Vite proxies to the localhost bridge. This keeps the bridge bound to
// 127.0.0.1 (security rule 3) while exposing only ONE port — so the same
// forwarded/tunnelled port that serves the app also carries the WebSocket, and
// nothing hardcodes `localhost` (which on a phone would mean the phone itself).
export default defineConfig({
  plugins: [react()],
  test: {
    // Component tests (SessionView) need a DOM; the pure tests run fine under it too.
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
  server: {
    // Bind ALL interfaces. Inside a Dev Container, VS Code forwards the port via
    // IPv4 127.0.0.1, but Vite's default `localhost` binds IPv6 ::1 ONLY, so the
    // forwarded port can't reach it and the page "keeps loading". host:true fixes it.
    host: true,
    // Dedicated port (5280) unlikely to collide with other projects' 5173, so
    // VS Code forwards it 1:1 to the host instead of remapping (5173 -> 5174).
    // Fail loudly if taken instead of drifting to another port — which would no
    // longer match the forwarded port and would also look like "keeps loading".
    port: 5280,
    strictPort: true,
    // Vite 5 blocks unknown Hosts; allow serving through a forwarded/tunnel host.
    allowedHosts: true,
    hmr: hmrEnabled ? { protocol: "ws", clientPort: 5280 } : false,
    proxy: {
      "/bridge": {
        target: process.env["CLOAKCODE_BRIDGE"] ?? "ws://127.0.0.1:7801",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  // `vite preview` serves the built (frozen) app with the same same-origin
  // /bridge proxy — used for an isolated, stable instance while dev continues.
  // Defaults to a separate port + bridge so it never collides with `vite dev`.
  preview: {
    host: true,
    port: Number(process.env["CLOAKCODE_PREVIEW_PORT"] ?? 5290),
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/bridge": {
        target: process.env["CLOAKCODE_BRIDGE"] ?? "ws://127.0.0.1:7802",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
