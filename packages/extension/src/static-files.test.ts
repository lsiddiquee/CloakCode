import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { contentTypeFor, resolveStaticPath } from "./static-files.js";

const root = path.resolve("/srv/web");

describe("resolveStaticPath", () => {
  it("maps / and trailing-slash paths to index.html", () => {
    expect(resolveStaticPath(root, "/")).toBe(path.join(root, "index.html"));
    expect(resolveStaticPath(root, "/app/")).toBe(
      path.join(root, "app", "index.html"),
    );
  });

  it("resolves assets under the root and strips the query", () => {
    expect(resolveStaticPath(root, "/assets/app.js")).toBe(
      path.join(root, "assets", "app.js"),
    );
    expect(resolveStaticPath(root, "/manifest.webmanifest?v=2")).toBe(
      path.join(root, "manifest.webmanifest"),
    );
  });

  it("rejects directory traversal, raw and percent-encoded", () => {
    expect(resolveStaticPath(root, "/../secret")).toBeNull();
    expect(resolveStaticPath(root, "/..%2f..%2fetc/passwd")).toBeNull();
    expect(resolveStaticPath(root, "/a/../../etc")).toBeNull();
  });

  it("rejects malformed encoding and null bytes", () => {
    expect(resolveStaticPath(root, "/%ff")).toBeNull();
    expect(resolveStaticPath(root, "/x%00y")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("/x/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("s.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("icon.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});
