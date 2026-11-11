import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

export interface ProviderUpdateRecord {
  readonly outcome: "skipped" | "started" | "command_finished" | "finished" | "failed";
  readonly reason?: string | null;
  readonly currentVersion?: string | null;
  readonly targetVersion?: string | null;
  readonly updateDue?: boolean | null;
  readonly resultVersion?: string | null;
  readonly takeover?: boolean;
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly status?: string;
}

export class ProviderUpdateJournal extends Context.Service<
  ProviderUpdateJournal,
  {
    readonly record: (
      instanceId: string,
      driver: string,
      record: ProviderUpdateRecord,
    ) => Effect.Effect<void>;
  }
>()("@styal/cli/provider/ProviderUpdateJournal") {}

const encodeRecord = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const MAX_LINE_BYTES = 4096;
const ROTATE_AFTER_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ARCHIVES = 4;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const pending = yield* Queue.dropping<Uint8Array>(64);
  const fileName = "provider-updates.ndjson";
  const filePath = path.join(config.logsDir, fileName);
  const size = fs.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(0),
    ),
  );

  const initialize = Effect.gen(function* () {
    yield* fs.makeDirectory(config.logsDir, { recursive: true });
    if ((yield* size) >= ROTATE_AFTER_BYTES) {
      const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
      const archive = `${filePath}.${timestamp}.${yield* random.uuidV7()}`;
      // Unique destinations preserve history when two servers archive the same active path.
      yield* fs.rename(filePath, archive).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.void,
        ),
      );
    }
    const archives = (yield* fs.readDirectory(config.logsDir))
      .filter((name) => name.startsWith(`${fileName}.`))
      .sort()
      .reverse();
    yield* Effect.forEach(archives.slice(MAX_ARCHIVES), (name) =>
      fs.remove(path.join(config.logsDir, name), { force: true }),
    );
  });

  const write = Effect.fn("ProviderUpdateJournal.write")(function* (line: Uint8Array) {
    // Stat each append: another server's writes must count towards the cap too.
    // Concurrent appends may exceed it by one bounded line per writer.
    if ((yield* size) + line.byteLength > MAX_FILE_BYTES) return;
    yield* fs.writeFile(filePath, line, { flag: "a", mode: 0o600 });
  });
  const worker = initialize.pipe(
    Effect.andThen(Effect.forever(Queue.take(pending).pipe(Effect.flatMap(write)))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("Provider update journal unavailable", { cause }),
    ),
  );
  // No flush on shutdown: even a stalled filesystem must not hold updates or server shutdown.
  yield* worker.pipe(Effect.forkScoped);

  const record = Effect.fn("ProviderUpdateJournal.record")(
    function* (instanceId: string, driver: string, entry: ProviderUpdateRecord) {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const line = yield* encodeRecord({ timestamp, instanceId, driver, ...entry });
      const bytes = new TextEncoder().encode(`${line}\n`);
      if (bytes.byteLength <= MAX_LINE_BYTES) yield* Queue.offer(pending, bytes);
    },
    (effect) => effect.pipe(Effect.asVoid, Effect.ignoreCause),
  );
  return ProviderUpdateJournal.of({ record });
});

export const layer = Layer.effect(ProviderUpdateJournal, make);
