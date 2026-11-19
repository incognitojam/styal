// @effect-diagnostics-next-line nodeBuiltinImport:off -- Windows probe synchronizes with a FileShare.None lock holder.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeCheckout } from "./Checkout.ts";
import { makeDeletion } from "./Deletion.ts";

it.effect.each(["default", "autocrlf", "readonly", "longpath", "case", "junction", "locked"])(
  "experiment hazard: %s",
  (mode) =>
    Effect.gen(function* () {
      if ((mode === "case" || mode === "locked") && (yield* HostProcess.Platform) !== "win32")
        return;
      const f = yield* fixture;
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      if (mode === "autocrlf") yield* f.command(f.worktree, ["config", "core.autocrlf", "true"]);
      if (mode === "longpath") yield* f.command(f.worktree, ["config", "core.longpaths", "true"]);
      yield* f.write("src/source.txt", "source\nsecond line\n");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
      if (mode === "autocrlf") yield* f.command(f.worktree, ["checkout-index", "--all", "--force"]);
      if (mode === "readonly") yield* f.fs.chmod(`${f.worktree}/src/source.txt`, 0o444);
      yield* f.write(
        `node_modules/${mode === "longpath" ? "nested-package/".repeat(24) : "pkg/"}output`,
        "regenerable",
      );
      if (mode === "readonly") yield* f.fs.chmod(`${f.worktree}/node_modules/pkg/output`, 0o444);
      const outside = `${f.base}/outside`;
      yield* f.fs.makeDirectory(outside);
      yield* f.fs.writeFileString(`${outside}/sentinel`, "untouched");
      if (mode === "junction")
        yield* Effect.promise(() =>
          physical.symlink(outside, `${f.worktree}/node_modules/linked`, "junction"),
        );
      if (mode === "locked") {
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
                const child = NodeChildProcess.spawn(
                  "pwsh",
                  [
                    "-NoProfile",
                    "-Command",
                    "$f = [IO.File]::Open($env:LOCK_FILE, 'Open', 'ReadWrite', 'None'); [Console]::WriteLine('ready'); [Console]::In.ReadLine(); $f.Dispose()",
                  ],
                  {
                    env: { ...process.env, LOCK_FILE: `${f.worktree}/node_modules/pkg/output` },
                    stdio: ["pipe", "pipe", "inherit"],
                  },
                );
                child.once("error", reject);
                child.stdout!.once("data", () => resolve(child));
                child.once("exit", (code) => {
                  if (code !== 0) reject(new Error(`Lock holder exited ${code}`));
                });
              }),
          ),
          (child) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  child.once("exit", () => resolve());
                  child.stdin!.end("done\n");
                }),
            ),
        );
      }
      const target = mode === "case" ? f.worktree.toUpperCase() : f.worktree;
      const deletion = yield* makeDeletion.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      const inspected = yield* deletion.inspect(target, ["node_modules"]).pipe(Effect.result);
      yield* Effect.log("EXPERIMENT", mode, "inspect", inspected);
      if (inspected._tag === "Success") {
        for (const entry of inspected.success) {
          yield* Effect.log(
            "EXPERIMENT",
            mode,
            "remove",
            yield* deletion.remove(target, entry).pipe(Effect.result),
          );
        }
      }
      expect(yield* f.fs.readFileString(`${outside}/sentinel`)).toBe("untouched");
      const checkout = yield* makeCheckout.pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, f.git),
      );
      const released = yield* checkout.release(target, f.root).pipe(Effect.result);
      yield* Effect.log("EXPERIMENT", mode, "release", released);
      yield* Effect.log(
        "EXPERIMENT",
        mode,
        "source-present-after-release",
        yield* f.fs.exists(`${f.worktree}/src/source.txt`),
      );
      yield* Effect.log(
        "EXPERIMENT",
        mode,
        "worktreeConfig",
        (yield* f.command(f.worktree, ["config", "--get", "extensions.worktreeConfig"])).stdout,
      );
      yield* Effect.log(
        "EXPERIMENT",
        mode,
        "restore",
        yield* checkout.restore(target).pipe(Effect.result),
      );
      if (mode === "default" || mode === "autocrlf" || mode === "readonly") {
        yield* f.command(f.worktree, ["config", "extensions.worktreeConfig", "true"]);
        yield* f.command(f.worktree, ["sparse-checkout", "init", "--no-cone"]);
        yield* f.git.execute({
          operation: "fixture",
          cwd: f.worktree,
          args: ["sparse-checkout", "set", "--no-cone", "--stdin"],
          stdin: "/*\n!/*/\n",
        });
        yield* Effect.log(
          "EXPERIMENT",
          mode,
          "direct-git-source-present",
          yield* f.fs.exists(`${f.worktree}/src/source.txt`),
        );
        yield* f.command(f.worktree, ["sparse-checkout", "disable"]);
        yield* Effect.log(
          "EXPERIMENT",
          mode,
          "direct-git-status-after-restore",
          (yield* f.command(f.worktree, ["status", "--porcelain=v1"])).stdout,
        );
      }
      expect(
        (yield* f.fs.readFileString(`${f.worktree}/src/source.txt`)).replaceAll("\r\n", "\n"),
      ).toBe("source\nsecond line\n");
      expect(yield* f.fs.readFileString(`${outside}/sentinel`)).toBe("untouched");
    }).pipe(Effect.provide(nodeLayer)),
);
