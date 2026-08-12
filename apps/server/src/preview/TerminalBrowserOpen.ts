import {
  ProviderInstanceId,
  ThreadId,
  type EnvironmentId,
  type PreviewAutomationError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

export const TERMINAL_BROWSER_OPEN_PATH = "/api/internal/terminal-browser-open";
export const TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV = "T3CODE_TERMINAL_BROWSER_OPEN_RUNTIME_STATE";
export const TERMINAL_BROWSER_OPEN_TOKEN_ENV = "T3CODE_TERMINAL_BROWSER_OPEN_TOKEN";
export const TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV = "T3CODE_TERMINAL_BROWSER_OPEN_SHIM_DIR";

const HELPER_FILE_NAME = "terminal-browser-open.js";
const WINDOWS_HELPER_FILE_NAME = "terminal-browser-open.cmd";
const SHIM_DIRECTORY_NAME = "terminal-browser-open-bin";
const POSIX_LAUNCHER_NAMES = ["open", "xdg-open"] as const;

const WINDOWS_HELPER_SOURCE = `@echo off\r
node "%~dp0${HELPER_FILE_NAME}" %*\r
`;

export const TERMINAL_BROWSER_OPEN_HELPER_SOURCE = `#!/usr/bin/env node
void (async () => {
  const args = process.argv.slice(2);
  const reversedArgs = [...args].reverse();
  const httpUrl = reversedArgs.find((value) => /^https?:\\/\\//iu.test(value));
  const fallbackTarget = httpUrl ?? reversedArgs.find((value) => !value.startsWith("-"));
  if (!fallbackTarget) return;

  const invocationName = (process.argv[1] ?? "").split(/[\\\\/]/u).at(-1)?.toLowerCase();
  const interceptedLauncher = invocationName === "open" || invocationName === "xdg-open";
  const launcherHasOptions = interceptedLauncher && args.some((value) => value.startsWith("-"));

  const fallbackToSystemBrowser = async () => {
    const { spawn } = await import("node:child_process");
    const childEnv = { ...process.env };
    const shimDir = process.env.${TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV};
    const pathKey = Object.keys(childEnv).find((key) => key.toUpperCase() === "PATH");
    if (shimDir && pathKey && childEnv[pathKey]) {
      const delimiter = process.platform === "win32" ? ";" : ":";
      const normalizedShimDir = process.platform === "win32" ? shimDir.toLowerCase() : shimDir;
      childEnv[pathKey] = childEnv[pathKey]
        .split(delimiter)
        .filter((entry) => {
          const normalizedEntry = process.platform === "win32" ? entry.toLowerCase() : entry;
          return normalizedEntry !== normalizedShimDir;
        })
        .join(delimiter);
    }
    for (const key of Object.keys(childEnv)) {
      const normalized = key.toUpperCase();
      if (
        normalized === "BROWSER" ||
        normalized === "BROWSER_ARGS" ||
        normalized === "${TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV}" ||
        normalized === "${TERMINAL_BROWSER_OPEN_TOKEN_ENV}" ||
        normalized === "${TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV}"
      ) {
        delete childEnv[key];
      }
    }

    let command;
    let commandArgs;
    if (invocationName === "open") {
      command = "/usr/bin/open";
      commandArgs = args;
    } else if (invocationName === "xdg-open") {
      command = "xdg-open";
      commandArgs = args;
    } else if (process.platform === "darwin") {
      command = "/usr/bin/open";
      commandArgs = [fallbackTarget];
    } else if (process.platform === "win32") {
      const escapedTarget = fallbackTarget.replaceAll("'", "''");
      const encodedCommand = Buffer.from(
        "Start-Process '" + escapedTarget + "'",
        "utf16le",
      ).toString("base64");
      command = "powershell.exe";
      commandArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand];
    } else {
      command = "xdg-open";
      commandArgs = [fallbackTarget];
    }

    const child = spawn(command, commandArgs, {
      detached: true,
      env: childEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {
      process.stderr.write("Unable to open " + fallbackTarget + " in T3 Code or the system browser.\\n");
    });
    child.unref();
  };

  if (!httpUrl || launcherHasOptions) {
    await fallbackToSystemBrowser();
    return;
  }

  try {
    const runtimeStatePath = process.env.${TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV};
    const token = process.env.${TERMINAL_BROWSER_OPEN_TOKEN_ENV};
    if (!runtimeStatePath || !token) throw new Error("T3 browser-open environment is unavailable");

    const { readFile } = await import("node:fs/promises");
    const runtimeState = JSON.parse(await readFile(runtimeStatePath, "utf8"));
    const endpoint = new URL("${TERMINAL_BROWSER_OPEN_PATH}", runtimeState.origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 16_000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: httpUrl }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error("T3 browser-open request was rejected");
  } catch {
    await fallbackToSystemBrowser();
  }
})();
`;

export interface TerminalBrowserOpenOwner {
  readonly threadId: string;
  readonly terminalId: string;
}

export interface TerminalBrowserOpenPreviewInput {
  readonly environmentId: EnvironmentId;
  readonly owner: TerminalBrowserOpenOwner;
  readonly url: string;
}

interface TerminalBrowserOpenState {
  readonly ownersByToken: ReadonlyMap<string, TerminalBrowserOpenOwner>;
  readonly tokensByOwner: ReadonlyMap<string, string>;
}

const ownerKey = (owner: TerminalBrowserOpenOwner): string =>
  `${owner.threadId}\u0000${owner.terminalId}`;

export class TerminalBrowserOpen extends Context.Service<
  TerminalBrowserOpen,
  {
    readonly register: (owner: TerminalBrowserOpenOwner) => Effect.Effect<Record<string, string>>;
    readonly unregister: (owner: TerminalBrowserOpenOwner) => Effect.Effect<void>;
    readonly resolve: (token: string) => Effect.Effect<TerminalBrowserOpenOwner | undefined>;
    readonly openInPreview: (
      input: TerminalBrowserOpenPreviewInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("t3/preview/TerminalBrowserOpen") {}

export const make = Effect.gen(function* TerminalBrowserOpenMake() {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shimDir = path.join(config.stateDir, SHIM_DIRECTORY_NAME);
  const helperPath = path.join(shimDir, HELPER_FILE_NAME);
  const windowsHelperPath = path.join(shimDir, WINDOWS_HELPER_FILE_NAME);
  const executablePaths = [
    helperPath,
    ...POSIX_LAUNCHER_NAMES.map((name) => path.join(shimDir, name)),
  ];
  const helperAvailable = yield* Effect.forEach(
    executablePaths,
    (filePath) =>
      writeFileStringAtomically({
        filePath,
        contents: TERMINAL_BROWSER_OPEN_HELPER_SOURCE,
      }).pipe(
        Effect.andThen(
          fileSystem.chmod(filePath, 0o755).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      ),
    { discard: true },
  ).pipe(
    Effect.andThen(
      writeFileStringAtomically({
        filePath: windowsHelperPath,
        contents: WINDOWS_HELPER_SOURCE,
      }),
    ),
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to install terminal browser-open helper", {
        helperPath,
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
  const state = yield* SynchronizedRef.make<TerminalBrowserOpenState>({
    ownersByToken: new Map(),
    tokensByOwner: new Map(),
  });

  const unregister = Effect.fn("TerminalBrowserOpen.unregister")(function* (
    owner: TerminalBrowserOpenOwner,
  ) {
    yield* SynchronizedRef.update(state, (current) => {
      const key = ownerKey(owner);
      const token = current.tokensByOwner.get(key);
      if (!token) return current;
      const ownersByToken = new Map(current.ownersByToken);
      const tokensByOwner = new Map(current.tokensByOwner);
      ownersByToken.delete(token);
      tokensByOwner.delete(key);
      return { ownersByToken, tokensByOwner };
    });
  });

  const register = Effect.fn("TerminalBrowserOpen.register")(function* (
    owner: TerminalBrowserOpenOwner,
  ) {
    if (!helperAvailable) return {};
    const token = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* SynchronizedRef.update(state, (current) => {
      const key = ownerKey(owner);
      const previousToken = current.tokensByOwner.get(key);
      const ownersByToken = new Map(current.ownersByToken);
      const tokensByOwner = new Map(current.tokensByOwner);
      if (previousToken) ownersByToken.delete(previousToken);
      ownersByToken.set(token, owner);
      tokensByOwner.set(key, token);
      return { ownersByToken, tokensByOwner };
    });
    return {
      BROWSER: platform === "win32" ? windowsHelperPath : helperPath,
      [TERMINAL_BROWSER_OPEN_SHIM_DIR_ENV]: shimDir,
      [TERMINAL_BROWSER_OPEN_RUNTIME_STATE_ENV]: config.serverRuntimeStatePath,
      [TERMINAL_BROWSER_OPEN_TOKEN_ENV]: token,
    };
  });

  const resolve = Effect.fn("TerminalBrowserOpen.resolve")((token: string) =>
    SynchronizedRef.get(state).pipe(Effect.map((current) => current.ownersByToken.get(token))),
  );

  const openInPreview = Effect.fn("TerminalBrowserOpen.openInPreview")(function* (
    input: TerminalBrowserOpenPreviewInput,
  ) {
    const issuedAt = yield* Clock.currentTimeMillis;
    yield* broker.invoke({
      scope: {
        environmentId: input.environmentId,
        threadId: ThreadId.make(input.owner.threadId),
        providerSessionId: `terminal-browser:${input.owner.threadId}\u0000${input.owner.terminalId}`,
        providerInstanceId: ProviderInstanceId.make("t3_terminal"),
        capabilities: new Set(["preview"]),
        issuedAt,
      },
      operation: "open",
      input: { url: input.url, reuseExistingTab: false },
      timeoutMs: 15_000,
      presentation: "right-panel",
    });
  });

  return TerminalBrowserOpen.of({ register, unregister, resolve, openInPreview });
}).pipe(Effect.withSpan("TerminalBrowserOpen.make"));

export const layer = Layer.effect(TerminalBrowserOpen, make);
