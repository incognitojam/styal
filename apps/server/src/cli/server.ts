import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

// The desktop launcher reads this process's stdout and stderr. Once it is gone,
// every log write fails, and Node turns an unhandled stream error into a crash
// that skips shutdown and leaves the ownership lock and runtime record behind.
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

const runServerCommand = Effect.fn("server.runServerCommand")(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) {
  // Before config resolution, which claims a port and creates directories.
  const { runServer } = yield* Effect.promise(() => import("../server.ts"));
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(flags, logLevel, options);
  const run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  if (config.mode !== "desktop" || config.desktopBootstrapToken === undefined) return yield* run;
  yield* Effect.sync(() => {
    process.stdout.on("error", ignoreClosedLauncherPipe);
    process.stderr.on("error", ignoreClosedLauncherPipe);
  });
  return yield* Effect.raceFirst(
    run,
    awaitLauncherLoss().pipe(
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
});

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withShortDescription("Run styal in this terminal and open it in your browser."),
  Command.withDescription(
    "Run styal in this terminal and open it in your browser. To use it from your other devices, run `styal up`.",
  ),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withShortDescription("Run styal in this terminal, with no browser."),
  Command.withDescription(
    "Run styal in this terminal without opening a browser, and print pairing details. The background service runs this. To set up access from your other devices, run `styal up`.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
