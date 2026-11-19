// @effect-diagnostics nodeBuiltinImport:off - Exercises the archive helper against real HTTP responses.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";
import { sshHelperCommand } from "./sshHelper.ts";

it.live.each(["copying", "ready-only", "expired", "unrelated"] as const)(
  "archive readiness helper hands off only a live copy: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Effect.acquireDisposable(
          Effect.promise(async () => {
            const server = NodeHttp.createServer((_, response) => {
              response.writeHead(503, { "content-type": "application/json" });
              response.end(
                JSON.stringify(
                  mode === "unrelated"
                    ? {}
                    : {
                        starting: true,
                        copy: {
                          phase: "copying",
                          copiedBytes: 1,
                          totalBytes: 100,
                          leaseMs: mode === "expired" ? 0 : 60000,
                        },
                      },
                ),
              );
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
        );
        const address = server.address();
        assert.isTrue(address !== null && typeof address === "object");
        if (address === null || typeof address !== "object") throw new Error("missing listener");
        const previous = process.exitCode;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            process.exitCode = previous;
          }),
        );
        process.exitCode = 0;
        yield* Command.runWith(sshHelperCommand, { version: "0.0.0" })([
          "wait-ready",
          String(address.port),
          "100",
          "1000",
          ...(mode === "ready-only" ? ["--ready-only"] : []),
        ]).pipe(Effect.provide(NodeServices.layer));
        assert.equal(process.exitCode, mode === "copying" ? 0 : 1);
      }),
    ),
);
