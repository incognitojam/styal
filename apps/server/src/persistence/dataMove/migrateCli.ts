// @effect-diagnostics globalJsonInEffect:off - Only aggregate reports are encoded at this CLI boundary.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import { migrate } from "./migrate.ts";
import { PreflightRefusal } from "./preflight.ts";

const isRefusal = Schema.is(PreflightRefusal);
const command = Command.make(
  "data-move:migrate",
  {
    copy: Argument.String("explicit-offline-copy-path"),
    verify: Flag.Boolean("verify").pipe(Flag.withDefault(false)),
  },
  ({ copy, verify }) =>
    migrate(copy, verify).pipe(
      Effect.flatMap((report) => Console.log(JSON.stringify(report, null, 2))),
    ),
);

if (import.meta.main) {
  Command.run(command, { version: "1", renderErrors: false }).pipe(
    Effect.tapCause((cause) => {
      const error = Cause.squash(cause);
      return Console.error(
        JSON.stringify({ refused: isRefusal(error) ? error.category : "migration-failed" }),
      );
    }),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
