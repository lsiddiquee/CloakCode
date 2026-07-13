// Copy the built PWA (@cloakcode/web → its dist/) into the extension's dist/web
// so the packaged gateway can serve it from <extensionUri>/dist/web. Run after
// `pnpm --filter @cloakcode/web build`. Cross-platform (no shell `cp`).
import { cpSync, rmSync } from "node:fs";

rmSync("dist/web", { recursive: true, force: true });
cpSync("../web/dist", "dist/web", { recursive: true });
console.log("[cloakcode] copied web/dist → extension/dist/web");
