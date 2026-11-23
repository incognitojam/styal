// @effect-diagnostics nodeBuiltinImport:off -- These fixtures exercise the native recovery lock and socket boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  disableTailscaleServe,
  ensureTailscaleServe,
  hasExactTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleServeRoutesTo,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  probeTailscaleHttpsEndpoint,
  repairTailscaleServe,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleServePortOccupiedError,
  TailscaleServeRecoveryBusyError,
  TailscaleServeRecordError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const emptyServeStatusJson = `{"TCP":{},"Web":{}}`;
const serveConfig = (servePort: number, proxy: string) => ({
  TCP: { [servePort]: { HTTPS: true } },
  Web: {
    [`desktop.tail.ts.net:${String(servePort)}`]: { Handlers: { "/": { Proxy: proxy } } },
  },
});
const serveStatusJson = (servePort: number, proxy: string) =>
  JSON.stringify(serveConfig(servePort, proxy));

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

const layerRecoveryHome = Layer.mergeAll(
  Layer.effect(
    HostProcess.HomeDirectory,
    Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "serve-recovery-test-"))),
      (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
    ),
  ),
  Layer.succeed(HostProcess.Environment, {}),
  Layer.succeed(HostProcess.Platform, "linux"),
);

function serveFixture() {
  let status: unknown = null;
  const writes: ReadonlyArray<string>[] = [];
  const layer = layerMockSpawner((_command, args) => {
    if (args[1] === "status") return { stdout: JSON.stringify(status) };
    writes.push(args);
    status = args.includes("off") ? null : serveConfig(8443, args.at(-1)!);
    return {};
  });
  return {
    layer,
    writes,
    setStatus: (value: unknown) => {
      status = value;
    },
  };
}

const serverRoute = { localPort: 13773, servePort: 8443, reclaimDeadHandler: true } as const;
const oldProxy = "http://127.0.0.1:39831";
const refusalProbe = () =>
  vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (this: NodeNet.Socket) {
    queueMicrotask(() =>
      this.emit("error", Object.assign(new Error("synthetic refusal"), { code: "ECONNREFUSED" })),
    );
    return this;
  });

it.layer(layerRecoveryHome, { buildPerTest: true })("tailscale", (it) => {
  it.effect("does not treat a non-T3 response on the HTTPS probe path as reachable", () =>
    Effect.gen(function* () {
      for (const [body, status] of [
        ["<!doctype html><title>Other application</title>", 200],
        [null, 204],
      ] as const) {
        const reachable = yield* probeTailscaleHttpsEndpoint({
          baseUrl: "https://desktop.example.ts.net",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
            ),
          ),
        );
        assert.isFalse(reachable, `HTTP ${status} without a T3 descriptor`);
      }
    }),
  );

  it("finds the Serve routes that forward to the bound address, and only those", () => {
    const status = JSON.stringify({
      TCP: {
        "443": { HTTPS: true },
        "7000": { TCPForward: "127.0.0.1:3773" },
        "7001": { TCPForward: "127.0.0.2:3773" },
        "80": { TCPForward: "unix:/run/app.sock" },
      },
      Web: {
        "box.tailnet.ts.net:443": {
          Handlers: {
            "/t3": { Proxy: "http://127.0.0.1:3773" },
            "/dashboard": { Proxy: "http://127.0.0.1:9000" },
          },
        },
        "box.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
        "box.tailnet.ts.net:10000": {
          Handlers: {
            // Another service on another loopback address, and one on the other family.
            "/a": { Proxy: "http://127.0.0.2:3773" },
            "/b": { Proxy: "http://[::1]:3773" },
            "/c": { Proxy: "http://192.168.1.5:3773" },
            "/d": { Proxy: "http://0.0.0.0:3773" },
            "/e": { Proxy: "http://[::ffff:127.0.0.1]:3773" },
            "/f": { Proxy: "http://localhost:3773" },
            // Shorthand Tailscale expands when it proxies.
            "/g": { Proxy: "3773" },
            "/h": { Proxy: "localhost:3773" },
            "/i": { Proxy: "http://[::]:3773" },
            // A name can resolve to any address, the bound one included.
            "/j": { Proxy: "http://ip6-localhost:3773" },
            // Go resolves these as names; a WHATWG URL rejects the first and rewrites the second.
            "/k": { Proxy: "http://box.1:3773" },
            "/l": { Proxy: "http://127.1:3773" },
            "/m": { Proxy: "unix:/run/app.sock" },
            // Credentials before the host, and IPv6 written out in full, still dial here.
            "/n": { Proxy: "http://user:pass@127.0.0.1:3773" },
            "/o": { Proxy: "http://[0:0:0:0:0:ffff:7f00:1]:3773" },
            "/p": { Proxy: "http://127.0.0.1:03773" },
          },
        },
      },
      Services: {
        "svc:t3": {
          Web: {
            "t3.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
          },
        },
      },
      Foreground: {
        session1: { TCP: { "9000": { TCPForward: "localhost:3773" } } },
      },
    });
    assert.deepEqual(parseTailscaleServeRoutesTo(status, { host: "127.0.0.1", port: 3773 }), [
      { servePort: 7000 },
      { servePort: 443, mount: "/t3", host: "box.tailnet.ts.net" },
      // `localhost` and `[::]` can dial either loopback, so they might be another service's.
      ...(
        [
          ["/d", undefined],
          ["/e", undefined],
          ["/f", "localhost"],
          ["/g", undefined],
          ["/h", "localhost"],
          ["/i", "[::]"],
          ["/j", "ip6-localhost"],
          ["/k", "box.1"],
          ["/l", "127.1"],
          ["/n", undefined],
          ["/o", undefined],
          ["/p", undefined],
        ] as const
      ).map(([mount, ambiguous]) => ({
        servePort: 10000,
        mount,
        host: "box.tailnet.ts.net",
        ...(ambiguous === undefined ? {} : { ambiguous }),
      })),
      { servePort: 443, mount: "/", host: "t3.tailnet.ts.net", owner: "svc:t3" },
      { servePort: 9000, ambiguous: "localhost", owner: "foreground" },
    ]);
    assert.deepEqual(
      parseTailscaleServeRoutesTo(
        JSON.stringify({
          Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1" } } } },
        }),
        { host: "127.0.0.1", port: 80 },
      ),
      [{ servePort: 443, mount: "/", host: "box" }],
    );
    assert.deepEqual(parseTailscaleServeRoutesTo("{}", { host: "127.0.0.1", port: 3773 }), []);
    assert.deepEqual(parseTailscaleServeRoutesTo("null", { host: "127.0.0.1", port: 3773 }), []);
    assert.isUndefined(parseTailscaleServeRoutesTo("not json", { host: "127.0.0.1", port: 3773 }));
  });

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
      });
    }),
  );

  it.effect("names the exit node in use", () =>
    Effect.gen(function* () {
      const inUse = yield* parseTailscaleExitNode(
        JSON.stringify({
          ExitNodeStatus: { ID: "nX", Online: true, TailscaleIPs: ["100.101.102.103/32"] },
          Peer: {
            "nodekey:a": { HostName: "laptop", DNSName: "laptop.tail.ts.net.", ExitNode: false },
            "nodekey:b": {
              HostName: "raspberrypi",
              DNSName: "home-pi.tail.ts.net.",
              ExitNode: true,
            },
          },
        }),
      );
      assert.deepEqual(inUse, { name: "home-pi", online: true });

      const unnamed = yield* parseTailscaleExitNode(`{"ExitNodeStatus":{"Online":false}}`);
      assert.deepEqual(unnamed, { name: null, online: false });

      assert.equal(yield* parseTailscaleExitNode(tailscaleStatusJson), null);
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("configures tailscale serve through the process spawner service", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      commands.push(args);
      if (args[1] === "status") {
        return { stdout: emptyServeStatusJson };
      }
      return {};
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    });
  });

  it.effect("treats a null first-time serve status as unconfigured", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return args[1] === "status" ? { stdout: "null" } : {};
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    });
  });

  it.effect("reuses only the exact existing handler", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
    });

    return Effect.gen(function* () {
      assert.isTrue(
        yield* hasExactTailscaleServe({
          servePort: 8443,
          proxy: "http://127.0.0.1:13773",
        }).pipe(Effect.provide(layer)),
      );
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect.each([
    {
      name: "foreground-only",
      background: {},
      foreground: serveConfig(8443, "http://127.0.0.1:13773"),
    },
    {
      name: "foreground overriding an exact background",
      background: serveConfig(8443, "http://127.0.0.1:13773"),
      foreground: serveConfig(8443, "http://127.0.0.1:13773"),
    },
    {
      name: "foreground TCP-only",
      background: {},
      foreground: { TCP: { 8443: { TCPForward: "127.0.0.1:39831" } } },
    },
    {
      name: "foreground web-only",
      background: {},
      foreground: { Web: serveConfig(8443, "http://127.0.0.1:13773").Web },
    },
    {
      name: "foreground Funnel-only",
      background: {},
      foreground: { AllowFunnel: { "desktop.tail.ts.net:8443": true } },
    },
  ])("refuses to reuse, replace, or disable a $name handler", ({ background, foreground }) => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return {
        stdout: JSON.stringify({
          ...background,
          Foreground: { "session-id": foreground },
        }),
      };
    });

    return Effect.gen(function* () {
      const ensureError = yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(ensureError, TailscaleServePortOccupiedError);

      const disableError = yield* disableTailscaleServe({
        localPort: 13773,
        servePort: 8443,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(disableError, TailscaleServePortOccupiedError);
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("configures an unused port while another port has a foreground handler", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return {
        stdout: JSON.stringify({
          Foreground: { "session-id": serveConfig(443, "http://127.0.0.1:39831") },
        }),
      };
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    });
  });

  it.effect(
    "disables an exact background handler while another port has a foreground handler",
    () => {
      const commands: ReadonlyArray<string>[] = [];
      const layer = layerMockSpawner((_command, args) => {
        commands.push(args);
        return {
          stdout: JSON.stringify({
            ...serveConfig(8443, "http://127.0.0.1:13773"),
            Foreground: { "session-id": serveConfig(443, "http://127.0.0.1:39831") },
          }),
        };
      });

      return Effect.gen(function* () {
        yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.provide(layer),
        );
        assert.deepEqual(commands, [
          ["serve", "status", "--json"],
          ["serve", "--https=8443", "off"],
        ]);
      });
    },
  );

  it.effect("refuses to replace a configured port even when its backend differs", () => {
    const layer = layerMockSpawner(() => ({
      stdout: serveStatusJson(8443, "http://127.0.0.1:39831"),
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(error, TailscaleServePortOccupiedError);
      assert.equal(error.servePort, 8443);
    });
  });

  it.effect.each([
    { name: "unrecorded root", unrecorded: true },
    { name: "persistent pairing root", persistent: true },
    { name: "Funnel root", funnel: true },
    { name: "Funnel permission without handlers", funnelOnly: true },
    { name: "extra mount", extraMount: true },
    { name: "foreground session", foreground: true },
    { name: "TCP forward", tcp: true },
    { name: "unix socket", proxy: "unix:/synthetic/app.sock" },
    { name: "Text root", root: { Text: "other app" } },
    { name: "Path root", root: { Path: "/synthetic/site" } },
    { name: "proxy with an extra key", root: { Proxy: oldProxy, FutureHandler: true } },
    { name: "second hostname", secondHost: true },
    { name: "insecure HTTPS proxy", proxy: "https+insecure://127.0.0.1:39831" },
    { name: "localhost proxy", proxy: "http://localhost:39831" },
    { name: "bare-port proxy", proxy: "39831" },
    { name: "path-suffixed proxy", proxy: "http://127.0.0.1:39831/app" },
    { name: "nonlocal backend", proxy: "http://192.0.2.1:39831" },
    { name: "unknown top-level field", topUnknown: true },
    { name: "unknown TCP field", tcpUnknown: true },
    { name: "unknown web-site field", webUnknown: true },
    { name: "live backend", probe: "connect" },
    { name: "timeout", probe: "timeout" },
    { name: "permission failure", probe: "EACCES" },
    { name: "unknown probe failure", probe: "UNKNOWN" },
    { name: "synchronous probe failure", probe: "throw" },
  ])("refuses $name even after repeated checks", (row) =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      if (!row.unrecorded) {
        yield* ensureTailscaleServe({
          localPort: 39831,
          servePort: 8443,
          reclaimDeadHandler: !row.persistent,
        }).pipe(Effect.provide(fixture.layer));
      }
      const config = serveConfig(8443, row.proxy ?? oldProxy);
      fixture.setStatus({
        ...(row.funnelOnly ? {} : config),
        ...(row.funnel || row.funnelOnly
          ? { AllowFunnel: { "desktop.tail.ts.net:8443": true } }
          : {}),
        ...(row.topUnknown ? { FutureRoutingMode: "protected" } : {}),
        ...(row.tcp || row.tcpUnknown
          ? {
              TCP: {
                8443: {
                  HTTPS: true,
                  ...(row.tcp
                    ? { TCPForward: "127.0.0.1:39831" }
                    : { FutureRoutingMode: "protected" }),
                },
              },
            }
          : {}),
        ...(row.funnelOnly
          ? {}
          : {
              Web: {
                ...config.Web,
                "desktop.tail.ts.net:8443": {
                  ...(row.webUnknown ? { FutureRoutingMode: "protected" } : {}),
                  Handlers: {
                    "/": row.root ?? { Proxy: row.proxy ?? oldProxy },
                    ...(row.extraMount ? { "/api": { Text: "other app" } } : {}),
                  },
                },
                ...(row.secondHost
                  ? { "other.example.ts.net:8443": { Handlers: { "/": { Proxy: oldProxy } } } }
                  : {}),
              },
            }),
        ...(row.foreground ? { Foreground: { session: config } } : {}),
      });
      using _probe = vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (
        this: NodeNet.Socket,
      ) {
        if (row.probe === "throw") throw new Error("synthetic probe failure");
        const event = row.probe === "connect" || row.probe === "timeout" ? row.probe : "error";
        queueMicrotask(() =>
          this.emit(
            event,
            Object.assign(new Error("synthetic failure"), { code: row.probe ?? "ECONNREFUSED" }),
          ),
        );
        return this;
      });
      const before = fixture.writes.length;
      yield* ensureTailscaleServe({
        ...serverRoute,
        previousDeadProxy: row.proxy ?? oldProxy,
      }).pipe(Effect.result, Effect.provide(fixture.layer));
      yield* ensureTailscaleServe({
        ...serverRoute,
        previousDeadProxy: row.proxy ?? oldProxy,
      }).pipe(Effect.result, Effect.provide(fixture.layer));
      assert.equal(fixture.writes.length, before);
    }),
  );

  it.effect("reclaims only the recorded root after two consecutive refusals", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      using _probe = refusalProbe();
      const first = yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
      assert.equal(first, oldProxy);
      assert.equal(fixture.writes.length, 1, "one refusal must not write");
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: first }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, [
        ["serve", "--bg", "--https=8443", oldProxy],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    }),
  );

  it.effect.each(["removed", "replaced", "protected", "clean shutdown", "pairing observation"])(
    "forgets ownership after a %s mapping",
    (change) =>
      Effect.gen(function* () {
        const fixture = serveFixture();
        yield* ensureTailscaleServe({
          localPort: 39831,
          servePort: 8443,
          reclaimDeadHandler: true,
        }).pipe(Effect.provide(fixture.layer));
        if (change === "clean shutdown") {
          yield* disableTailscaleServe({ localPort: 39831, servePort: 8443 }).pipe(
            Effect.provide(fixture.layer),
          );
        } else {
          fixture.setStatus(
            change === "removed"
              ? null
              : change === "replaced" || change === "pairing observation"
                ? serveConfig(8443, "http://127.0.0.1:39832")
                : { ...serveConfig(8443, oldProxy), FutureRoutingMode: "protected" },
          );
          yield* (
            change === "pairing observation"
              ? hasExactTailscaleServe({ servePort: 8443, proxy: oldProxy }).pipe(Effect.asVoid)
              : ensureTailscaleServe({ ...serverRoute, repairOnly: true }).pipe(Effect.asVoid)
          ).pipe(Effect.result, Effect.provide(fixture.layer));
        }
        fixture.setStatus(serveConfig(8443, oldProxy));
        using _probe = refusalProbe();
        const before = fixture.writes.length;
        yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
          Effect.result,
          Effect.provide(fixture.layer),
        );
        assert.equal(
          fixture.writes.length,
          before,
          "a reused local port must not restore an old authorization",
        );
      }),
  );

  it.effect("replaces the record on takeover rather than retaining previous targets", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      using _probe = refusalProbe();
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
        Effect.provide(fixture.layer),
      );
      fixture.setStatus(serveConfig(8443, oldProxy));
      const before = fixture.writes.length;
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.equal(fixture.writes.length, before);
    }),
  );

  it.effect(
    "the repair loop waits for a second refused tick and resets after an uncertain probe",
    () =>
      Effect.gen(function* () {
        const fixture = serveFixture();
        yield* ensureTailscaleServe({
          localPort: 39831,
          servePort: 8443,
          reclaimDeadHandler: true,
        }).pipe(Effect.provide(fixture.layer));
        const probes = yield* Deferred.make<void>();
        let count = 0;
        using _probe = vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (
          this: NodeNet.Socket,
        ) {
          queueMicrotask(() => {
            count += 1;
            this.emit(
              count === 2 ? "timeout" : "error",
              Object.assign(new Error("synthetic refusal"), { code: "ECONNREFUSED" }),
            );
            Deferred.doneUnsafe(probes, Effect.void);
          });
          return this;
        });
        yield* repairTailscaleServe({
          localPort: 13773,
          localHost: "127.0.0.1",
          servePort: 8443,
        }).pipe(Effect.provide(fixture.layer), Effect.forkScoped);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(probes);
        assert.equal(fixture.writes.length, 1);
        yield* TestClock.adjust("30 seconds");
        assert.equal(fixture.writes.length, 1);
        yield* TestClock.adjust("30 seconds");
        assert.equal(fixture.writes.length, 1);
        yield* TestClock.adjust("30 seconds");
        assert.equal(fixture.writes.length, 2);
      }),
  );

  it.effect(
    "pairing an existing recorded route keeps it persistent through automatic shutdown",
    () =>
      Effect.gen(function* () {
        const fixture = serveFixture();
        yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
        yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.provide(fixture.layer),
        );
        const removed = yield* disableTailscaleServe({
          localPort: 13773,
          servePort: 8443,
          recordedOnly: true,
        }).pipe(Effect.provide(fixture.layer));
        assert.isFalse(removed);
        assert.equal(fixture.writes.length, 1);
        using _probe = refusalProbe();
        yield* ensureTailscaleServe({
          localPort: 13774,
          servePort: 8443,
          reclaimDeadHandler: true,
          previousDeadProxy: "http://127.0.0.1:13773",
        }).pipe(Effect.result, Effect.provide(fixture.layer));
        assert.equal(fixture.writes.length, 1);
      }),
  );

  it.effect.each(["win32", "darwin", "linux"] as const)(
    "stores one bounded ownership record in the %s account state directory",
    (platform) =>
      Effect.gen(function* () {
        const home = yield* HostProcess.HomeDirectory;
        const base =
          platform === "win32"
            ? NodePath.join(home, "local-data")
            : platform === "darwin"
              ? NodePath.join(home, "Library", "Application Support")
              : NodePath.join(home, "state-data");
        const fixture = serveFixture();
        yield* ensureTailscaleServe(serverRoute).pipe(
          Effect.provide(fixture.layer),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, {
            LOCALAPPDATA: base,
            XDG_STATE_HOME: base,
          }),
        );
        const db = new NodeSqlite.DatabaseSync(
          NodePath.join(base, "styal", "tailscale-serve-8443.sqlite"),
        );
        try {
          assert.deepEqual(
            db
              .prepare("SELECT proxy, managed FROM ownership")
              .all()
              .map((row) => ({ ...row })),
            [{ proxy: "http://127.0.0.1:13773", managed: 1 }],
          );
        } finally {
          db.close();
        }
      }),
  );

  it.effect.each(["directory", "open"] as const)(
    "reports a %s storage failure without claiming another app owns the port",
    (stage) =>
      Effect.gen(function* () {
        const home = yield* HostProcess.HomeDirectory;
        const directory = NodePath.join(home, ".local", "state", "styal");
        if (stage === "directory") {
          NodeFS.mkdirSync(NodePath.dirname(directory), { recursive: true });
          NodeFS.writeFileSync(directory, "blocked directory");
        } else {
          NodeFS.mkdirSync(NodePath.join(directory, "tailscale-serve-8443.sqlite"), {
            recursive: true,
          });
        }
        const fixture = serveFixture();
        const error = yield* ensureTailscaleServe(serverRoute).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
        );
        assert.instanceOf(error, TailscaleServeRecordError);
        assert.equal(error.stage, stage);
        assert.include(error.message, "permissions");
        assert.equal(fixture.writes.length, 0);
      }),
  );

  it.effect("serializes record changes and distinguishes lock contention across processes", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      const home = yield* HostProcess.HomeDirectory;
      const path = NodePath.join(
        home,
        ".local",
        "state",
        "styal",
        "tailscale-serve-8443.sqlite.lock",
      );
      const db = new NodeSqlite.DatabaseSync(path);
      try {
        db.exec("BEGIN EXCLUSIVE");
        const error = yield* ensureTailscaleServe(serverRoute).pipe(
          Effect.flip,
          Effect.provide(fixture.layer),
        );
        assert.instanceOf(error, TailscaleServeRecoveryBusyError);
        const peer = NodeChildProcess.spawnSync(process.execPath, [
          "--input-type=module",
          "-e",
          `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1]);
        try { db.exec("BEGIN EXCLUSIVE"); process.exitCode = 1; }
        catch (error) { process.exitCode = error.errcode === 5 ? 0 : 2; }
        finally { db.close(); }
      `,
          path,
        ]);
        assert.equal(peer.status, 0);
        assert.equal(fixture.writes.length, 1);
      } finally {
        db.close();
      }
      using _probe = refusalProbe();
      const first = yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: first }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.equal(fixture.writes.length, 2);
    }),
  );

  it.effect("keeps ownership across temporary status-command failures", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      yield* ensureTailscaleServe(serverRoute).pipe(
        Effect.result,
        Effect.provide(layerMockSpawner(() => ({ code: 1, stderr: "daemon not running" }))),
      );
      using _probe = refusalProbe();
      const first = yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: first }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.equal(fixture.writes.length, 2);
    }),
  );

  it.effect("a stale shutdown cannot erase the successor's ownership", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      using _probe = refusalProbe();
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
        Effect.provide(fixture.layer),
      );
      yield* disableTailscaleServe({ localPort: 39831, servePort: 8443, recordedOnly: true }).pipe(
        Effect.flip,
        Effect.provide(fixture.layer),
      );
      const first = yield* ensureTailscaleServe({ ...serverRoute, localPort: 13774 }).pipe(
        Effect.provide(fixture.layer),
      );
      yield* ensureTailscaleServe({
        ...serverRoute,
        localPort: 13774,
        previousDeadProxy: first,
      }).pipe(Effect.provide(fixture.layer));
      assert.equal(fixture.writes.length, 3);
    }),
  );

  it.effect(
    "automatic shutdown reconciles a changed proxy before skipping an unrecorded mapping",
    () =>
      Effect.gen(function* () {
        const fixture = serveFixture();
        yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
        fixture.setStatus(serveConfig(8443, oldProxy));
        assert.isFalse(
          yield* disableTailscaleServe({
            localPort: 39831,
            servePort: 8443,
            recordedOnly: true,
          }).pipe(Effect.provide(fixture.layer)),
        );
        fixture.setStatus(serveConfig(8443, "http://127.0.0.1:13773"));
        using _probe = refusalProbe();
        yield* ensureTailscaleServe({
          ...serverRoute,
          localPort: 13774,
          previousDeadProxy: "http://127.0.0.1:13773",
        }).pipe(Effect.result, Effect.provide(fixture.layer));
        assert.equal(fixture.writes.length, 1);
      }),
  );

  it.effect("does not inspect other ports or Tailscale Services", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      const config = serveConfig(8443, oldProxy);
      fixture.setStatus({
        ...config,
        TCP: { ...config.TCP, 80: { HTTP: true, FutureRoutingMode: "protected" } },
        Web: { ...config.Web, "other.example.ts.net:80": { FutureRoutingMode: "protected" } },
        AllowFunnel: { "other.example.ts.net:443": true },
        Services: { "svc:other": { FutureServiceMode: "protected" } },
      });
      using _probe = refusalProbe();
      const first = yield* ensureTailscaleServe(serverRoute).pipe(Effect.provide(fixture.layer));
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: first }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.equal(fixture.writes.length, 2);
    }),
  );

  it.effect("cleans up its recorded non-loopback mapping without making it recoverable", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      const route = { ...serverRoute, localHost: "192.0.2.8" };
      yield* ensureTailscaleServe(route).pipe(Effect.provide(fixture.layer));
      using _probe = refusalProbe();
      yield* ensureTailscaleServe({
        ...serverRoute,
        previousDeadProxy: "http://192.0.2.8:13773",
      }).pipe(Effect.result, Effect.provide(fixture.layer));
      assert.equal(fixture.writes.length, 1);
      assert.isTrue(
        yield* disableTailscaleServe({ ...route, recordedOnly: true }).pipe(
          Effect.provide(fixture.layer),
        ),
      );
      assert.equal(fixture.writes.length, 2);
    }),
  );

  it.effect("invalidates ownership durably before a daemon write even if that command fails", () =>
    Effect.gen(function* () {
      const fixture = serveFixture();
      yield* ensureTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        reclaimDeadHandler: true,
      }).pipe(Effect.provide(fixture.layer));
      const home = yield* HostProcess.HomeDirectory;
      const path = NodePath.join(home, ".local", "state", "styal", "tailscale-serve-8443.sqlite");
      const failing = layerMockSpawner((_command, args) => {
        if (args[1] === "status") return { stdout: serveStatusJson(8443, oldProxy) };
        const reader = new NodeSqlite.DatabaseSync(path, { readOnly: true });
        try {
          assert.deepEqual(reader.prepare("SELECT proxy FROM ownership").all(), []);
        } finally {
          reader.close();
        }
        return { code: 1, stderr: "synthetic write failure" };
      });
      using _probe = refusalProbe();
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
        Effect.result,
        Effect.provide(failing),
      );
      yield* ensureTailscaleServe({ ...serverRoute, previousDeadProxy: oldProxy }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.equal(fixture.writes.length, 1);
    }),
  );

  it.effect(
    "does not record a server mapping when the CLI reports success without installing it",
    () =>
      Effect.gen(function* () {
        const fixture = serveFixture();
        const noOp = layerMockSpawner((_command, args) =>
          args[1] === "status" ? { stdout: "null" } : {},
        );
        const error = yield* ensureTailscaleServe(serverRoute).pipe(
          Effect.flip,
          Effect.provide(noOp),
        );
        assert.equal(error._tag, "TailscaleServeNotConfiguredError");
        fixture.setStatus(serveConfig(8443, "http://127.0.0.1:13773"));
        using _probe = refusalProbe();
        yield* ensureTailscaleServe({
          ...serverRoute,
          localPort: 13774,
          previousDeadProxy: "http://127.0.0.1:13773",
        }).pipe(Effect.result, Effect.provide(fixture.layer));
        assert.equal(fixture.writes.length, 0);
      }),
  );

  it.effect("replaces a handler only when its environment was already verified", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({
        localPort: 5733,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.provide(layer));
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:5733"],
      ]);
    });
  });

  it.effect("does not replace a complex handler after an environment probe", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      const status = JSON.parse(serveStatusJson(8443, "http://127.0.0.1:13773")) as {
        Web: Record<string, { Handlers: Record<string, unknown> }>;
      };
      const web = status.Web["desktop.tail.ts.net:8443"];
      assert.isDefined(web);
      web.Handlers["/api"] = { Proxy: "http://127.0.0.1:39831" };
      return { stdout: JSON.stringify(status) };
    });

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({
        localPort: 5733,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServePortOccupiedError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("treats a non-web listener on the selected port as occupied", () => {
    const layer = layerMockSpawner(() => ({
      stdout: JSON.stringify({ TCP: { 8443: { TCPForward: "127.0.0.1:39831" } }, Web: {} }),
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(error, TailscaleServePortOccupiedError);
    });
  });

  it.effect("refuses to reuse or disable a Funnel-enabled handler", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      const status = JSON.parse(serveStatusJson(8443, "http://127.0.0.1:13773")) as Record<
        string,
        unknown
      >;
      return {
        stdout: JSON.stringify({
          ...status,
          AllowFunnel: { "desktop.tail.ts.net:8443": true },
        }),
      };
    });

    return Effect.gen(function* () {
      const ensureError = yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(ensureError, TailscaleServePortOccupiedError);

      const disableError = yield* disableTailscaleServe({
        localPort: 13773,
        servePort: 8443,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(disableError, TailscaleServePortOccupiedError);
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("disables tailscale serve through the process spawner service", () => {
    const commands: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }[] = [];
    const layer = layerMockSpawner((command, args) => {
      commands.push({ command, args });
      assert.equal(command, "tailscale");
      if (args[1] === "status") {
        return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
      }
      return {};
    });

    return Effect.gen(function* () {
      yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "status", "--json"] },
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });

  it.effect("refuses to disable a handler owned by another service", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = layerMockSpawner((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:39831") };
    });

    return Effect.gen(function* () {
      const error = yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.equal(error._tag, "TailscaleServePortOccupiedError");
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  // regression: #34736 - a full stdout pipe blocks the child before it exits.
  it.effect("drains serve stdout so a long success summary does not time out", () =>
    Effect.gen(function* () {
      const stdoutDrained = yield* Deferred.make<void>();
      const layer = layerSpawner(
        ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as { readonly args: ReadonlyArray<string> };
          if (childProcess.args.includes("status")) {
            return Effect.succeed(mockHandle({ stdout: "null" }));
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Deferred.await(stdoutDrained).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(encoder.encode("https://example.ts.net/\n")).pipe(
                Stream.ensuring(Deferred.succeed(stdoutDrained, undefined)),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        }),
      );

      const fiber = yield* ensureTailscaleServe({ localPort: 3773 }).pipe(
        Effect.provide(layer),
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust("11 seconds");
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isSuccess(exit), String(exit));
    }),
  );

  // regression: #21609 - without forceKillAfter a timed-out probe only gets
  // SIGTERM, so a group member that ignores it outlives the call.
  it.effect("escalates timed-out probes to SIGKILL", () => {
    const killGraces: Array<number | undefined> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const { forceKillAfter } = command.options;
          killGraces.push(
            forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter)),
          );
        }
        return Effect.succeed(mockHandle({ stdout: "{}" }));
      }),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.provide(layer));
      yield* readTailscaleSshEnabled.pipe(Effect.provide(layer));
      yield* ensureTailscaleServe({ localPort: 45_678 }).pipe(Effect.provide(layer));
      assert.deepEqual(killGraces, [500, 500, 500, 500]);
    });
  });
});
