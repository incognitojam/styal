import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMaintainEnvironment,
  findEnvironmentUpdate,
  isLatestProviderVersionUntested,
} from "./environment-maintenance";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex-personal",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T00:00:00.000Z",
  models: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    canUpdate: true,
    updateCommand: null,
    checkedAt: null,
    message: null,
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );

  it("marks a latest release newer than the verified version as untested", () => {
    const withVerified = (verifiedVersion: string) => ({
      ...provider,
      compatibilityAdvisory: {
        status: "supported" as const,
        message: null,
        recommendedVersion: null,
        recommendedRange: null,
        verifiedVersion,
      },
    });
    expect(isLatestProviderVersionUntested(withVerified("1.0.5"))).toBe(true);
    expect(isLatestProviderVersionUntested(withVerified("1.1.0"))).toBe(false);
    expect(isLatestProviderVersionUntested(provider)).toBe(false);
  });
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  it.each([
    ["1.0.0", { latest: "1.1.0", nightly: "2.0.0-nightly.20261011.1" }, "1.1.0"],
    ["1.1.0", { latest: "1.1.0" }, null],
    ["1.3.0", { latest: "1.1.0" }, null],
    [
      "1.0.0-nightly.20261010.9",
      { nightly: "1.0.0-nightly.20261011.10" },
      "1.0.0-nightly.20261011.10",
    ],
    [
      "1.0.0-preview.20261010.1",
      { preview: "1.0.0-preview.20261011.2" },
      "1.0.0-preview.20261011.2",
    ],
    ["1.0.0-nightly.20261011.10", { nightly: "1.0.0-nightly.20261010.9" }, null],
  ])("checks %s and never offers a downgrade", async (current, tags, expected) => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).startsWith("https://registry.npmjs.org/")
          ? Response.json(tags)
          : new Response(),
      );
    vi.stubGlobal("fetch", request);
    expect(await findEnvironmentUpdate(current, signal)).toBe(expected);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "https://registry.npmjs.org/-/package/@styal/cli/dist-tags",
      { signal },
    );
    if (expected === null) {
      expect(request).toHaveBeenCalledTimes(1);
    } else {
      expect(request).toHaveBeenNthCalledWith(
        2,
        `https://github.com/incognitojam/styal/releases/download/v${expected}/SHA256SUMS`,
        { method: "HEAD", signal },
      );
    }
  });

  it("does not offer a version whose release archives are not published yet", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ latest: "1.1.0" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", request);
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow(
      "styal 1.1.0 is still being published",
    );
  });

  it.each([
    [new Response(null, { status: 429 }), "429"],
    [Response.json({}), "No published stable release"],
    [Response.json({ latest: "1.0.0-nightly.20261011.1" }), "outside the stable channel"],
    [Response.json({ latest: "garbage" }), "Unsupported release version"],
    [Response.json({ latest: 123 }), "unexpected shape"],
    [new Response("invalid json"), ""],
  ])("reports failed checks without another lookup", async (response, message) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("propagates a cancelled request without reporting up to date", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    vi.stubGlobal("fetch", request);
    await expect(findEnvironmentUpdate("1.0.0", signal)).rejects.toThrow("Cancelled");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
