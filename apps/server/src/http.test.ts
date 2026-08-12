import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetResponseHeaders,
  isLoopbackHostname,
  normalizeTerminalBrowserOpenUrl,
  resolveDevRedirectUrl,
  terminalBrowserOpenBearerToken,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("terminal browser-open routing", () => {
  it("accepts a non-empty bearer credential", () => {
    expect(terminalBrowserOpenBearerToken("Bearer terminal-token")).toBe("terminal-token");
    expect(terminalBrowserOpenBearerToken("Basic terminal-token")).toBeNull();
    expect(terminalBrowserOpenBearerToken("Bearer   ")).toBeNull();
    expect(terminalBrowserOpenBearerToken(undefined)).toBeNull();
  });

  it("normalizes bounded http URLs and rejects unsupported targets", () => {
    expect(normalizeTerminalBrowserOpenUrl("http://localhost:5173/app")).toBe(
      "http://localhost:5173/app",
    );
    expect(normalizeTerminalBrowserOpenUrl("file:///tmp/index.html")).toBeNull();
    expect(normalizeTerminalBrowserOpenUrl(`https://example.com/${"x".repeat(2_100)}`)).toBeNull();
  });
});
