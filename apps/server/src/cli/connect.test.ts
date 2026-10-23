import * as NodeServices from "@effect/platform-node/NodeServices";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Terminal from "effect/Terminal";
import * as TestClock from "effect/testing/TestClock";

import { SecretStoreLockError } from "../auth/SecretStoreLock.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliSession from "../cloud/CliSession.ts";
import {
  acquireRelayClientForLink,
  authorizeCli,
  reportCloudDisconnectResults,
  runEmailSignIn,
} from "./connect.ts";
import { recoverServiceOnboardingOffer } from "./service.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

it.effect("treats cancelling optional background setup as a successful skip", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(Effect.fail(new Terminal.QuitError({})));
    assert.isFalse(result);
  }),
);

it.effect("keeps a successful connection when a remote service update is pending", () =>
  Effect.gen(function* () {
    const result = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServiceUpdatePendingError()),
    );
    assert.isFalse(result);
  }),
);

it.effect("does not install the relay client when the user declines the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: () =>
          Effect.sync(() => {
            installCalls += 1;
            return managedExecutable;
          }),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(false),
      () => Effect.void,
    );

    assert.isTrue(Option.isNone(result));
    assert.equal(installCalls, 0);
  }),
);

it.effect("installs the relay client after the user accepts the managed download", () =>
  Effect.gen(function* () {
    let installCalls = 0;
    const progress: Array<string> = [];
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
        install: Effect.sync(() => {
          installCalls += 1;
          return managedExecutable;
        }),
        installWithProgress: (report) =>
          report({ type: "progress", stage: "downloading" }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                installCalls += 1;
                return managedExecutable;
              }),
            ),
          ),
        pruneManagedVersions: Effect.void,
      },
      () => Effect.succeed(true),
      (event) =>
        Effect.sync(() => {
          if (event.type === "progress") {
            progress.push(event.stage);
          }
        }),
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(installCalls, 1);
    assert.deepEqual(progress, ["downloading"]);
  }),
);

it.effect("reuses an available relay client executable without prompting", () =>
  Effect.gen(function* () {
    let promptCalls = 0;
    const result = yield* acquireRelayClientForLink(
      {
        resolve: Effect.succeed(managedExecutable),
        install: Effect.die("unexpected install"),
        installWithProgress: () => Effect.die("unexpected install"),
        pruneManagedVersions: Effect.void,
      },
      () =>
        Effect.sync(() => {
          promptCalls += 1;
          return false;
        }),
      () => Effect.void,
    );

    assert.deepEqual(Option.getOrThrow(result), managedExecutable);
    assert.equal(promptCalls, 0);
  }),
);

it.effect("keeps disconnect causes in structured logs and out of console warnings", () => {
  const warnings: ReadonlyArray<unknown>[] = [];
  const logs: Readonly<Record<string, unknown>>[] = [];
  const testConsole = {
    ...globalThis.console,
    warn: (...args: ReadonlyArray<unknown>) => {
      warnings.push(args);
    },
  } satisfies Console.Console;
  const logger = Logger.make(({ fiber }) => {
    logs.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  const liveFailure = "live unlink private diagnostic";
  const relayFailure = "relay revoke private diagnostic";

  return reportCloudDisconnectResults({
    clearAuthorization: true,
    liveResult: {
      status: "failed",
      cause: Cause.fail(new Error(liveFailure)),
    },
    relayResult: Exit.failCause(Cause.die(new Error(relayFailure))),
  }).pipe(
    Effect.provideService(Console.Console, testConsole),
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.lengthOf(warnings, 2);
        const warningText = warnings.flat().map(String).join("\n");
        assert.include(warningText, "running server could not stop its tunnel");
        assert.include(warningText, "Could not revoke the relay-side environment record");
        assert.notInclude(warningText, liveFailure);
        assert.notInclude(warningText, relayFailure);
        assert.deepEqual(
          logs.map(({ operation, clearAuthorization }) => ({ operation, clearAuthorization })),
          [
            { operation: "live-server-unlink", clearAuthorization: true },
            { operation: "relay-environment-unlink", clearAuthorization: true },
          ],
        );
        const loggedCauses = logs.map((log) => String(log.cause)).join("\n");
        assert.include(loggedCauses, liveFailure);
        assert.include(loggedCauses, relayFailure);
      }),
    ),
  );
});

interface SignInHarness {
  readonly session: CliSession.CloudCliSession["Service"];
  readonly startCalls: Array<string>;
  readonly verifiedCodes: Array<string>;
  readonly output: Array<string>;
  readonly testConsole: Console.Console;
}

/** A session that accepts "12345678" and answers other codes with the given reasons in order. */
function makeSignInHarness(input: {
  readonly resendAfterSeconds: number;
  readonly codeFailures: ReadonlyArray<CliSession.CloudCliSignInCodeError["reason"]>;
}): SignInHarness {
  const startCalls: Array<string> = [];
  const verifiedCodes: Array<string> = [];
  const output: Array<string> = [];
  const failures = [...input.codeFailures];
  const unused = Effect.die("unused");
  const session = CliSession.CloudCliSession.of({
    startEmailSignIn: (email) =>
      Effect.sync(() => {
        startCalls.push(email);
        return {
          expiresAt: "1970-01-01T00:10:00.000Z",
          resendAfterSeconds: input.resendAfterSeconds,
        };
      }),
    verifyEmailSignIn: ({ email, code }) =>
      Effect.suspend(() => {
        verifiedCodes.push(code);
        const reason = code === "12345678" ? undefined : failures.shift();
        return reason === undefined
          ? Effect.succeed({ userId: "user_1", email, relayUrl: "https://relay.example.test" })
          : Effect.fail(new CliSession.CloudCliSignInCodeError({ reason }));
      }),
    currentIdentity: unused,
    storedIdentity: unused,
    hasCredential: unused,
    authorize: () => unused,
    signOut: unused,
  });
  const testConsole = {
    ...globalThis.console,
    log: (...args: ReadonlyArray<unknown>) => {
      output.push(args.map(String).join(" "));
    },
  } satisfies Console.Console;
  return { session, startCalls, verifiedCodes, output, testConsole };
}

const scriptedAnswers = (answers: ReadonlyArray<string>, beforeEach?: Effect.Effect<void>) => {
  const remaining = [...answers];
  return Effect.gen(function* () {
    if (beforeEach) yield* beforeEach;
    const answer = remaining.shift();
    return answer ?? (yield* Effect.die("prompted more often than scripted"));
  });
};

it.effect("asks for the code again after a wrong code and signs in with the right one", () => {
  const harness = makeSignInHarness({ resendAfterSeconds: 30, codeFailures: ["incorrect"] });
  return Effect.gen(function* () {
    const identity = yield* runEmailSignIn({
      session: harness.session,
      email: "person@example.test",
      promptCode: scriptedAnswers(["11111111", "12345678"]),
    });

    assert.equal(identity.email, "person@example.test");
    assert.deepEqual(harness.startCalls, ["person@example.test"]);
    assert.deepEqual(harness.verifiedCodes, ["11111111", "12345678"]);
    assert.isTrue(harness.output.some((line) => line.includes("Sent an 8-digit code")));
    assert.isTrue(harness.output.some((line) => line.includes("That code is not correct.")));
  }).pipe(Effect.provideService(Console.Console, harness.testConsole));
});

it.effect("tells the user to request a new code once the code is used up, and resends on r", () => {
  const harness = makeSignInHarness({
    resendAfterSeconds: 30,
    codeFailures: ["too_many_attempts"],
  });
  return Effect.gen(function* () {
    yield* runEmailSignIn({
      session: harness.session,
      email: "person@example.test",
      // The resend delay passes before the user answers "r" the second time.
      promptCode: scriptedAnswers(
        ["22222222", "r", "r", "12345678"],
        TestClock.adjust("16 seconds"),
      ),
    });

    assert.deepEqual(harness.startCalls, ["person@example.test", "person@example.test"]);
    assert.deepEqual(harness.verifiedCodes, ["22222222", "12345678"]);
    assert.isTrue(
      harness.output.some((line) => line.includes('Too many incorrect codes. Enter "r"')),
    );
    assert.isTrue(harness.output.some((line) => line.includes("You can request a new code in")));
    assert.isTrue(harness.output.some((line) => line.includes("Sent a new 8-digit code")));
  }).pipe(Effect.provideService(Console.Console, harness.testConsole));
});

/** Exercise the real prompts with terminal input and redirected output. */
const withInteractiveInput = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => {
        const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
        const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
        return { stdin, stdout };
      }),
      ({ stdin, stdout }) =>
        Effect.sync(() => {
          if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
          else Reflect.deleteProperty(process.stdin, "isTTY");
          if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
          else Reflect.deleteProperty(process.stdout, "isTTY");
        }),
    ).pipe(Effect.andThen(effect)),
  );

const scriptedTerminal = (answers: ReadonlyArray<string>, output: Array<string>) => {
  const remaining = [...answers];
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readLine: Effect.die("unexpected readLine"),
    display: (text) =>
      Effect.sync(() => {
        output.push(text);
      }),
    readInput: Effect.gen(function* () {
      const answer = remaining.shift();
      if (answer === undefined) return yield* Effect.die("unexpected prompt");
      const queue = yield* Queue.make<Terminal.UserInput, Cause.Done>();
      yield* Queue.offerAll(
        queue,
        [...answer, "return"].map((key) => ({
          input: Option.some(key),
          key: { name: key, ctrl: false, meta: false, shift: false },
        })),
      );
      return queue;
    }),
  });
};

it.effect.each([
  new CliSession.CloudCliClerkRefreshRejectedError({ status: 400 }),
  new CliSession.CloudCliRelayRejectedError({ description: "HTTP 404." }),
  new CliSession.CloudCliRelayRejectedError({ description: "invalid_dpop" }),
  new CliSession.CloudCliSessionStorageError({ cause: new Error("invalid legacy token") }),
  new CliSession.CloudCliLegacyClerkConfigError({ cause: new Error("missing config") }),
])("offers email sign-in after permanent credential recovery failure %j", (error) => {
  const harness = makeSignInHarness({ resendAfterSeconds: 30, codeFailures: [] });
  const output: Array<string> = [];
  return withInteractiveInput(
    Effect.gen(function* () {
      const identity = yield* authorizeCli({ email: Option.none() });
      assert.equal(identity.email, "person@example.test");
      assert.deepEqual(harness.startCalls, ["person@example.test"]);
      assert.deepEqual(harness.verifiedCodes, ["12345678"]);
      assert.include(output.join(""), "Email");
      assert.include(output.join(""), "Code");
      assert.include(harness.output.join(""), error.message);
    }).pipe(
      Effect.provideService(CliSession.CloudCliSession, {
        ...harness.session,
        currentIdentity: Effect.fail(error),
      }),
      Effect.provideService(
        Terminal.Terminal,
        scriptedTerminal(["person@example.test", "12345678"], output),
      ),
      Effect.provideService(Console.Console, harness.testConsole),
      Effect.provide(NodeServices.layer),
    ),
  );
});

it.effect.each([
  new CliSession.CloudCliRelayUnavailableError({ cause: new Error("offline") }),
  new CliSession.CloudCliSessionStorageError({
    cause: new SecretStoreLockError({ resource: "cloud-cli-session", reason: "busy" }),
  }),
])("preserves a transient recovery failure without prompting %j", (error) => {
  const harness = makeSignInHarness({ resendAfterSeconds: 30, codeFailures: [] });
  return Effect.gen(function* () {
    assert.equal(yield* Effect.flip(authorizeCli({ email: Option.none() })), error);
    assert.isEmpty(harness.startCalls);
  }).pipe(
    Effect.provideService(CliSession.CloudCliSession, {
      ...harness.session,
      currentIdentity: Effect.fail(error),
    }),
    Effect.provideService(Terminal.Terminal, scriptedTerminal([], [])),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("warns when --email differs from the signed-in account", () => {
  const harness = makeSignInHarness({ resendAfterSeconds: 30, codeFailures: [] });
  const warnings: Array<string> = [];
  return Effect.gen(function* () {
    const identity = yield* authorizeCli({ email: Option.some("other@example.test") });
    assert.equal(identity.email, "person@example.test");
    assert.include(warnings.join(""), "styal link logout");
    assert.isEmpty(harness.startCalls);
  }).pipe(
    Effect.provideService(CliSession.CloudCliSession, {
      ...harness.session,
      currentIdentity: Effect.succeedSome({
        userId: "user_1",
        email: "person@example.test",
        relayUrl: "https://relay.example.test",
      }),
    }),
    Effect.provideService(Console.Console, {
      ...harness.testConsole,
      warn: (...args) => {
        warnings.push(args.map(String).join(" "));
      },
    }),
    Effect.provide(NodeServices.layer),
  );
});

it.effect("retries a temporarily unavailable verification without sending another code", () => {
  const harness = makeSignInHarness({ resendAfterSeconds: 30, codeFailures: [] });
  let attempts = 0;
  return Effect.gen(function* () {
    const identity = yield* runEmailSignIn({
      session: {
        ...harness.session,
        verifyEmailSignIn: (input) =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new CliSession.CloudCliRelayUnavailableError({ cause: new Error("offline") }),
                )
              : harness.session.verifyEmailSignIn(input),
          ),
      },
      email: "person@example.test",
      promptCode: scriptedAnswers(["12345678", "12345678"]),
    });
    assert.equal(identity.email, "person@example.test");
    assert.equal(attempts, 2);
    assert.lengthOf(harness.startCalls, 1);
    assert.include(harness.output.join(""), "Check this machine's network connection");
  }).pipe(Effect.provideService(Console.Console, harness.testConsole));
});

it.effect.each([
  new CliSession.CloudCliRelayUnavailableError({ cause: new Error("offline") }),
  new CliSession.CloudCliEmailSignInUnavailableError({ reason: "delivery_failed" }),
])("keeps prompting after resend fails with %j", (error) => {
  const harness = makeSignInHarness({ resendAfterSeconds: 0, codeFailures: [] });
  let sends = 0;
  return Effect.gen(function* () {
    const identity = yield* runEmailSignIn({
      session: {
        ...harness.session,
        startEmailSignIn: (email) =>
          Effect.suspend(() =>
            ++sends === 2 ? Effect.fail(error) : harness.session.startEmailSignIn(email),
          ),
      },
      email: "person@example.test",
      promptCode: scriptedAnswers(["r", "12345678"]),
    });
    assert.equal(identity.email, "person@example.test");
    assert.equal(sends, 2);
    assert.include(harness.output.join(""), error.message);
  }).pipe(Effect.provideService(Console.Console, harness.testConsole));
});
