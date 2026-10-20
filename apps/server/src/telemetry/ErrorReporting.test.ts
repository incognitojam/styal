import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { AnalyticsService } from "./AnalyticsService.ts";
import * as ErrorReporting from "./ErrorReporting.ts";

class TerminalStartError extends Data.TaggedError("TerminalStartError")<{
  readonly message: string;
}> {}

const scrub = ErrorReporting.makeScrubber({ appRoot: "/opt/styal", homeDir: "/Users/alex" });
// Frames from this test file, made relative to the real server package root.
const localScrub = ErrorReporting.makeScrubber({
  appRoot: NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
  homeDir: "/Users/alex",
});

const withSink = <A, E, R>(
  run: (sink: ErrorReporting.ErrorReportSink["Service"]) => Effect.Effect<A, E, R>,
) => {
  const sink = ErrorReporting.makeErrorReportSink();
  return run(sink).pipe(
    Effect.provide(Logger.layer([ErrorReporting.errorReportLogger(sink)])),
    Effect.andThen(Effect.sync(() => sink.drain())),
  );
};

const firstException = (
  entry: ErrorReporting.LoggedError | undefined,
  scrubber: ErrorReporting.Scrubber = scrub,
) => {
  assert.isDefined(entry);
  const [exception] = ErrorReporting.exceptionProperties(entry, scrubber).$exception_list;
  assert.isDefined(exception);
  return exception;
};

describe("ErrorReporting logger", () => {
  it.effect("queues a defect logged with its cause", () =>
    Effect.gen(function* () {
      const entries = yield* withSink(() =>
        Effect.die(new TypeError("cannot read 'id' of undefined")).pipe(
          Effect.catchCause((cause) => Effect.logError("effect worker failed", cause)),
        ),
      );

      assert.strictEqual(entries.length, 1);
      const exception = firstException(entries[0]);
      assert.strictEqual(exception.type, "TypeError");
      assert.strictEqual(exception.value, "cannot read 'id' of undefined");
      assert.isAbove(exception.stacktrace?.frames?.length ?? 0, 0);
    }),
  );

  it.effect("reports the error passed alongside a logged message", () =>
    Effect.gen(function* () {
      const entries = yield* withSink(() =>
        Effect.logError("failed to start terminal", {
          cause: new TerminalStartError({ message: "spawn /bin/zsh ENOENT" }),
        }),
      );

      assert.strictEqual(entries.length, 1);
      const entry = entries[0];
      assert.isDefined(entry);
      const properties = ErrorReporting.exceptionProperties(entry, scrub);
      assert.strictEqual(properties.logMessage, "failed to start terminal");
      assert.strictEqual(properties.$exception_level, "error");
      assert.strictEqual(firstException(entry).type, "TerminalStartError");
    }),
  );

  it.effect("reports a message-only error with the Effect.fn call sites that led to it", () =>
    Effect.gen(function* () {
      const publish = Effect.fn("SessionStore.publish")(function* () {
        yield* Effect.logError("Failed to publish connected-session auth update.");
      });
      const entries = yield* withSink(() => publish());

      const exception = firstException(entries[0], localScrub);
      assert.strictEqual(exception.type, "LoggedError");
      assert.strictEqual(exception.value, "Failed to publish connected-session auth update.");
      const frames = exception.stacktrace?.frames ?? [];
      assert.include(
        frames.map((frame) => frame.function),
        "SessionStore.publish",
      );
      assert.isTrue(
        frames.some((frame) => frame.filename === "src/telemetry/ErrorReporting.test.ts"),
      );
    }),
  );

  it.effect("ignores warnings and interruptions", () =>
    Effect.gen(function* () {
      const entries = yield* withSink(() =>
        Effect.gen(function* () {
          yield* Effect.logWarning("provider refresh failed");
          const fiber = yield* Effect.forkDetach(Effect.never);
          yield* Fiber.interrupt(fiber);
        }),
      );

      assert.deepStrictEqual(entries, []);
    }),
  );
});

describe("ErrorReporting scrubbing", () => {
  it("makes frames relative and drops absolute paths", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at handle (/opt/styal/dist/bin.mjs:120:7)",
      "    at run (/Users/alex/.npm/_npx/abc/node_modules/effect/dist/Effect.js:10:3)",
      "    at load (/Users/alex/projects/secret-app/tool.js:4:1)",
    ].join("\n");

    const exception = firstException({
      level: "error",
      message: [],
      cause: Cause.die(error),
      span: "ws.rpc.thread.send",
    });
    const frames = exception.stacktrace?.frames ?? [];

    assert.deepStrictEqual(
      frames.map((frame) => frame.filename),
      ["~/projects/secret-app/tool.js", "node_modules/effect/dist/Effect.js", "dist/bin.mjs"],
    );
    assert.isTrue(frames.every((frame) => !("abs_path" in frame)));
  });

  it("tags frames and the report with the chunk and release ids stamped by the upload", () => {
    // The upload plugin registers each chunk's stack, keyed by the stack string.
    const registry = globalThis as {
      _posthogChunkIds?: Record<string, string> | undefined;
      _posthogReleaseId?: string | undefined;
    };
    const previous = { chunkIds: registry._posthogChunkIds, releaseId: registry._posthogReleaseId };
    registry._posthogReleaseId = "0199f0a0-0000-7000-8000-00000000c0de";
    registry._posthogChunkIds = {
      "Error\n    at /opt/styal/dist/binCli-AbC123.mjs:2:120":
        "1619eb4b-b4ec-5017-a3f1-f90e3b71be09",
    };
    try {
      const error = new Error("boom");
      error.stack = [
        "Error: boom",
        "    at handle (/opt/styal/dist/binCli-AbC123.mjs:5000:7)",
        "    at run (/opt/styal/dist/Effect-XyZ.mjs:10:3)",
      ].join("\n");

      const properties = ErrorReporting.exceptionProperties(
        { level: "error", message: [], cause: Cause.die(error), span: undefined },
        scrub,
      );
      const frames = properties.$exception_list[0]?.stacktrace?.frames ?? [];

      assert.strictEqual(properties.$release_id, "0199f0a0-0000-7000-8000-00000000c0de");

      assert.deepStrictEqual(
        frames.map((frame) => [frame.filename, frame.chunk_id]),
        [
          ["dist/Effect-XyZ.mjs", undefined],
          ["dist/binCli-AbC123.mjs", "1619eb4b-b4ec-5017-a3f1-f90e3b71be09"],
        ],
      );
    } finally {
      registry._posthogChunkIds = previous.chunkIds;
      registry._posthogReleaseId = previous.releaseId;
    }
  });

  it("removes personal and secret values from text", () => {
    assert.strictEqual(
      scrub.text("ENOENT: open '/Users/alex/work/notes.md'"),
      "ENOENT: open '~/work/notes.md'",
    );
    assert.strictEqual(
      scrub.text("C:\\Users\\sam\\AppData\\styal failed"),
      "C:\\Users\\<user>\\AppData\\styal failed",
    );
    assert.strictEqual(
      scrub.text("GET https://user:pw@api.example.com/v1/x?token=abc failed for dev@example.com"),
      "GET https://<credentials>@api.example.com/v1/x?<query> failed for <email>",
    );
    assert.strictEqual(
      scrub.text("Authorization: Bearer sk-live.12345 rejected"),
      "Authorization: Bearer <redacted> rejected",
    );
    assert.strictEqual(
      scrub.text("session 0123456789abcdef0123456789abcdef expired"),
      "session <redacted> expired",
    );
  });
});

describe("ErrorReporting delivery", () => {
  const deliver = (enabled: boolean, entries: ReadonlyArray<ErrorReporting.LoggedError>) =>
    Effect.gen(function* () {
      const recorded: Array<{ event: string; properties: unknown }> = [];
      const sink = ErrorReporting.makeErrorReportSink();
      const layer = ErrorReporting.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ErrorReporting.ErrorReportSink, sink),
            Layer.succeed(
              AnalyticsService,
              AnalyticsService.of({
                recordOwners: () => Effect.void,
                record: (event, properties) =>
                  Effect.sync(() => {
                    recorded.push({ event, properties });
                  }),
                flush: Effect.void,
              }),
            ),
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_ERROR_REPORTING_ENABLED: String(enabled) }),
            ),
          ),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          for (const entry of entries) sink.offer(entry);
          yield* TestClock.adjust("1 second");
        }),
      );
      // Entries a closed sink kept would never be reported or released.
      return { recorded, held: sink.drain() };
    });

  const repeated = (value: string) =>
    Array.from({ length: 5 }, (): ErrorReporting.LoggedError => ({
      level: "error",
      message: [value],
      cause: Cause.empty,
      span: undefined,
    }));

  it.effect("records a few reports of a repeating error as $exception events", () =>
    Effect.gen(function* () {
      const { recorded } = yield* deliver(true, [...repeated("first"), ...repeated("second")]);

      assert.strictEqual(recorded.length, 6);
      assert.isTrue(recorded.every((report) => report.event === "$exception"));
    }),
  );

  it.effect("records and holds nothing when error reporting is disabled", () =>
    Effect.gen(function* () {
      const { recorded, held } = yield* deliver(false, repeated("first"));

      assert.deepStrictEqual(recorded, []);
      assert.deepStrictEqual(held, []);
    }),
  );
});
