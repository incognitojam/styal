// @effect-diagnostics globalJsonInEffect:off -- The CLI emits only aggregate refusal categories.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Console from "effect/Console";
import { Argument, Command } from "effect/cli";
import { rehearse } from "./rehearse.ts";
import { PreflightRefusal } from "./preflight.ts";

const isRefusal = Schema.is(PreflightRefusal);
const command = Command.make(
  "data-move:rehearse",
  { copy: Argument.String("explicit-moved-rehearsal-copy") },
  ({ copy }) =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const architecture = yield* HostProcess.Architecture;
      const environment = yield* HostProcess.Environment;
      return yield* Effect.tryPromise({
        try: () =>
          rehearse(copy, {
            platform,
            architecture,
            chromiumExecutable: environment.STYAL_REHEARSAL_CHROMIUM,
          }),
        catch: (error) =>
          isRefusal(error) ? error : new PreflightRefusal({ category: "rehearsal-failed" }),
      });
    }),
);

if (import.meta.main) {
  // The native launcher owns signals until the namespace and its children exit.
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: "1", renderErrors: false }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause);
    await Effect.runPromise(
      Console.error(
        JSON.stringify({
          refused: isRefusal(error) ? error.category : "rehearsal-failed",
        }),
      ),
    );
    process.exitCode = 1;
  }
}
