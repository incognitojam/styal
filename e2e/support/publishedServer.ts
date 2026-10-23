// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off - e2e harness runs plain Node outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hasTestFailed, markFailed } from "./failures.ts";
import { freePort, isolatedEnv, waitFor } from "./environment.ts";

export interface PublishedServer {
  /** Temporary directory holding the server's home, styal state, and log. */
  readonly root: string;
  readonly origin: string;
  /** One-time pairing URL printed at startup. */
  readonly pairingUrl: string;
  /** The version the service launcher runs now, from its state file. */
  readonly activeVersion: () => string;
  readonly serverLog: () => string;
  readonly stop: () => Promise<void>;
}

/**
 * Runs a published `@styal/cli` version the way an installed background service does: its
 * `__service-launcher` supervises the server, so the server offers in-app updates. The
 * launcher, its runtimes, and the server's state live in a temporary styal home, and no
 * system service is installed. Every provider is off.
 *
 * Needs the network: npm supplies the launcher package, and GitHub releases the runtime
 * archive for `version` and for any version an update installs.
 */
export async function startPublishedServer(version: string): Promise<PublishedServer> {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-e2e-published-"));
  const home = NodePath.join(root, "home");
  const bin = NodePath.join(root, "bin");
  const styalHome = NodePath.join(root, "styal");
  const serverLogPath = NodePath.join(root, "server.log");
  for (const directory of [home, bin, NodePath.join(styalHome, "userdata")]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  const env = { ...isolatedEnv(home, bin), STYAL_HOME: styalHome };

  // The launcher package downloads this version's runtime into the styal home.
  NodeChildProcess.execFileSync("npx", ["-y", `@styal/cli@${version}`, "--version"], {
    env,
    stdio: "ignore",
    timeout: 300_000,
  });
  const runtime = NodePath.join(styalHome, "runtime", "styal-executable", "versions", version);
  const statePath = NodePath.join(styalHome, "runtime", "service-state.json");
  // The launcher state format of the published versions under test (SERVICE_LAUNCHER_PROTOCOL).
  NodeFS.writeFileSync(statePath, JSON.stringify({ protocol: 4, activeVersion: version }));
  NodeFS.writeFileSync(
    NodePath.join(styalHome, "userdata", "settings.json"),
    JSON.stringify({
      enableProviderUpdateChecks: false,
      providers: {
        codex: { enabled: false },
        claudeAgent: { enabled: false },
        cursor: { enabled: false },
        grok: { enabled: false },
        opencode: { enabled: false },
        antigravity: { enabled: false },
      },
    }),
  );

  const port = await freePort();
  const serverLog = NodeFS.openSync(serverLogPath, "w");
  const launcher = NodeChildProcess.spawn(NodePath.join(runtime, "styal"), ["__service-launcher"], {
    env: { ...env, T3CODE_HOST: "127.0.0.1", T3CODE_PORT: String(port), T3CODE_NO_BROWSER: "1" },
    stdio: ["ignore", serverLog, serverLog],
  });
  const exited = new Promise<void>((resolve) => launcher.once("exit", () => resolve()));
  const readServerLog = () => NodeFS.readFileSync(serverLogPath, "utf8");

  const stop = async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      // The launcher stops its server before it exits.
      launcher.kill("SIGTERM");
      const killTimer = setTimeout(() => launcher.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(killTimer);
    }
    NodeFS.closeSync(serverLog);
    if (process.env.E2E_KEEP_STATE || hasTestFailed()) {
      process.stderr.write(`e2e state kept at ${root}\n`);
    } else {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  };

  let pairingUrl: string;
  try {
    pairingUrl = await waitFor("the published server's pairing URL", () => {
      if (launcher.exitCode !== null) throw new Error(`The launcher exited:\n${readServerLog()}`);
      return /(?:Pairing URL|pairingUrl): (\S+)/.exec(readServerLog())?.[1];
    });
  } catch (error) {
    markFailed();
    await stop();
    throw error;
  }

  return {
    root,
    origin: `http://127.0.0.1:${port}`,
    pairingUrl,
    activeVersion: () =>
      (JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as { activeVersion: string })
        .activeVersion,
    serverLog: readServerLog,
    stop,
  };
}
