import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@cloakcode/web/App";
import "@cloakcode/web/styles.css";
import { installFakeBridge } from "./fake-bridge-socket";
import { resolveScenario, SCENARIOS } from "./scenarios";

// Swap the global WebSocket for the in-browser fake BEFORE the App mounts, so
// every bridge call it makes is answered from fixtures. The App code is the real
// shipped component — imported from @cloakcode/web via that package's exports.
const scenario = resolveScenario(window.location.search);
installFakeBridge(scenario);

// The picker is the URL, so the index goes to the console rather than on top of
// the UI — a switcher widget would land in every screenshot taken from here.
console.info(
  `[playground] scenario "${scenario.id}" — ${scenario.label}\n` +
    SCENARIOS.map((s) => `  ?scenario=${s.id.padEnd(10)} ${s.summary}`).join(
      "\n",
    ),
);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
