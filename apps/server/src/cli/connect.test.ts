// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as RelayClient from "@t3tools/shared/relayClient";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { makeCli } from "../binCli.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "../cloud/CliState.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as Queue from "effect/Queue";
import * as Terminal from "effect/Terminal";
import * as TestClock from "effect/testing/TestClock";

import { SecretStoreLockError } from "../auth/SecretStoreLock.ts";
import * as CliSession from "../cloud/CliSession.ts";
import { acquireRelayClientForLink, authorizeCli, runEmailSignIn } from "./connect.ts";

const managedExecutable = {
  status: "available",
  executablePath: "/tmp/cloudflared",
  source: "managed",
  version: RelayClient.CLOUDFLARED_VERSION,
} as const;

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

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "t3 connect unlink and status",
  (it) => {
    const runConnect = (
      recordedPid: number,
      options?: { readonly portFreed?: boolean; readonly command?: "unlink" | "status" },
    ) =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const warnings: Array<string> = [];
        const server = yield* Effect.acquireRelease(
          Effect.callback<NodeHttp.Server>((resume) => {
            const listening = NodeHttp.createServer((request, response) => {
              requests.push(`${request.method} ${request.url}`);
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ ok: true, endpointRuntimeStatus: null }));
            });
            listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)));
          }),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die(new Error("Expected a TCP address"));
        }
        if (options?.portFreed) {
          yield* Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          });
        }

        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-connect-unlink-test-" });
        const state = yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: address.port,
        });
        yield* persistServerRuntimeState({
          path: `${baseDir}/userdata/server-runtime.json`,
          state: { ...state, pid: recordedPid },
        });
        if (options?.command === "status") {
          // Status asks the server for reachability only for a managed link.
          yield* fs.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
          yield* fs.writeFileString(
            `${baseDir}/userdata/secrets/${CLOUD_CLI_DESIRED_LINK_SECRET}.bin`,
            "managed",
          );
        }

        yield* Command.runWith(makeCli({ cloudEnabled: true }), { version: "0.0.0" })([
          "connect",
          options?.command ?? "unlink",
          "--base-dir",
          baseDir,
        ]).pipe(
          // TestConsole has no reader for Console.warn.
          Effect.updateService(Console.Console, (console) => ({
            ...console,
            warn: (...args: ReadonlyArray<unknown>) => {
              warnings.push(args.join(" "));
            },
          })),
        );

        return { requests, warnings, printed: (yield* TestConsole.logLines).join("\n") };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );

    // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
    const deadPid = 4_194_305;

    it.effect("does not tell the user to restart a server that is gone", () =>
      Effect.gen(function* () {
        const { printed, warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(printed, "styal Link is disabled locally.");
        assert.notInclude(warnings.join("\n"), "Restart that server");
      }),
    );

    it.effect("warns that a server that is gone may have left its connector running", () =>
      Effect.gen(function* () {
        const { warnings } = yield* runConnect(deadPid, { portFreed: true });

        assert.include(warnings.join("\n"), "its cloudflared process may still be running");
      }),
    );

    it.effect("does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid);

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status does not send a token to whatever took over a dead server's port", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(deadPid, { command: "status" });

        assert.deepEqual(requests, []);
      }),
    );

    it.effect("status asks a running server to check reachability", () =>
      Effect.gen(function* () {
        const { requests } = yield* runConnect(process.pid, { command: "status" });

        assert.deepEqual(requests, ["POST /api/connect/reachability"]);
      }),
    );

    it.effect("asks a running server to stop its tunnel", () =>
      Effect.gen(function* () {
        const { requests, printed, warnings } = yield* runConnect(process.pid);

        assert.deepEqual(requests, ["POST /api/connect/unlink"]);
        assert.include(printed, "styal Link is disabled locally.");
        assert.notInclude(warnings.join("\n"), "cloudflared process");
      }),
    );
  },
);

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
    size: Queue.unbounded<Terminal.Size, Cause.Done>(),
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
  new CliSession.CloudCliRelayRejectedError({ description: "HTTP 404." }),
  new CliSession.CloudCliRelayRejectedError({ description: "invalid_dpop" }),
  new CliSession.CloudCliSessionStorageError({ cause: new Error("invalid legacy token") }),
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
