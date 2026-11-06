import {
  ProviderSetupError,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import * as ProviderAuthFlow from "./providerAuthFlow.ts";
import * as ProviderAuthTerminal from "./providerAuthTerminal.ts";
import type { ServerProviderDraft } from "./snapshotProbe.ts";

const METHOD_ID = "cli";

/** Advertises the provider's CLI login, unless the instance signs in some other way. */
export const withCliLoginSetup =
  (
    stamp: (draft: ServerProviderDraft) => ServerProvider,
    usesOtherCredentials: (draft: ServerProviderDraft) => boolean = () => false,
  ) =>
  (draft: ServerProviderDraft): ServerProvider => {
    const stamped = stamp(draft);
    return {
      ...stamped,
      setup: {
        canInstall: stamped.setup?.canInstall ?? false,
        canAuthenticate: stamped.installed && !usesOtherCredentials(draft),
      },
      // The login belongs to the machine's CLI; other tools on the machine may rely on it.
      auth: { ...stamped.auth, canLogout: false },
    };
  };

/**
 * Sign-in for a provider whose own CLI owns the login: runs that CLI in the in-app terminal, on the
 * machine and under the environment that provider instance uses. Each machine keeps its own login.
 */
export const make = Effect.fn("ProviderCliLogin.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialKey: string;
  readonly command: Effect.Effect<{
    readonly binary: string;
    readonly args: ReadonlyArray<string>;
  }>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly hint?: string;
  readonly terminalSettle?: Effect.Effect<void>;
  /** Re-reads the provider's status; a login that left it signed out failed. */
  readonly refresh: Effect.Effect<ServerProvider>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.credentialKey },
    methods: Effect.succeed([
      { id: METHOD_ID, name: "Sign in", description: null, type: "terminal" as const },
    ]),
    defaultMethodId: METHOD_ID,
    stopSessionsAfterSignIn: true,
    authenticate: Effect.fnUntraced(function* (_methodId, context) {
      if (Option.isNone(pty))
        return yield* failure(
          "start",
          "Interactive provider login is unavailable on this environment.",
        );
      const { binary, args } = yield* options.command;
      yield* ProviderAuthTerminal.run({
        pty: pty.value,
        instanceId: options.instanceId,
        readPrompts: true,
        ...(options.terminalSettle === undefined ? {} : { settle: options.terminalSettle }),
        command:
          platform === "win32"
            ? (resolveExecutable(binary, platform, options.environment) ?? binary)
            : binary,
        args,
        cwd: options.cwd ?? home,
        env: { ...options.environment, TERM: options.environment.TERM ?? "xterm-256color" },
        context,
        failure,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
      });
      yield* context.verifying;
      const provider = yield* options.refresh;
      if (provider.auth.status === "unauthenticated")
        return yield* failure(
          "start",
          provider.message ?? "The provider still reports that it is signed out.",
        );
    }),
    logout: Effect.fail(
      failure("logout", "Sign out with the provider's own CLI on this environment."),
    ),
  });
});
