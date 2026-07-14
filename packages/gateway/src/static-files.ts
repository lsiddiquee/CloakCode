import * as path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/** MIME type for a file path by extension; `application/octet-stream` if unknown. */
export function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/**
 * Map a request URL path to a safe absolute file path under `rootDir`, or `null`
 * when the path escapes the root (directory traversal), is malformed, or carries
 * a null byte. `/` (and any trailing-slash path) maps to `index.html`. Pure: the
 * caller performs the disk read, so this stays unit-testable without a
 * filesystem — the gateway's only security-sensitive path check lives here.
 */
export function resolveStaticPath(
  rootDir: string,
  urlPath: string,
): string | null {
  const raw = urlPath.split(/[?#]/, 1)[0] || "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null; // null byte
  const rel = decoded.endsWith("/") ? decoded + "index.html" : decoded;
  const root = path.resolve(rootDir);
  const full = path.resolve(
    root,
    "." + (rel.startsWith("/") ? rel : "/" + rel),
  );
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}
