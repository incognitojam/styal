import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeUtil from "node:util";

import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";
import * as ProviderInstallGate from "./ProviderInstallGate.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  invalidateLatestProviderVersion,
  makeTargetedProviderUpdateAction,
  resolveLatestProviderUpdateAction,
  resolveLatestProviderVersion,
  type ProviderMaintenanceCommandAction,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ServerSettings from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import {
  startProviderUpdateRecording,
  updateCommandFailureReason,
  type ProviderUpdateFailureReason,
  type ProviderUpdateRecorder,
} from "../telemetry/ProviderAnalytics.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
// Every progress publish resends the provider list to each client, so the
// installer's output is sampled rather than forwarded line by line.
const UPDATE_PROGRESS_INTERVAL = Duration.seconds(1);
const UPDATE_PROGRESS_MAX_LENGTH = 200;
// An installer may write for minutes without a line ending; only its tail matters.
const UPDATE_PARTIAL_LINE_MAX_LENGTH = 4_096;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
          readonly targetVersion?: string | undefined;
          /**
           * Background update of `targetVersion`, which must be set and which
           * the installer must be able to pin. `shouldStart` runs inside the
           * machine-wide install lock, with turn starts on this CLI held, just
           * before the install; when it yields false, or another process holds
           * the lock, the update is dropped without publishing a state.
           * `takeover` reinstalls the installed version to turn off the
           * provider's own updater; it verifies only once that updater is off.
           */
          readonly autoUpdate?:
            | { readonly shouldStart: Effect.Effect<boolean>; readonly takeover?: boolean }
            | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("@styal/cli/provider/providerMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: NodeJS.ProcessEnv;
    readonly onProgress?: (line: string) => Effect.Effect<void>;
    /** Records the installer in the install lock, so it stays held if this server dies first. */
    readonly recordChildPid?: (pid: number) => Effect.Effect<void, Error>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // On Windows the update tools are batch shims (e.g. `npm` -> `npm.cmd`), which a bare
        // ChildProcess.spawn cannot launch (spawn npm ENOENT); resolveSpawnCommand finds the
        // real `.cmd` and routes it through the shell.
        const resolved = yield* resolveSpawnCommand(input.command, input.args);
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              shell: resolved.shell,
              ...(input.env ? { env: input.env, extendEnv: true } : {}),
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run update command ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        if (input.recordChildPid) {
          yield* input
            .recordChildPid(child.pid)
            .pipe(
              Effect.mapError(
                (cause) => new ProviderMaintenanceCommandError({ message: cause.message, cause }),
              ),
            );
        }

        const pendingProgress = yield* Ref.make<string | null>(null);
        const onProgress = input.onProgress;
        if (onProgress) {
          yield* Ref.getAndSet(pendingProgress, null).pipe(
            Effect.flatMap((line) => (line === null ? Effect.void : onProgress(line))),
            Effect.repeat(Schedule.spaced(UPDATE_PROGRESS_INTERVAL)),
            Effect.forkScoped,
          );
        }
        const trackProgress = <E>(stream: Stream.Stream<Uint8Array, E>) => {
          if (!onProgress) {
            return stream;
          }
          const decoder = new TextDecoder();
          let partialLine = "";
          return stream.pipe(
            Stream.tap((chunk) => {
              const split = splitOutputLines(partialLine, decoder.decode(chunk, { stream: true }));
              partialLine = split.partialLine;
              const line =
                toProgressLine(split.partialLine) ??
                split.lines.map(toProgressLine).findLast((value) => value !== null);
              return line ? Ref.set(pendingProgress, line) : Effect.void;
            }),
          );
        };

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: trackProgress(child.stdout),
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: trackProgress(child.stderr),
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Update command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

export function splitOutputLines(
  partialLine: string,
  text: string,
): { readonly lines: ReadonlyArray<string>; readonly partialLine: string } {
  const parts = (partialLine + text).split(/\r\n|\r|\n/);
  return { partialLine: (parts.pop() ?? "").slice(-UPDATE_PARTIAL_LINE_MAX_LENGTH), lines: parts };
}

export function toProgressLine(line: string): string | null {
  const text = NodeUtil.stripVTControlCharacters(line).replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length <= UPDATE_PROGRESS_MAX_LENGTH
    ? text
    : `${text.slice(0, UPDATE_PROGRESS_MAX_LENGTH - 1)}…`;
}

function describeCommand(command: ProviderMaintenanceCommandAction): string {
  const executable = command.executable.split(/[\\/]/).pop() || command.executable;
  // An installer run through a shell script reads as the command it stands for.
  if (executable === "sh" && command.args[0] === "-c") return command.command;
  return [executable, ...command.args].join(" ");
}

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function isStillInstalled(provider: ServerProvider): boolean {
  return provider.installed;
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const manifestService = yield* ModelManifest.ModelManifest;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
  const installGate = yield* ProviderInstallGate.ProviderInstallGate;
  const analytics = yield* AnalyticsService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const managedUpdatesOn = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.enableProviderUpdateChecks && settings.autoUpdateProviders),
    Effect.orElseSucceed(() => true),
  );
  const runMaintenanceCommand = (
    update: ProviderMaintenanceCommandAction,
    onProgress: (line: string) => Effect.Effect<void>,
    recordChildPid: (pid: number) => Effect.Effect<void, Error>,
  ) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command: update.executable,
      args: update.args,
      onProgress,
      recordChildPid,
      ...(update.env ? { env: update.env } : {}),
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.refreshAfterUpdate(provider, instanceId).pipe(
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            ),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map((verifiedProviders): VerifiedProviderRefresh => ({
            providers,
            verifiedProviders,
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetVersion = typeof target === "string" ? undefined : target.targetVersion;
    const autoUpdate = typeof target === "string" ? undefined : target.autoUpdate;
    const targetKey = `instance:${instanceId}`;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        // Set once an update starts: past `shouldStart`, or a manual update
        // refused by the install lock. Dropped background attempts record nothing.
        let recordFinished: ProviderUpdateRecorder | undefined;
        const startRecording = Effect.gen(function* () {
          if (recordFinished) return;
          recordFinished = yield* startProviderUpdateRecording(analytics, {
            source: autoUpdate ? "background" : "manual",
            takeover: autoUpdate?.takeover === true,
            provider,
            instanceId,
            capabilities,
            targetVersion,
            fromVersion: (yield* providerRegistry.getProviders).find(
              (candidate) => candidate.instanceId === instanceId,
            )?.version,
          });
        });
        const finish = (
          state: ServerProviderUpdateState,
          failureReason: ProviderUpdateFailureReason | null,
        ) =>
          setUpdateState(state).pipe(
            Effect.tap((providers) =>
              recordFinished ? recordFinished(state.status, failureReason, providers) : Effect.void,
            ),
            Effect.map((providers) => ({ providers })),
          );
        const startedAtRef = yield* Ref.make<string | null>(null);
        const dropped = setUpdateState(null).pipe(Effect.map((providers) => ({ providers })));

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* (recordChildPid: (pid: number) => Effect.Effect<void, Error>) {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            const setRunningMessage = (message: string) =>
              setUpdateState(
                makeUpdateState({
                  status: "running",
                  startedAt,
                  finishedAt: null,
                  message,
                }),
              ).pipe(Effect.asVoid);
            yield* setRunningMessage("Checking for the latest version");

            // The cached capabilities chose the lock; re-derive ownership
            // now so the command that runs matches the executable as it is
            // at click time, not as it was at the last health refresh.
            const fresh = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            if (!fresh.update || fresh.update.lockKey !== update.lockKey) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: "Provider installation changed. Refresh and try again.",
                }),
                "installation_changed",
              );
            }

            const manifest = yield* manifestService.current;
            // Check compatibility against what an unpinned command would install now.
            const candidateVersion =
              targetVersion ??
              (yield* invalidateLatestProviderVersion(fresh).pipe(
                Effect.andThen(resolveLatestProviderVersion(fresh)),
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(
                  ProviderLatestVersions.ProviderLatestVersions,
                  latestVersions,
                ),
              ));
            const advisory =
              resolveProviderCompatibility(manifest.compatibility, provider, candidateVersion) ??
              resolveProviderCompatibility(
                ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
                provider,
                candidateVersion,
              );
            const command =
              targetVersion !== undefined
                ? makeTargetedProviderUpdateAction(fresh, targetVersion)
                : resolveLatestProviderUpdateAction(fresh, candidateVersion);
            // Background updates were checked against the canary entries by
            // `shouldStart`; they only need an installer that pins the version.
            const rejected = autoUpdate
              ? targetVersion === undefined
              : targetVersion !== undefined
                ? !command ||
                  advisory?.recommendedVersion !== targetVersion ||
                  advisory.status !== "supported"
                : advisory?.status === "broken" || advisory?.status === "unsupported";
            if (rejected || !command) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: autoUpdate
                    ? "This installer cannot install a specific version."
                    : targetVersion !== undefined
                      ? "This version is no longer recommended or this installer cannot install a specific version. Refresh provider settings."
                      : "The latest provider version is incompatible with this styal release. Review provider settings.",
                }),
                "version_rejected",
              );
            }
            yield* setRunningMessage(`Running ${describeCommand(command)}`);
            const result = yield* runMaintenanceCommand(command, setRunningMessage, recordChildPid);
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              // A failed install can leave the provider broken; show its health now.
              yield* providerRegistry.refreshInstance(instanceId);
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(result),
                  output: commandOutput(result),
                }),
                updateCommandFailureReason(result),
              );
            }

            // A background install keeps the provider's own updater off; a
            // manual update with managed updates off hands it back.
            if (fresh.selfUpdater) {
              if (autoUpdate) yield* fresh.selfUpdater.turnOff;
              else if (!(yield* managedUpdatesOn)) yield* fresh.selfUpdater.handBack;
            }

            yield* setRunningMessage("Verifying the installed version");
            const verified = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
              instanceId,
              provider,
              { fresh: true },
            );
            yield* invalidateLatestProviderVersion(verified).pipe(
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            );
            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              verified,
              instanceId,
            );
            // "Succeeded" needs the provider to still be installed: an
            // installer that exits 0 and leaves the binary missing is not a
            // success. A missing version alone is not held against it, since
            // Cursor's `about` probe can fail transiently on a healthy binary.
            // A takeover only took effect once the provider's own updater is off.
            const couldNotVerify =
              verifiedProviders.length === 0 ||
              (autoUpdate?.takeover === true && verified.selfUpdaterActive !== false) ||
              verifiedProviders.some((verifiedProvider) => {
                const installedVersion =
                  verifiedProvider.installedVersion !== undefined
                    ? verifiedProvider.installedVersion
                    : verifiedProvider.version;
                return (
                  !isStillInstalled(verifiedProvider) ||
                  (verifiedProvider.status === "error" &&
                    (verifiedProvider.auth.status !== "unauthenticated" ||
                      !verifiedProvider.version)) ||
                  (targetVersion !== undefined &&
                    installedVersion?.replace(/^v/, "") !== targetVersion)
                );
              });
            // npm exits 0 when an optional platform package fails to download,
            // leaving a launcher that cannot start. The probe error says why.
            const brokenProvider = verifiedProviders.find(
              (verifiedProvider) =>
                verifiedProvider.status === "error" &&
                (verifiedProvider.auth.status !== "unauthenticated" || !verifiedProvider.version),
            );
            const stillOutdated =
              targetVersion === undefined &&
              verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
            return yield* finish(
              makeUpdateState({
                status:
                  couldNotVerify || brokenProvider || stillOutdated ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: brokenProvider
                  ? `Update command completed, but the provider reports an error: ${
                      brokenProvider.message ?? "unknown error"
                    }`
                  : couldNotVerify
                    ? "Update command completed, but styal could not verify the provider version."
                    : stillOutdated
                      ? "Update command completed, but styal still detects an outdated provider version."
                      : "Provider updated.",
                output: commandOutput(result),
              }),
              // No snapshot to check, such as when the post-update refresh
              // failed, counts as could-not-verify rather than not installed.
              verifiedProviders.some((verifiedProvider) => !isStillInstalled(verifiedProvider))
                ? "not_installed_after_install"
                : brokenProvider
                  ? "provider_error_after_install"
                  : couldNotVerify
                    ? "unchanged_after_install"
                    : stillOutdated
                      ? "unchanged_after_install"
                      : null,
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            // A manual update the user started always reports its failure.
            if (!autoUpdate) yield* startRecording;
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : "Update command failed.",
                output: null,
              }),
              Cause.hasInterruptsOnly(cause)
                ? "interrupted"
                : failure instanceof ProviderMaintenanceCommandError
                  ? "spawn_failed"
                  : "internal_error",
            );
          },
        );

        // Held until the installer exits: no other styal server runs this
        // installer meanwhile, and turn starts on this CLI wait for it.
        return yield* installGate
          .tryInstall(
            { lockKey: update.lockKey, packageName: capabilities.packageName },
            (recordChildPid) =>
              Effect.gen(function* () {
                // Checked here, so a manual update that finished while this one
                // was queued, another server's install, or a turn that started
                // meanwhile is seen.
                if (autoUpdate && !(yield* autoUpdate.shouldStart)) return yield* dropped;
                yield* startRecording;
                return yield* runCommandAndVerify(recordChildPid);
              }),
          )
          .pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  autoUpdate
                    ? Effect.logInfo("Background provider update skipped", {
                        instanceId,
                        reason: "another server on this machine is running this installer",
                      }).pipe(Effect.andThen(dropped))
                    : startRecording.pipe(
                        Effect.andThen(nowIso),
                        Effect.flatMap((finishedAt) =>
                          finish(
                            makeUpdateState({
                              status: "failed",
                              startedAt: null,
                              finishedAt,
                              message:
                                "Another update is running for this provider on this machine. Try again when it finishes.",
                            }),
                            "install_in_progress",
                          ),
                        ),
                      ),
              }),
            ),
            Effect.catchCause(recordFailedUpdate),
            Effect.onInterrupt(() =>
              recordFinished ? recordFinished("failed", "interrupted", []) : Effect.void,
            ),
          );
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());
