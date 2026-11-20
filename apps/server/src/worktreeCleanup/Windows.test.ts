import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeCheckout } from "./Checkout.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

it.effect("Windows source refusal preserves files and ordinary worktree operations", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const f = yield* fixture;
    const descriptor = yield* Effect.gen(function* () {
      return yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
    }).pipe(
      Effect.provide(
        ServerEnvironment.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), f.base)),
        ),
      ),
    );
    expect(yield* HostProcess.Platform).toBe("win32");
    expect(descriptor.platform.os).toBe("windows");
    yield* f.write("src/ordinary.txt", "original\n");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: ordinary"]);
    yield* f.write("dist/ignored", "ignored");
    const before = (yield* f.command(f.worktree, ["status", "--porcelain=v1"])).stdout;
    const checkout = yield* makeCheckout.pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
    );
    const refusal = yield* checkout.release(f.worktree, f.root).pipe(Effect.flip);
    expect(refusal.message).toBe("Worktree source cleanup is unavailable on Windows.");
    expect(yield* f.fs.readFileString(`${f.worktree}/src/ordinary.txt`)).toBe("original\n");
    expect(yield* f.fs.readFileString(`${f.worktree}/dist/ignored`)).toBe("ignored");
    expect((yield* f.command(f.worktree, ["status", "--porcelain=v1"])).stdout).toBe(before);
    expect(yield* checkout.state(f.worktree)).toBeNull();
    yield* checkout.restore(f.worktree);
    yield* f.write("src/ordinary.txt", "edited\n");
    expect((yield* f.command(f.worktree, ["status", "--porcelain=v1"])).stdout).toContain(
      "src/ordinary.txt",
    );
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: ordinary edit"]);
    expect((yield* f.command(f.worktree, ["status", "--porcelain=v1"])).stdout).toBe("");
  }).pipe(Effect.provide(nodeLayer), Effect.scoped),
);
