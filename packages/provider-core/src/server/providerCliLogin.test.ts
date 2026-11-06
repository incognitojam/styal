import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

import { latestLoginUrl, parsePastedRedirect, readLoginPrompt } from "./providerAuthTerminal.ts";
import * as ProviderCliLogin from "./providerCliLogin.ts";

const instanceId = ProviderInstanceId.make("cli-login-test");
const provider = (status: ServerProvider["auth"]["status"]) =>
  ({ auth: { status } }) as unknown as ServerProvider;

const makeHarness = Effect.fn("makeHarness")(function* (afterLogin: ServerProvider) {
  const spawned: Array<PtyAdapter.PtySpawnInput> = [];
  const written: Array<string> = [];
  const onSpawn = yield* Deferred.make<void>();
  const settleGate = yield* Deferred.make<void>();
  let onOutput: ((data: string) => void) | undefined;
  const earlyOutput: Array<string> = [];
  let exit: (exitCode: number) => void = () => {};
  const pty = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        spawned.push(input);
        Deferred.doneUnsafe(onSpawn, Effect.void);
        return {
          pid: 1,
          write: (data: string) => void written.push(data),
          resize: () => {},
          kill: () => {},
          onData: (callback: (data: string) => void) => {
            onOutput = callback;
            for (const data of earlyOutput.splice(0)) callback(data);
            return () => {};
          },
          onExit: (callback: (event: PtyAdapter.PtyExitEvent) => void) => {
            exit = (exitCode) => callback({ exitCode, signal: null });
            return () => {};
          },
        };
      }),
  });
  const refreshes = { count: 0 };
  const controller = yield* ProviderCliLogin.make({
    instanceId,
    credentialKey: "test:login",
    command: Effect.succeed({ binary: "provider", args: ["auth", "login"] }),
    environment: { CONFIG_DIR: "/config" },
    cwd: "/state",
    hint: "Pick a device code.",
    terminalSettle: Deferred.await(settleGate),
    refresh: Effect.sync(() => {
      refreshes.count++;
      return afterLogin;
    }),
  }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, pty));
  const until = (matches: (state: ProviderAuthState) => boolean) =>
    controller
      .subscribe("owner")
      .pipe(Stream.filter(matches), Stream.runHead, Effect.map(Option.getOrThrow));
  return {
    controller,
    spawned,
    written,
    onSpawn,
    refreshes,
    until,
    settled: Deferred.succeed(settleGate, undefined),
    emit: (data: string) => {
      if (onOutput) onOutput(data);
      else earlyOutput.push(data);
    },
    exit: (exitCode: number) => exit(exitCode),
  };
});

const CLAUDE_OUTPUT =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit: " +
  "\x1b]8;;https://example.test/oauth?code=true&redirect_uri=https%3A%2F%2Fexample.test%2Fcallback&state=s\x07" +
  "https://example.test/oauth?code=true&redirect_uri=https%3A%2F%2Fexample.test%2Fcallback&state=s\x1b]8;;\x07\r\n" +
  "Paste code here if prompted > ";

it.effect("signs in by pasting a code, then checks status and replaces signed-out sessions", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(provider("authenticated"));
    const stopped = yield* Deferred.make<void>();
    const stopSessions = Effect.gen(function* () {
      // Sessions must outlive the login: a failed sign-in stops nothing.
      assert.equal(harness.refreshes.count, 1);
      yield* Deferred.succeed(stopped, undefined);
    });
    yield* harness.controller.start("owner", stopSessions);
    yield* Deferred.await(harness.onSpawn);
    assert.equal(harness.spawned[0]?.shell, "provider");
    assert.deepEqual(harness.spawned[0]?.args, ["auth", "login"]);
    assert.equal(harness.spawned[0]?.cwd, "/state");
    assert.equal(harness.spawned[0]?.env.CONFIG_DIR, "/config");

    harness.emit(CLAUDE_OUTPUT);
    const waiting = yield* harness.until((state) => state.interaction?.type === "credentials");
    assert.include(waiting.authorizationUrl, "https://example.test/oauth");
    assert.equal(waiting.interaction?.id, "code-0");
    if (waiting.interaction?.type === "credentials") {
      assert.equal(waiting.interaction.fields[0]?.label, "Paste code here if prompted");
    }
    yield* harness.controller.respond!("owner", {
      instanceId,
      flowId: waiting.flowId!,
      interactionId: "code-0",
      response: { type: "credentials", values: { code: " wrong-code " } },
    });
    assert.deepEqual(harness.written, ["wrong-code\r"]);
    yield* harness.until((state) => state.phase === "verifying");

    // The CLI keeps waiting after a bad code, so the form comes back for another try.
    harness.emit("Invalid code. Please make sure the full code was copied.\r\n");
    const retry = yield* harness.until((state) => state.interaction?.id === "code-1");
    assert.equal(retry.interaction?.type, "credentials");
    if (retry.interaction?.type === "credentials") {
      assert.equal(
        retry.interaction.fields[0]?.label,
        "Invalid code. Please make sure the full code was copied.",
      );
    }
    yield* harness.controller.respond!("owner", {
      instanceId,
      flowId: waiting.flowId!,
      interactionId: "code-1",
      response: { type: "credentials", values: { code: "right-code" } },
    });
    assert.deepEqual(harness.written, ["wrong-code\r", "right-code\r"]);

    harness.emit("Login successful.\r\n");
    harness.exit(0);
    const done = yield* harness.until((state) => state.phase === "succeeded");
    assert.isNull(done.authorizationUrl);
    yield* Deferred.await(stopped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an unrecognized login in the terminal, and answers its menus from there", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(provider("authenticated"));
    yield* harness.controller.start("owner");
    yield* Deferred.await(harness.onSpawn);
    harness.emit("Select integration\r\n  OpenAI\r\n");
    yield* harness.settled;
    const menu = yield* harness.until((state) => state.interaction?.type === "terminal");
    assert.include(menu.interaction?.type === "terminal" ? menu.interaction.output : "", "Pick a");
    yield* harness.controller.respond!("owner", {
      instanceId,
      flowId: menu.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "\r" },
    });
    harness.emit("Enter code: 2YNS-WF1O2\r\nhttps://example.test/device\r\n");
    const device = yield* harness.until((state) => state.interaction?.type === "deviceCode");
    assert.deepInclude(device.interaction, {
      userCode: "2YNS-WF1O2",
      url: "https://example.test/device",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "the login exits with an error", exitCode: 1, after: "authenticated", refreshes: 0 },
  { name: "the provider stays signed out", exitCode: 0, after: "unauthenticated", refreshes: 1 },
] as const)("fails without touching sessions when $name", ({ exitCode, after, refreshes }) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(provider(after));
    let stopped = false;
    yield* harness.controller.start(
      "owner",
      Effect.sync(() => {
        stopped = true;
      }),
    );
    yield* Deferred.await(harness.onSpawn);
    harness.emit("Working\r\n");
    yield* harness.settled;
    yield* harness.until((state) => state.phase === "waiting");
    harness.exit(exitCode);
    const failed = yield* harness.until((state) => state.phase === "failed");
    assert.isString(failed.message);
    assert.equal(harness.refreshes.count, refreshes);
    assert.isFalse(stopped);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports that login is unavailable without a terminal", () =>
  Effect.gen(function* () {
    const controller = yield* ProviderCliLogin.make({
      instanceId,
      credentialKey: "test:login",
      command: Effect.succeed({ binary: "provider", args: [] }),
      environment: {},
      refresh: Effect.succeed(provider("authenticated")),
    });
    yield* controller.start("owner");
    const failed = yield* controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === "failed"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.match(failed.message ?? "", /unavailable/);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("reads what each login's output asks for", () => {
  for (const [name, output, expected] of [
    ["Claude", CLAUDE_OUTPUT, "pasteCode"],
    [
      "OpenCode device code",
      "\x1b[34m●\x1b[39m  Enter code: 98C2-E395\r\n│\r\n●  https://example.test/login/device\r\n◇  Waiting for authorization...",
      "deviceCode",
    ],
    [
      "OpenCode browser sign-in",
      "●  https://example.test/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A35101%2Fauth%2Fcallback&state=s\r\n◇  Waiting...",
      "redirect",
    ],
    ["a link with no prompt", "Open https://example.test/start to continue\r\n", null],
    ["a menu", "◆  Select login method\r\n│  ● API key\r\n", null],
  ] as const) {
    assert.equal(readLoginPrompt(output)?.type ?? null, expected, name);
  }
});

it("only accepts a pasted redirect from this sign-in", () => {
  const prompt = {
    type: "redirect" as const,
    url: "https://example.test/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A35101%2Fcb&state=s1",
    redirect: new URL("http://127.0.0.1:35101/cb"),
  };
  for (const [pasted, accepted] of [
    ["http://127.0.0.1:35101/cb?code=c&state=s1", true],
    ["  http://127.0.0.1:35101/cb?code=c&state=s1\n", true],
    ["http://127.0.0.1:35101/cb?code=c&state=other", false],
    ["http://127.0.0.1:9999/cb?code=c&state=s1", false],
    ["http://127.0.0.1:35101/elsewhere?code=c&state=s1", false],
    ["https://attacker.example/cb?code=c&state=s1", false],
    ["not a url", false],
  ] as const) {
    assert.equal(parsePastedRedirect(pasted, prompt) !== null, accepted, pasted);
  }
});

it("takes the latest link from raw terminal output", () => {
  for (const [output, url] of [
    ["no link here", undefined],
    ["\x1b[34m●\x1b[39m  https://a.test/x?y=1&z=2\r\n", "https://a.test/x?y=1&z=2"],
    [
      "https://old.test\r\n\x1b]8;;https://osc.test\x07https://new.test/a\x1b]8;;\x07",
      "https://new.test/a",
    ],
    ["│  https://b.test/device│\r\n", "https://b.test/device"],
  ] as const) {
    assert.equal(latestLoginUrl(output), url);
  }
});

it("withCliLoginSetup offers sign-in only for an installed CLI that owns the login", () => {
  const stamp = ProviderCliLogin.withCliLoginSetup(
    (draft) => ({ ...draft, instanceId, driver: "test" }) as unknown as ServerProvider,
    (draft) => draft.auth.type === "apiKey",
  );
  const draft = (installed: boolean, type?: string) =>
    ({ installed, auth: { status: "authenticated", ...(type ? { type } : {}) } }) as never;
  assert.isTrue(stamp(draft(true)).setup?.canAuthenticate);
  assert.isFalse(stamp(draft(false)).setup?.canAuthenticate);
  assert.isFalse(stamp(draft(true, "apiKey")).setup?.canAuthenticate);
  assert.isFalse(stamp(draft(true)).auth.canLogout);
});
