import { makeAsyncRotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  // Keep low-volume update history independent of trace rotation.
  const sink = yield* makeAsyncRotatingFileSink({
    filePath: path.join(config.logsDir, "provider-updates.ndjson"),
    maxBytes: 1024 * 1024,
    maxFiles: 4,
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning("Provider update journal unavailable").pipe(Effect.as(null)),
    ),
  );
  const record = Effect.fn("ProviderUpdateJournal.record")(
    function* (instanceId: string, driver: string, entry: ProviderUpdateRecord) {
      if (sink === null) return;
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const line = yield* encodeRecord({
        timestamp,
        instanceId,
        driver,
        ...entry,
      });
      yield* sink.write(`${line}\n`);
    },
    Effect.catchCause(() => Effect.logWarning("Provider update journal write failed")),
  );
  return ProviderUpdateJournal.of({ record });
});

export const layer = Layer.effect(ProviderUpdateJournal, make);
