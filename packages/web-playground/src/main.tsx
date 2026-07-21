import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@cloakcode/web/App";
import "@cloakcode/web/styles.css";
import { installFakeBridge } from "./fake-bridge-socket";

// Swap the global WebSocket for the in-browser fake BEFORE the App mounts, so
// every bridge call it makes is answered from fixtures. The App code is the real
// shipped component — imported from @cloakcode/web via that package's exports.
installFakeBridge();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
