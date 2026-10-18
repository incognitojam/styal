import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import { lock } from "proper-lockfile";
import { vi } from "vite-plus/test";

import * as CliSession from "../cloud/CliSession.ts";
import { withChatGptSessionLock } from "../provider/CodexChatGptSessionLock.ts";
import { SecretStoreLockError, withSecretStoreLock } from "./SecretStoreLock.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

// Simulate the library's final acquisition failure without spending its 40-second retry budget.
vi.mock("proper-lockfile", () => ({ lock: vi.fn() }));

const instanceId = ProviderInstanceId.make("lock-error-test");

it.effect.each(["ELOCKED", "EACCES"])("classifies final acquisition failure %s", (code) =>
  Effect.gen(function* () {
    vi.mocked(lock).mockRejectedValue(
      Object.assign(new Error("Lease acquisition failed"), { code }),
    );
    const error = yield* Effect.flip(withSecretStoreLock("secrets", "session", Effect.void));
    assert.instanceOf(error, SecretStoreLockError);
    assert.equal(error.reason, code === "ELOCKED" ? "busy" : "unavailable");
    const codexError = yield* Effect.flip(
      withChatGptSessionLock("secrets", "session", instanceId, Effect.void),
    );
    assert.instanceOf(codexError, ProviderSetupError);
    assert.equal(codexError.instanceId, instanceId);
    assert.equal(codexError.operation, "credential-lock");
    assert.equal(
      codexError.detail,
      "Could not lock the ChatGPT connection for an update. Try again.",
    );
  }),
);

it.effect("interrupts a protected task when the shared lease is compromised", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const release = vi.fn(async () => {});
      vi.mocked(lock).mockResolvedValue(release);
      const task = yield* withSecretStoreLock(
        "secrets",
        "session",
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      ).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const options = vi.mocked(lock).mock.lastCall?.[1];
      options?.onCompromised?.(Object.assign(new Error("Lease lost"), { code: "ECOMPROMISED" }));
      const result = yield* Fiber.join(task);
      assert.equal(result._tag, "Failure");
      yield* Deferred.await(interrupted);
      assert.equal(release.mock.calls.length, 1);
    }),
  ),
);

it.effect.each(["ELOCKED", "EACCES"])(
  "reports %s clearly and retries startup adoption only for a busy lock",
  (code) =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.mocked(lock).mockRejectedValue(
          Object.assign(new Error("Lease acquisition failed"), { code }),
        );
        const session = yield* CliSession.make;
        for (const task of [
          session.currentIdentity.pipe(Effect.asVoid),
          session
            .verifyEmailSignIn({ email: "person@example.test", code: "12345678" })
            .pipe(Effect.asVoid),
          session.signOut.pipe(Effect.asVoid),
        ]) {
          const error = yield* Effect.flip(task);
          assert.instanceOf(error, CliSession.CloudCliSessionStorageError);
          assert.equal(
            error.message,
            code === "ELOCKED"
              ? "Another styal process is updating the styal Link sign-in; try again."
              : "Could not read or update the stored styal Link sign-in.",
          );
        }
        const failed = yield* Deferred.make<void>();
        const retried = yield* Deferred.make<void>();
        const warnings: Array<unknown> = [];
        let attempts = 0;
        yield* Layer.build(
          CliSession.layerStartupAdoption.pipe(
            Layer.provide(
              Layer.succeed(CliSession.CloudCliSession, {
                ...session,
                currentIdentity: Effect.suspend(() => {
                  attempts += 1;
                  return session.currentIdentity.pipe(
                    Effect.tapError(() =>
                      Deferred.succeed(attempts === 1 ? failed : retried, undefined),
                    ),
                  );
                }),
              }),
            ),
            Layer.provide(
              Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
                mergeWithExisting: false,
              }),
            ),
          ),
        );
        yield* Deferred.await(failed);
        if (code === "ELOCKED") {
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(retried);
          assert.equal(attempts, 2);
          assert.include(String(warnings[0]), "will retry");
        } else {
          yield* TestClock.adjust("10 minutes");
          assert.equal(attempts, 1);
          assert.lengthOf(warnings, 1);
          assert.include(String(warnings[0]), "adoption stopped");
        }
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("No HTTP request should run without the credential lease"),
        ),
      ),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        directory: "synthetic-secrets",
        get: (name) =>
          name === CliSession.LEGACY_CLERK_CLI_TOKEN_SECRET
            ? Effect.succeedSome(new TextEncoder().encode("stored-legacy-credential"))
            : Effect.succeedNone,
        set: () => Effect.die("No credential mutation should run without the lease"),
        create: () => Effect.die("No credential mutation should run without the lease"),
        remove: () => Effect.die("No credential mutation should run without the lease"),
        getOrCreateRandom: () => Effect.die("unused"),
      }),
    ),
);
