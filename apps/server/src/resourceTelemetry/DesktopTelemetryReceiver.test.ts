// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { requireDesktopTelemetryWriteProgress } from "./DesktopTelemetryReceiver.ts";

function spawnTelemetryReader() {
  const receiverUrl = new URL("./DesktopTelemetryReceiver.ts", import.meta.url).href;
  const source = `
    import * as NodeStream from "@effect/platform-node/NodeStream";
    import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
    import * as Effect from "effect/Effect";
    import * as Stream from "effect/Stream";
    import { openDesktopTelemetryInputStream } from ${JSON.stringify(receiverUrl)};

    const shutdownRequested = new Promise((resolve) => process.stdin.once("data", resolve));
    const program = Effect.scoped(Effect.gen(function* () {
      const readable = yield* Effect.acquireRelease(
        Effect.sync(() => openDesktopTelemetryInputStream(4)),
        (stream) => Effect.sync(() => stream.destroy()),
      );
      yield* NodeStream.fromReadable({ evaluate: () => readable, closeOnDone: true }).pipe(
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      process.stdout.write("READY\\n");
      yield* Effect.promise(() => shutdownRequested);
    }));

    NodeRuntime.runMain(program);
  `;
  const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: NodePath.resolve(import.meta.dirname, "../.."),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe", "ignore", "pipe"],
  });
  const shutdownInput = child.stdin;
  const telemetryInput = child.stdio[4];
  if (
    shutdownInput === null ||
    telemetryInput === undefined ||
    telemetryInput === null ||
    !("write" in telemetryInput)
  ) {
    child.kill("SIGKILL");
    throw new Error("Desktop telemetry test pipe is unavailable.");
  }
  telemetryInput.write("telemetry remains open");

  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (!readySettled && output.includes("READY")) {
        readySettled = true;
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (readySettled) return;
      reject(
        new Error(
          `Desktop telemetry reader exited before ready (code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
    });
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exit, ready, shutdownInput };
}

describe("DesktopTelemetryReceiver", () => {
  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );

  it.effect("closes an open desktop telemetry pipe during scoped shutdown", () =>
    Effect.acquireUseRelease(
      Effect.sync(spawnTelemetryReader),
      (reader) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => reader.ready);
          yield* Effect.sync(() => reader.shutdownInput.end("shutdown\n"));
          const exit = yield* Effect.promise(() => reader.exit);

          expect(exit).toEqual({ code: 0, signal: null });
        }),
      ({ child }) =>
        Effect.sync(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }),
    ),
  );
});
