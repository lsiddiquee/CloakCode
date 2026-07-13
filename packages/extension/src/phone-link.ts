import qrcode from "qrcode-generator";

/**
 * Encode `text` as a QR code and return inline **SVG markup** (a string of
 * `<rect>`s, not a rasterized image), so rendering is just painting text — no
 * canvas or PNG work. `qrcode-generator` is a tiny, zero-dependency encoder;
 * type `0` picks the smallest QR that fits, `M` is medium error correction.
 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

/**
 * True when `url`'s host is loopback (`127.0.0.1` / `localhost` / `::1`) — i.e.
 * reachable only from this machine, not a phone. `asExternalUri` returns such a
 * URL in local dev containers, which is exactly when the operator needs a real
 * public forward / tunnel instead.
 */
export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/**
 * Self-contained HTML for the "phone link" webview: the QR (scan to open) plus
 * the URL as selectable text. Strict CSP — `default-src 'none'` with inline
 * styles only; the QR is inline SVG, so no external/script/resource loads are
 * needed (the panel is created with `enableScripts: false`). Pure, so the markup
 * assembly and HTML-escaping are unit-tested without a webview.
 */
export function phoneLinkHtml(url: string): string {
  const safe = escapeHtml(url);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
    <style>
      body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); text-align: center; padding: 24px; }
      .qr { background: #fff; display: inline-block; padding: 12px; border-radius: 8px; }
      .qr svg { width: 260px; height: 260px; }
      a { color: var(--vscode-textLink-foreground); word-break: break-all; }
      .hint { opacity: 0.7; font-size: 0.85em; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h2>Scan to open CloakCode on your phone</h2>
    <div class="qr">${qrSvg(url)}</div>
    <p><a href="${safe}">${safe}</a></p>
    <p class="hint">One port serves the app and the live <code>/bridge</code>. Reach it through your authenticated tunnel.</p>
  </body>
</html>`;
}
