import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect(
  "--fix reclaims space with the service paused and never offers or deletes the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const printed: string[] = [];
      const doctor = (options: {
        fix: boolean;
        dryRun: boolean;
        interactive: boolean;
        reclaimableBytes: number;
      }) =>
        runDoctor("/test/statev2.sqlite", options).pipe(
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args: ReadonlyArray<unknown>) => {
              printed.push(args.join(" "));
            },
          }),
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance, {
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: options.reclaimableBytes,
                    incrementalVacuumEnabled: options.reclaimableBytes === 0,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  Effect.sync(() => {
                    calls.push("compact");
                    return {
                      beforeBytes: 2000,
                      afterBytes: 1000,
                      deletedEventCount: 1,
                      deletedReceiptCount: 0,
                    };
                  }),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor({ fix: true, dryRun: true, interactive: false, reclaimableBytes: 1000 });
      assert.deepEqual(calls, []);
      assert.include(printed.join("\n"), "Database from 0.1.0 or earlier: 4 KiB");
      assert.notInclude(printed.join("\n"), "Delete the database");
      yield* doctor({ fix: true, dryRun: false, interactive: false, reclaimableBytes: 1000 });
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
      // With only the V1 database present, the interactive prompt has nothing to offer.
      printed.length = 0;
      yield* doctor({ fix: false, dryRun: false, interactive: true, reclaimableBytes: 0 });
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
      assert.include(printed, "Nothing to repair.");
    }),
);
