// @effect-diagnostics nodeBuiltinImport:off -- Recovery fixtures use disposable filesystem state and native socket/lock boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
  recoverTailscaleServe,
  repairTailscaleServe,
  TailscaleServeRecoveryError,
  disableTailscaleServeRoute,
  parseTailscaleServeRoutesTo,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  probeTailscaleHttpsEndpoint,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleServePortOccupiedError,
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
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
  );
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

const recoveryFixture = Effect.gen(function* () {
  const account = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "serve-snapshot-test-"))),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  );
  const home = NodePath.join(account, "server-home");
  NodeFS.mkdirSync(home);
  const receiptPath = NodePath.join(home, "tailscale-serve-recovery.json");
  const lockPath = NodePath.join(
    account,
    ".local",
    "state",
    "styal",
    "tailscale-serve-recovery.lock",
  );
  let status: Record<string, unknown> | null = null;
  let onWrite: (() => void) | undefined;
  let identity = {
    Self: { ID: "fixture-node", DNSName: "desktop.tail.ts.net." },
    CurrentTailnet: { StableID: "fixture-tailnet", Name: "fixture-network" },
  };
  const writes: ReadonlyArray<string>[] = [];
  const written = yield* Deferred.make<void>();
  const layer = Layer.mergeAll(
    layerMockSpawner((_command, args) => {
      if (args[0] === "status") return { stdout: JSON.stringify(identity) };
      if (args[1] === "status") return { stdout: JSON.stringify(status) };
      writes.push(args);
      onWrite?.();
      status = args.includes("off") ? null : { ...status, ...serveConfig(8443, args.at(-1)!) };
      if (writes.length > 1) Deferred.doneUnsafe(written, Effect.void);
      return {};
    }),
    Layer.succeed(HostProcess.HomeDirectory, account),
    Layer.succeed(HostProcess.Environment, {}),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer));
  const digest = () =>
    NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify({ status, identity, servePort: 8443 }, (_, value: unknown) =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, Reflect.get(value, key)]),
              )
            : value,
        ),
      )
      .digest("hex");
  const input = { home, localPort: 13773, servePort: 8443, localHost: "127.0.0.1" };
  return {
    home,
    receiptPath,
    lockPath,
    writes,
    written,
    input,
    provide,
    digest,
    onWrite: (hook: () => void) => {
      onWrite = hook;
    },
    setStatus: (next: Record<string, unknown> | null) => {
      status = next;
    },
    setIdentity: (next: typeof identity) => {
      identity = next;
    },
    matchReceipt: (owner = home) =>
      NodeFS.writeFileSync(receiptPath, JSON.stringify({ home: owner, digest: digest() })),
    seed: ensureTailscaleServe({ localPort: 39831, servePort: 8443, recoveryHome: home }).pipe(
      provide,
    ),
  };
});
const refusedProbe = () =>
  vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (this: NodeNet.Socket) {
    queueMicrotask(() =>
      this.emit("error", Object.assign(new Error("synthetic refusal"), { code: "ECONNREFUSED" })),
    );
    return this;
  });

describe("tailscale", () => {
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
  it.effect.each(["unwritable", "corrupt", "corrupt lock", "busy", "future fields"])(
    "ordinary Serve setup, reuse and removal ignore %s recovery state",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* recoveryFixture;
        let lock: NodeSqlite.DatabaseSync | undefined;
        if (mode === "unwritable") NodeFS.mkdirSync(f.receiptPath);
        if (mode === "corrupt") NodeFS.writeFileSync(f.receiptPath, "invalid receipt");
        if (mode === "corrupt lock") {
          NodeFS.mkdirSync(NodePath.dirname(f.lockPath), { recursive: true });
          NodeFS.writeFileSync(f.lockPath, "not SQLite");
        }
        if (mode === "busy") {
          NodeFS.mkdirSync(NodePath.dirname(f.lockPath), { recursive: true });
          lock = new NodeSqlite.DatabaseSync(f.lockPath);
          lock.exec("BEGIN EXCLUSIVE");
        }
        try {
          if (mode === "future fields") f.setStatus({ FutureRoutingMode: true });
          yield* f.seed;
          if (mode === "corrupt") NodeFS.writeFileSync(f.receiptPath, "invalid receipt");
          yield* ensureTailscaleServe({ localPort: 39831, servePort: 8443 }).pipe(f.provide);
          assert.equal(f.writes.length, 1);
          yield* disableTailscaleServe({
            localPort: 39831,
            servePort: 8443,
            recoveryHome: f.home,
          }).pipe(f.provide);
          f.setStatus(serveConfig(8443, "http://127.0.0.1:39831"));
          yield* disableTailscaleServeRoute({ servePort: 8443, mount: "/" }).pipe(f.provide);
          assert.equal(f.writes.length, 3);
        } finally {
          lock?.close();
        }
      }),
  );

  it.effect.each([
    [
      "unknown top-level field",
      { ...serveConfig(8443, "http://127.0.0.1:39831"), FutureRoutingMode: true },
    ],
    [
      "unknown TCP field",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        TCP: { 8443: { HTTPS: true, FutureRoutingMode: true } },
      },
    ],
    [
      "unknown website field",
      {
        TCP: { 8443: { HTTPS: true } },
        Web: {
          "desktop.tail.ts.net:8443": {
            FutureRoutingMode: true,
            Handlers: { "/": { Proxy: "http://127.0.0.1:39831" } },
          },
        },
      },
    ],
    [
      "unknown foreground field on another port",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        Foreground: { session: { TCP: { 443: { HTTPS: true, FutureRoutingMode: true } } } },
      },
    ],
    [
      "unknown Service field",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        Services: { "svc:future": { FutureRoutingMode: true } },
      },
    ],
    [
      "unknown field on another port",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        TCP: { 8443: { HTTPS: true }, 80: { HTTP: true, FutureRoutingMode: true } },
      },
    ],
    [
      "Funnel",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        AllowFunnel: { "desktop.tail.ts.net:8443": true },
      },
    ],
    [
      "extra mount",
      {
        TCP: { 8443: { HTTPS: true } },
        Web: {
          "desktop.tail.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:39831" }, "/api": { Text: "other" } },
          },
        },
      },
    ],
    [
      "foreground session",
      {
        ...serveConfig(8443, "http://127.0.0.1:39831"),
        Foreground: { session: serveConfig(8443, "http://127.0.0.1:39831") },
      },
    ],
    [
      "second hostname",
      {
        TCP: { 8443: { HTTPS: true } },
        Web: {
          ...serveConfig(8443, "http://127.0.0.1:39831").Web,
          "other.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:39831" } } },
        },
      },
    ],
    ...[
      "unix:/synthetic/app.sock",
      "https+insecure://127.0.0.1:39831",
      "http://localhost:39831",
      "39831",
      "http://127.0.0.1:39831/app",
      "http://127.0.0.1.:39831",
      "http://127.0.0.1]:39831",
    ].map((proxy) => [proxy, serveConfig(8443, proxy)] as const),
    ...[
      { Text: "other app" },
      { Path: "/synthetic/site" },
      { Proxy: "http://127.0.0.1:39831", AcceptAppCaps: ["example.test/cap"] },
    ].map(
      (root) =>
        [
          Object.keys(root).join("+"),
          {
            TCP: { 8443: { HTTPS: true } },
            Web: { "desktop.tail.ts.net:8443": { Handlers: { "/": root } } },
          },
        ] as const,
    ),
  ] as const)("refuses recovery for %s even with a matching receipt", ([, status]) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      f.setStatus(status);
      f.matchReceipt();
      using _probe = refusedProbe();
      const error = yield* recoverTailscaleServe({ ...f.input, previousDigest: f.digest() }).pipe(
        Effect.flip,
        f.provide,
      );
      assert.instanceOf(error, TailscaleServeRecoveryError);
      assert.include(
        ["configuration", "live"],
        error.reason,
        "shape validation must not be masked by receipt or lock failures",
      );
      assert.equal(f.writes.length, 0);
    }),
  );

  it.effect.each([
    "home",
    "machine",
    "profile",
    "other port",
    "service",
    "selected port",
    "unrecorded",
  ])("refuses recovery after a %s change", (change) =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      if (change === "unrecorded") f.setStatus(serveConfig(8443, "http://127.0.0.1:39831"));
      else yield* f.seed;
      const before = f.writes.length;
      if (change === "home") f.matchReceipt(NodePath.join(f.home, "different-home"));
      if (change === "machine" || change === "profile")
        f.setIdentity({
          Self: {
            ID: change === "profile" ? "other-node" : "fixture-node",
            DNSName: change === "machine" ? "renamed.example.ts.net." : "desktop.tail.ts.net.",
          },
          CurrentTailnet: { StableID: "fixture-tailnet", Name: "fixture-network" },
        });
      if (change === "selected port") {
        f.setStatus({
          TCP: { 8443: { HTTPS: true }, 9443: { HTTPS: true } },
          Web: {
            ...serveConfig(8443, "http://127.0.0.1:39831").Web,
            ...serveConfig(9443, "http://127.0.0.1:39832").Web,
          },
        });
        f.matchReceipt();
      }
      if (change === "other port")
        f.setStatus({
          ...serveConfig(8443, "http://127.0.0.1:39831"),
          AllowFunnel: { "desktop.tail.ts.net:443": true },
        });
      if (change === "service")
        f.setStatus({
          ...serveConfig(8443, "http://127.0.0.1:39831"),
          Services: { "svc:other": { Tun: true } },
        });

      using _probe = refusedProbe();
      yield* recoverTailscaleServe({
        ...f.input,
        ...(change === "selected port" ? { servePort: 9443 } : {}),
        previousDigest: f.digest(),
      }).pipe(Effect.result, f.provide);
      assert.equal(f.writes.length, before);
    }),
  );

  it.effect("clean removal of an exact legacy mapping needs no recovery receipt", () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      f.setStatus(serveConfig(8443, "http://127.0.0.1:39831"));
      yield* ensureTailscaleServe({ localPort: 39831, servePort: 8443, recoveryHome: f.home }).pipe(
        f.provide,
      );
      assert.isFalse(NodeFS.existsSync(f.receiptPath));
      yield* disableTailscaleServe({
        localPort: 39831,
        servePort: 8443,
        recoveryHome: f.home,
      }).pipe(f.provide);
      assert.deepEqual(f.writes, [["serve", "--https=8443", "off"]]);
      assert.isFalse(NodeFS.existsSync(f.receiptPath));
    }),
  );

  it.effect("startup only observes a refused backend; the next repair tick can take it back", () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      yield* f.seed;
      using _probe = refusedProbe();
      const previousDigest = yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        recoveryHome: f.home,
      }).pipe(f.provide);
      assert.equal(previousDigest, f.digest());
      assert.equal(f.writes.length, 1);
      yield* repairTailscaleServe({ ...f.input, previousDigest }).pipe(
        f.provide,
        Effect.forkScoped,
      );
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(f.written);
      assert.equal(f.writes.length, 2);
    }),
  );

  it.effect.each(["connect", "timeout", "EACCES", "UNKNOWN"])(
    "resets consecutive refusals on %s and awaits each milestone",
    (event) =>
      Effect.gen(function* () {
        const f = yield* recoveryFixture;
        yield* f.seed;
        const samples = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>());
        let count = 0;
        using _probe = vi.spyOn(NodeNet.Socket.prototype, "connect").mockImplementation(function (
          this: NodeNet.Socket,
        ) {
          queueMicrotask(() => {
            const index = count++;
            const kind = index === 1 ? event : "ECONNREFUSED";
            this.emit(
              kind === "connect" || kind === "timeout" ? kind : "error",
              Object.assign(new Error("synthetic probe"), { code: kind }),
            );
            Deferred.doneUnsafe(samples[index]!, Effect.void);
          });
          return this;
        });
        yield* repairTailscaleServe(f.input).pipe(f.provide, Effect.forkScoped);
        for (const [index, signal] of samples.entries()) {
          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(signal);
          if (index < 3) assert.equal(f.writes.length, 1);
        }
        yield* Deferred.await(f.written);
        assert.equal(f.writes.length, 2);
      }),
  );

  it.effect(
    "documents the indistinguishable case of an identically recreated complete configuration",
    () =>
      Effect.gen(function* () {
        const f = yield* recoveryFixture;
        yield* f.seed;
        f.setStatus(null);
        f.setStatus(serveConfig(8443, "http://127.0.0.1:39831"));
        using _probe = refusedProbe();
        const previousDigest = yield* ensureTailscaleServe({
          localPort: 13773,
          servePort: 8443,
          recoveryHome: f.home,
        }).pipe(f.provide);
        yield* recoverTailscaleServe({ ...f.input, previousDigest }).pipe(f.provide);
        assert.equal(f.writes.length, 2);
      }),
  );

  it.effect("canonicalizes key order without omitting emitted configuration fields", () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      yield* f.seed;
      const original = serveConfig(8443, "http://127.0.0.1:39831");
      f.setStatus({ Web: original.Web, TCP: original.TCP });
      using _probe = refusedProbe();
      const first = yield* recoverTailscaleServe(f.input).pipe(f.provide);
      if (typeof first !== "string") assert.fail("expected a pending refusal observation");
      yield* recoverTailscaleServe({ ...f.input, previousDigest: first }).pipe(f.provide);
      assert.equal(f.writes.length, 2);
    }),
  );
  it.effect("a shared recovery lock cannot be split by process state-directory overrides", () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      yield* f.seed;
      const lock = new NodeSqlite.DatabaseSync(f.lockPath);
      try {
        lock.exec("BEGIN EXCLUSIVE");
        const error = yield* recoverTailscaleServe({ ...f.input, previousDigest: f.digest() }).pipe(
          Effect.provideService(HostProcess.Environment, {
            XDG_STATE_HOME: NodePath.join(f.home, "different-state"),
          }),
          f.provide,
          Effect.flip,
        );
        assert.instanceOf(error, TailscaleServeRecoveryError);
        assert.equal(error.reason, "busy");
        assert.equal(f.writes.length, 1);
      } finally {
        lock.close();
      }
    }),
  );

  it.effect("startup falls back to ordinary setup if the conflicting mapping disappears", () =>
    Effect.gen(function* () {
      const f = yield* recoveryFixture;
      let reads = 0;
      const mutations: ReadonlyArray<string>[] = [];
      const disappearing = layerMockSpawner((_command, args) => {
        if (args[1] === "status")
          return {
            stdout: ++reads <= 2 ? serveStatusJson(8443, "http://127.0.0.1:39831") : "null",
          };
        if (args.includes("--bg")) mutations.push(args);
        return {};
      });
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443, recoveryHome: f.home }).pipe(
        Effect.provide(disappearing),
        f.provide,
      );
      assert.deepEqual(mutations, [["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]]);
    }),
  );

  it.effect(
    "a receipt failure after takeover warns with its path and preserves functional success",
    () =>
      Effect.gen(function* () {
        const f = yield* recoveryFixture;
        yield* f.seed;
        f.onWrite(() => {
          NodeFS.renameSync(f.receiptPath, `${f.receiptPath}.invalidated`);
          NodeFS.mkdirSync(f.receiptPath);
        });
        const warnings: string[] = [];
        using _probe = refusedProbe();
        yield* recoverTailscaleServe({ ...f.input, previousDigest: f.digest() }).pipe(
          f.provide,
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                if (options.logLevel === "Warn") warnings.push(JSON.stringify(options.message));
              }),
            ]),
          ),
        );
        assert.equal(f.writes.length, 2);
        assert.isTrue(warnings.some((message) => message.includes(f.receiptPath)));
      }),
  );
});
