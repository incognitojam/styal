import { AuthOrchestrationOperateScope, ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  findEnvironmentUpdate,
  supportsEnvironmentUpdate,
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

  it("requires remote desktop update support for desktop hosts", () => {
    expect(supportsEnvironmentUpdate({})).toBe(false);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "respawn" })).toBe(true);
    expect(supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed" })).toBe(false);
    expect(
      supportsEnvironmentUpdate({ serverSelfUpdate: "desktop-managed", desktopAppUpdate: true }),
    ).toBe(true);
  });

  it("excludes unavailable, manual, busy, and incompatible provider updates", () => {
    expect(canUpdateEnvironmentProvider(provider)).toBe(true);
    expect(canUpdateEnvironmentProvider({ ...provider, installed: false })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, availability: "unavailable" })).toBe(false);
    expect(canUpdateEnvironmentProvider({ ...provider, versionAdvisory: undefined })).toBe(false);
    for (const latestVersionStatus of ["broken", "unsupported"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          compatibilityAdvisory: {
            status: "supported",
            latestVersionStatus,
            message: null,
            recommendedVersion: null,
            recommendedRange: null,
          },
        }),
      ).toBe(false);
    }
    for (const status of ["queued", "running"] as const) {
      expect(
        canUpdateEnvironmentProvider({
          ...provider,
          updateState: {
            status,
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ).toBe(false);
    }
    expect(
      canUpdateEnvironmentProvider({
        ...provider,
        versionAdvisory: {
          ...provider.versionAdvisory!,
          canUpdate: false,
        },
      }),
    ).toBe(false);
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
  ])("checks %s with one request and never offers a downgrade", async (current, tags, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(tags));
    vi.stubGlobal("fetch", request);
    expect(await findEnvironmentUpdate(current, signal)).toBe(expected);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://registry.npmjs.org/-/package/@styal/cli/dist-tags",
      { signal },
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
