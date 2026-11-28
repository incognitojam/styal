// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Native descriptors and the child kill deadline belong to the standalone launcher boundary.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import { createRehearsalViewer } from "./rehearseViewer.ts";
import { rehearsalNetworkFilter } from "./rehearseNetwork.ts";
import * as NodeChildProcess from "node:child_process";
import { migrate } from "./migrate.ts";
import { assertOffline, PreflightRefusal } from "./preflight.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";

export async function rehearse(
  copy: string,
  runtime: {
    platform: NodeJS.Platform;
    architecture: string;
    chromiumExecutable?: string | undefined;
  },
) {
  const source = assertOffline(copy);
  const result = await Effect.runPromiseExit(migrate(source, true));
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  const report = result.value;
  if (report.mode !== "rehearsal")
    throw new PreflightRefusal({ category: "rehearsal-mode-required" });
  if (runtime.platform !== "linux")
    throw new PreflightRefusal({ category: "linux-bubblewrap-required" });
  const networkFilter = rehearsalNetworkFilter(runtime.architecture);
  const server = NodePath.resolve(import.meta.dirname, "../../..");
  const repo = NodePath.resolve(server, "../..");
  if (!NodeFS.existsSync(NodePath.join(server, "dist/client/index.html")))
    throw new PreflightRefusal({ category: "built-server-and-client-required" });
  // Fail closed before staging a potentially large runtime. No unsandboxed fallback.
  const probe = NodeChildProcess.spawnSync(
    "bwrap",
    [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--",
      "/bin/true",
    ],
    { stdio: ["ignore", "pipe", "inherit"], env: { PATH: "/usr/bin:/bin" } },
  );
  if (probe.status !== 0)
    throw new PreflightRefusal({ category: "bubblewrap-isolation-unavailable" });

  const requestedBrowser = runtime.chromiumExecutable;
  const browser = requestedBrowser && NodeFS.realpathSync(requestedBrowser);
  if (!browser || !NodeFS.statSync(browser).isFile())
    throw new PreflightRefusal({ category: "explicit-chromium-executable-required" });
  const directory = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(source), "styal-rehearsal-"));
  NodeFS.chmodSync(directory, 0o700);
  process.stdout.write(`Rehearsal directory: ${directory}\nLauncher PID: ${process.pid}\n`);
  const base = NodePath.join(directory, "base");
  NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
  for (const name of ["home", "tmp", "runtime/apps/server", "etc", "control"])
    NodeFS.mkdirSync(NodePath.join(directory, name), { recursive: true });
  const clone = (from: string, to: string) =>
    NodeFS.cpSync(from, NodePath.join(directory, to), {
      recursive: true,
      verbatimSymlinks: true,
      mode: NodeFS.constants.COPYFILE_FICLONE,
    });
  clone(NodePath.dirname(NodeFS.realpathSync(browser)), "chromium");
  clone(source, "base/userdata/statev2.sqlite");
  clone(NodePath.join(server, "dist"), "runtime/apps/server/dist");
  clone(NodePath.join(server, "node_modules"), "runtime/apps/server/node_modules");
  clone(NodePath.join(repo, "node_modules"), "runtime/node_modules");
  clone(NodePath.join(repo, "packages"), "runtime/packages");
  clone(NodeURL.fileURLToPath(new URL("./rehearseSandbox.mjs", import.meta.url)), "sandbox.mjs");
  NodeFS.writeFileSync(
    NodePath.join(directory, "etc/passwd"),
    `rehearsal:x:${process.getuid!()}:${process.getgid!()}:Rehearsal:/rehearsal/home:/bin/sh\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(directory, "etc/group"),
    `rehearsal:x:${process.getgid!()}:\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(base, "userdata/settings.json"),
    JSON.stringify({
      enableProviderUpdateChecks: false,
      continueThreadsAfterServerUpdate: false,
      keepAwakeWhileAgentsWork: false,
      defaultAutoPull: false,
      automaticGitFetchInterval: 0,
      backgroundActivity: { schemaVersion: 1, profile: "battery-saver", overrides: {} },
      storageCleanup: {
        worktreeAfterDays: null,
        worktreeSettledAfterDays: null,
        worktreeOnMerge: false,
        worktreeOnDelete: false,
        worktreeUnchanged: false,
        browserArtifactsAfterDays: null,
        logsAfterDays: null,
      },
    }),
  );
  const filterPath = NodePath.join(directory, "network.bpf");
  NodeFS.writeFileSync(filterPath, networkFilter, { mode: 0o600 });
  const sockets = new Set<NodeNet.Socket>();
  const channels: NodeNet.Socket[] = [];
  const waiting: ((stream: NodeNet.Socket) => void)[] = [];
  let stopping = false;
  const track = (stream: NodeNet.Socket) => {
    sockets.add(stream);
    stream.on("close", () => sockets.delete(stream));
    stream.on("error", () => stream.destroy());
  };
  const takeChannel = () =>
    new Promise<NodeNet.Socket>((resolve) => {
      let channel = channels.shift();
      while (channel?.destroyed) channel = channels.shift();
      if (channel) resolve(channel);
      else waiting.push(resolve);
    });
  // Bind using a short descriptor path, even when the snapshot's parent is long.
  const controlFd = NodeFS.openSync(NodePath.join(directory, "control"), "r");
  const transport = NodeNet.createServer((channel) => {
    track(channel);
    if (stopping) channel.end("S");
    else {
      const accept = waiting.shift();
      if (accept) accept(channel);
      else channels.push(channel);
    }
  });
  await new Promise<void>((resolve, reject) => {
    transport.once("error", reject);
    transport.listen(`/proc/self/fd/${controlFd}/s`, () => {
      transport.off("error", reject);
      resolve();
    });
  });
  const listener = createRehearsalViewer(async (path, body) => {
    const channel = await takeChannel();
    channel.write("H");
    const agent = new NodeHttp.Agent();
    agent.createConnection = () => channel;
    try {
      return await new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
        const request = NodeHttp.request(
          { agent, path, method: body === undefined ? "GET" : "POST" },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 16 * 1024 * 1024) response.destroy(new Error("frame-too-large"));
              else chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 503, bytes: Buffer.concat(chunks) }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    } finally {
      agent.destroy();
    }
  });
  listener.on("connection", track);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const address = listener.address();
  if (address === null || typeof address === "string")
    throw new Error("loopback-listener-required");
  const filterFd = NodeFS.openSync(filterPath, "r");
  const child = NodeChildProcess.spawn(
    "bwrap",
    [
      "--unshare-all",
      "--unshare-user",
      "--die-with-parent",
      "--new-session",
      "--hostname",
      "rehearsal",
      "--disable-userns",
      "--cap-drop",
      "ALL",
      "--seccomp",
      "3",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--ro-bind",
      process.execPath,
      "/node",
      "--bind",
      directory,
      "/rehearsal",
      "--ro-bind",
      NodePath.join(directory, "control"),
      "/rehearsal/control",
      "--ro-bind",
      NodePath.join(directory, "etc"),
      "/etc",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--symlink",
      "/rehearsal/tmp",
      "/tmp",
      "--remount-ro",
      "/",
      "--chdir",
      "/rehearsal",
      "--",
      "/node",
      "/rehearsal/sandbox.mjs",
      NodePath.basename(browser),
    ],
    {
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/rehearsal/home",
        TMPDIR: "/rehearsal/tmp",
        T3CODE_DEV_SEED: "0",
        T3CODE_TELEMETRY_ENABLED: "false",
        DO_NOT_TRACK: "1",
        T3CODE_ERROR_REPORTING_ENABLED: "false",
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        T3CODE_PORT_DISCOVERY: "0",
      },
      stdio: ["ignore", "pipe", "pipe", filterFd],
    },
  );
  NodeFS.closeSync(filterFd);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const channel of channels.splice(0)) channel.end("S");
    deadline = setTimeout(() => child.kill("SIGTERM"), 10_000);
    deadline.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.stdout!.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr!.on("data", (chunk) => process.stderr.write(chunk));
  process.stdout.write(
    `Loopback bridge: http://127.0.0.1:${address.port}\nSandbox PID: ${child.pid}\n`,
  );
  try {
    const { code, signal } = await exited;
    if (signal || code !== 0) throw new Error("rehearsal-server-failed");
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const stream of sockets) stream.destroy();
    listener.close();
    transport.close(() => NodeFS.closeSync(controlFd));
  }
}
