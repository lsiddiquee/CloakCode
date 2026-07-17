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

/**
 * Self-contained HTML for the operator-TOTP **pairing** webview (docs/04, F2a):
 * the `otpauth://` QR to scan into an authenticator app, plus the base32 secret
 * as selectable text for manual entry. Same strict CSP as the phone link (inline
 * SVG QR, no scripts). Pure, so it is unit-tested without a webview. The secret
 * is shown only in this operator-facing panel, never sent to the phone or logged.
 */
export function mfaPairingHtml(
  otpauthUri: string,
  secretBase32: string,
): string {
  const safeSecret = escapeHtml(secretBase32);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
    <style>
      body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); text-align: center; padding: 24px; }
      .qr { background: #fff; display: inline-block; padding: 12px; border-radius: 8px; }
      .qr svg { width: 260px; height: 260px; }
      code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; word-break: break-all; user-select: all; }
      .hint { opacity: 0.7; font-size: 0.85em; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h2>Pair CloakCode operator access</h2>
    <p>Scan with an authenticator app (Google Authenticator, 1Password, …):</p>
    <div class="qr">${qrSvg(otpauthUri)}</div>
    <p>Or enter this secret manually:</p>
    <p><code>${safeSecret}</code></p>
    <p class="hint">Your phone then enters the 6-digit code once to sign in. This secret stays on this machine — never sent to the phone or logged.</p>
  </body>
</html>`;
}
