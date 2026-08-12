// @effect-diagnostics nodeBuiltinImport:off - Integration exercises the generated Node browser helper.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as TerminalBrowserOpen from "./TerminalBrowserOpen.ts";

function listenOnRandomPort(server: NodeHttp.Server | NodeNet.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP test server"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: NodeHttp.Server | NodeNet.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

it.layer(NodeServices.layer)("TerminalBrowserOpen", (it) => {
  it.effect("installs the helper and rotates terminal-scoped credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-terminal-browser-open-",
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
      const { browserOpen, broker, config } = yield* Effect.gen(function* () {
        const broker = yield* PreviewAutomationBroker.make;
        return {
          browserOpen: yield* TerminalBrowserOpen.make.pipe(
            Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          ),
          broker,
          config: yield* ServerConfig.ServerConfig,
        };
      }).pipe(Effect.provide(configLayer));
      const owner = {
        threadId: ThreadId.make("thread-1"),
        terminalId: "default",
      };

      const first = yield* browserOpen.register(owner);
      const firstToken = first[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_TOKEN_ENV];
      expect(first.BROWSER).toMatch(/terminal-browser-open\.js$/u);
      expect(first[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV]).toBe(
        config.serverRuntimeStatePath,
      );
      expect(firstToken).toBeTypeOf("string");
      expect(yield* browserOpen.resolve(firstToken ?? "")).toEqual(owner);
      expect(yield* fileSystem.readFileString(first.BROWSER ?? "")).toBe(
        TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_HELPER_SOURCE,
      );
      const shimDir = first[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV];
      expect(shimDir).toBeTypeOf("string");
      expect(yield* fileSystem.readFileString(NodePath.join(shimDir ?? "", "open"))).toBe(
        TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_HELPER_SOURCE,
      );
      expect(yield* fileSystem.readFileString(NodePath.join(shimDir ?? "", "xdg-open"))).toBe(
        TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_HELPER_SOURCE,
      );

      const second = yield* browserOpen.register(owner);
      const secondToken = second[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_TOKEN_ENV];
      expect(secondToken).not.toBe(firstToken);
      expect(yield* browserOpen.resolve(firstToken ?? "")).toBeUndefined();
      expect(yield* browserOpen.resolve(secondToken ?? "")).toEqual(owner);

      let routedRequest: PreviewAutomationRequest | undefined;
      const events = yield* broker.connect({
        clientId: "desktop-1",
        environmentId: EnvironmentId.make("environment-1"),
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequest = event.request;
        return broker.respond({
          clientId: "desktop-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { available: true },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      yield* browserOpen.openInPreview({
        environmentId: EnvironmentId.make("environment-1"),
        owner,
        url: "http://localhost:5173/app",
      });
      expect(routedRequest).toMatchObject({
        threadId: "thread-1",
        operation: "open",
        input: { url: "http://localhost:5173/app", reuseExistingTab: false },
        presentation: "right-panel",
      });

      yield* browserOpen.unregister(owner);
      expect(yield* browserOpen.resolve(secondToken ?? "")).toBeUndefined();
    }),
  );
});

it("posts browser intent through the generated OS launcher shim", async () => {
  const tempDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-terminal-browser-helper-"),
  );
  const server = NodeHttp.createServer();
  try {
    const receivedRequest = new Promise<{
      readonly authorization: string | undefined;
      readonly body: string;
      readonly url: string | undefined;
    }>((resolve) => {
      server.once("request", (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          resolve({
            authorization: request.headers.authorization,
            body: Buffer.concat(chunks).toString("utf8"),
            url: request.url,
          });
          response.writeHead(204).end();
        });
      });
    });
    const serverPort = await listenOnRandomPort(server);

    const helperPath = NodePath.join(tempDir, "open");
    const runtimeStatePath = NodePath.join(tempDir, "server-runtime.json");
    await NodeFSP.writeFile(helperPath, TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_HELPER_SOURCE);
    await NodeFSP.writeFile(
      runtimeStatePath,
      JSON.stringify({ origin: `http://127.0.0.1:${serverPort}` }),
    );
    const targetUrl = "http://localhost:5173/app?mode=test";
    const child = NodeChildProcess.spawn(process.execPath, [helperPath, targetUrl], {
      env: {
        ...process.env,
        [TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV]: runtimeStatePath,
        [TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_TOKEN_ENV]: "terminal-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    expect(exitCode, stderr).toBe(0);
    expect(await receivedRequest).toEqual({
      authorization: "Bearer terminal-token",
      body: JSON.stringify({ url: targetUrl }),
      url: TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_PATH,
    });
  } finally {
    await closeServer(server);
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
});

it("captures a real Vite+ --open launch through the OS shim", async () => {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-vite-open-helper-"));
  const callbackServer = NodeHttp.createServer();
  const portReservation = NodeNet.createServer();
  let child: NodeChildProcess.ChildProcess | undefined;
  try {
    const receivedRequest = new Promise<string>((resolve) => {
      callbackServer.once("request", (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
          response.writeHead(204).end();
        });
      });
    });
    const callbackPort = await listenOnRandomPort(callbackServer);
    const devPort = await listenOnRandomPort(portReservation);
    await closeServer(portReservation);

    const shimDir = NodePath.join(tempDir, "bin");
    const runtimeStatePath = NodePath.join(tempDir, "server-runtime.json");
    await NodeFSP.mkdir(shimDir);
    await Promise.all(
      ["open", "xdg-open"].map((launcher) =>
        NodeFSP.writeFile(
          NodePath.join(shimDir, launcher),
          TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_HELPER_SOURCE,
          { mode: 0o755 },
        ),
      ),
    );
    await NodeFSP.writeFile(NodePath.join(tempDir, "index.html"), "<title>Vite open test</title>");
    await NodeFSP.writeFile(
      runtimeStatePath,
      JSON.stringify({ origin: `http://127.0.0.1:${callbackPort}` }),
    );

    const childEnv = { ...process.env };
    delete childEnv.BROWSER;
    childEnv.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
    childEnv[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV] = runtimeStatePath;
    childEnv[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_TOKEN_ENV] = "terminal-token";
    childEnv[TerminalBrowserOpen.TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV] = shimDir;
    child = NodeChildProcess.spawn(
      "vp",
      ["dev", tempDir, "--host", "127.0.0.1", "--port", String(devPort), "--strictPort", "--open"],
      { detached: true, env: childEnv, stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<never>((_resolve, reject) => {
      child?.once("error", reject);
      child?.once("exit", (code, signal) => {
        reject(
          new Error(
            `Vite+ exited before opening Preview (${String(code)}, ${String(signal)}): ${stderr}`,
          ),
        );
      });
    });
    const requestBody = await Promise.race([receivedRequest, exited]);
    expect(JSON.parse(requestBody)).toEqual({ url: `http://127.0.0.1:${devPort}/` });
  } finally {
    if (child?.pid !== undefined) {
      const childExited =
        child.exitCode === null && child.signalCode === null
          ? new Promise<void>((resolve) => child?.once("exit", () => resolve()))
          : Promise.resolve();
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
      await childExited;
    }
    await closeServer(callbackServer);
    await closeServer(portReservation);
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}, 15_000);
