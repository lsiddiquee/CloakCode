import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only UI playground for @cloakcode/web. It imports the REAL App + styles
// from the web package (via that package's `exports`) and swaps the global
// WebSocket for an in-browser fake, so the whole PWA runs against fixtures with
// no gateway. The boundary is structural: this package depends on `web`, never
// the reverse, so nothing here can ever reach the shipped web build/vsix.
export default defineConfig({
  plugins: [react()],
  // Both this package and @cloakcode/web declare react ^18.3.1; force ONE
  // physical copy so hooks in the cross-package App don't hit "invalid hook
  // call" from a duplicate React.
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: true,
    // Distinct from web's dev (5280) / preview (5290) so both can run at once.
    port: 5285,
    strictPort: true,
    allowedHosts: true,
    // No /bridge proxy: the fake WebSocket answers everything in-browser.
  },
});
