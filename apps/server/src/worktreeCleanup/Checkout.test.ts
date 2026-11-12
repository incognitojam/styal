import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { fixture, nodeLayer } from "./fixtures.testkit.ts";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import { CheckoutLimits, makeCheckout } from "./Checkout.ts";
import { makeDeletion } from "./Deletion.ts";

it.effect(
  "un-checks-out clean sources, preserving dirty, untracked and ignored files, and restores exactly",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("src/clean.txt", "clean");
      yield* f.write("src/dirty.txt", "original");
      yield* f.write(
        "src/allocated.txt",
        Array.from({ length: 8192 }, (_, i) => `fixture ${i * i}\n`).join(""),
      );
      yield* f.write("src/shared.txt", "shared blocks");
      yield* f.write("src/staged.txt", "original staged file");
      yield* f.write("root-kept.txt", "root file stays");
      yield* f.write("infra/relay/source.txt", "relay source");
      yield* f.write(".vite-hooks/config", "hook configuration");
      yield* f.write(".gitignore", ".scratch/\n.env\ncache/\n.vite-hooks/_/\n");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
      yield* f.command(f.worktree, ["checkout", "-b", "preserved-ref"]);
      yield* f.write("src/dirty.txt", "modified");
      yield* f.write("src/untracked.txt", "untracked");
      yield* f.write(".scratch/note.md", "note");
      yield* f.write(".env", "SYNTHETIC_VALUE=kept");
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      yield* f.write("src/staged.txt", "staged changes");
      yield* f.command(f.worktree, ["add", "src/staged.txt"]);
      yield* Effect.promise(() =>
        physical.link(`${f.worktree}/src/shared.txt`, `${f.base}/shared.txt`),
      );
      const outside = `${f.base}/outside.txt`;
      yield* f.fs.writeFileString(outside, "outside remains");
      yield* Effect.promise(() => physical.symlink(outside, `${f.worktree}/.scratch/link`));
      const otherCheckout = `${f.root}/relay.env`;
      yield* f.fs.writeFileString(otherCheckout, "SYNTHETIC_RELAY=kept");
      yield* Effect.promise(() =>
        physical.symlink(otherCheckout, `${f.worktree}/infra/relay/.env`),
      );
      yield* f.write(".vite-hooks/_/pre-commit", "synthetic hook");
      const buildFiles = Array.from({ length: 2048 }, (_, i) => `src/cache/build-${i}`);
      yield* Effect.forEach(buildFiles, (name) => f.write(name, `synthetic build ${name}`), {
        concurrency: 16,
        discard: true,
      });
      const digest = yield* Digest.Digest;
      const protectedNames = [
        "src/dirty.txt",
        "src/untracked.txt",
        ".env",
        ".scratch/note.md",
        ".scratch/link",
        "infra/relay/.env",
        ".vite-hooks/_/pre-commit",
        ...buildFiles,
      ];
      const hashes = Effect.fn("fixture.protectedHashes")(function* () {
        const result: Record<string, string> = {};
        for (const name of protectedNames) {
          const target = `${f.worktree}/${name}`;
          const stat = yield* Effect.promise(() => physical.lstat(target));
          const content = stat.isSymbolicLink()
            ? new TextEncoder().encode(yield* Effect.promise(() => physical.readlink(target)))
            : yield* Effect.promise(() => physical.readFile(target));
          result[name] =
            `${stat.isSymbolicLink() ? "link" : "file"}:${yield* digest.digestHex(Digest.sha256, content)}`;
        }
        return result;
      });
      const protectedBefore = yield* hashes();
      const head = (yield* f.command(f.worktree, ["rev-parse", "HEAD"])).stdout;
      const branch = (yield* f.command(f.worktree, ["symbolic-ref", "HEAD"])).stdout;
      const index = (yield* f.command(f.worktree, ["ls-files", "--stage", "-z"])).stdout;
      const before = (yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout;
      yield* Effect.gen(function* () {
        using samples = vi.spyOn(physical, "lstat");
        const checkout = yield* makeCheckout;
        const released = yield* checkout.release(f.worktree, f.root);
        expect(
          (yield* f.command(f.worktree, [
            "config",
            "--bool",
            "core.sparseCheckoutCone",
          ])).stdout.trim(),
        ).toBe("false");
        const removed = [
          "src/clean.txt",
          "src/allocated.txt",
          "src/staged.txt",
          "infra/relay/source.txt",
          ".vite-hooks/config",
        ].map((name) => `${f.worktree}/${name}`);
        const allocations = samples.mock.calls.flatMap(([target], i) => {
          const result = samples.mock.settledResults[i];
          return removed.includes(String(target)) && result?.type === "fulfilled"
            ? [Number(result.value.blocks) * 512]
            : [];
        });
        expect(allocations).toHaveLength(5);
        const expectedBytes = allocations.reduce((sum, bytes) => sum + bytes, 0);
        expect(expectedBytes).toBeGreaterThan(0);
        expect(released).toBe(expectedBytes);
        expect((yield* checkout.state(f.worktree))?.estimatedBytes).toBe(expectedBytes);
        expect(yield* f.fs.readFileString(`${f.base}/shared.txt`)).toBe("shared blocks");
        expect(yield* f.fs.readFileString(`${f.worktree}/root-kept.txt`)).toBe("root file stays");
        expect(yield* f.fs.exists(`${f.worktree}/src/clean.txt`)).toBe(false);
        expect(yield* f.fs.readFileString(`${f.worktree}/src/dirty.txt`)).toBe("modified");
        expect(yield* f.fs.readFileString(`${f.worktree}/src/untracked.txt`)).toBe("untracked");
        expect(yield* f.fs.readFileString(`${f.worktree}/.env`)).toBe("SYNTHETIC_VALUE=kept");
        expect(yield* Effect.promise(() => physical.readlink(`${f.worktree}/.scratch/link`))).toBe(
          outside,
        );
        expect(yield* f.fs.readFileString(outside)).toBe("outside remains");
        expect(yield* hashes()).toEqual(protectedBefore);
        expect(yield* f.fs.readFileString(otherCheckout)).toBe("SYNTHETIC_RELAY=kept");
        expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe(
          before,
        );
        yield* checkout.restore(f.worktree);
        expect((yield* f.command(f.worktree, ["rev-parse", "HEAD"])).stdout).toBe(head);
        expect((yield* f.command(f.worktree, ["symbolic-ref", "HEAD"])).stdout).toBe(branch);
        expect((yield* f.command(f.worktree, ["ls-files", "--stage", "-z"])).stdout).toBe(index);
        expect(yield* hashes()).toEqual(protectedBefore);
        expect(yield* f.fs.readFileString(otherCheckout)).toBe("SYNTHETIC_RELAY=kept");
        expect(
          (yield* f.command(f.root, ["config", "extensions.worktreeConfig"])).stdout.trim(),
        ).toBe("true");
        expect(yield* f.fs.readFileString(`${f.worktree}/src/clean.txt`)).toBe("clean");
        expect(yield* f.fs.readFileString(`${f.worktree}/.scratch/note.md`)).toBe("note");
        expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe(
          before,
        );
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each([
  "root",
  "symlink",
  "foreign",
  "cone",
  "non-cone",
  "user-source-patterns",
  "disabled-sparse",
  "assume-unchanged",
  "merge",
  "rebase",
  "cherry-pick",
  "bisect",
  "locked",
  "lfs",
  "submodule",
] as const)("keeps an unsafe checkout: %s", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("src/clean", "content");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
    const admin = (yield* f.command(f.worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    let target = f.worktree;
    let project = f.root;
    if (scenario === "root") target = f.root;
    if (scenario === "symlink") {
      const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
      target = `${f.base}/alias`;
      yield* Effect.promise(() => physical.symlink(f.worktree, target));
    }
    if (scenario === "foreign") {
      project = `${f.base}/foreign`;
      yield* f.fs.makeDirectory(project);
      yield* f.command(project, ["init"]);
    }
    if (scenario === "cone" || scenario === "non-cone" || scenario === "user-source-patterns")
      yield* f.command(f.worktree, [
        "sparse-checkout",
        "set",
        scenario === "cone" ? "--cone" : "--no-cone",
        ...(scenario === "user-source-patterns" ? ["/*", "!/*/"] : ["src"]),
      ]);
    if (scenario === "disabled-sparse") {
      yield* f.fs.makeDirectory(`${admin}/info`, { recursive: true });
      yield* f.fs.writeFileString(`${admin}/info/sparse-checkout`, "/src/\n");
      yield* f.command(f.worktree, ["config", "core.sparseCheckout", "false"]);
    }
    if (scenario === "assume-unchanged")
      yield* f.command(f.worktree, ["update-index", "--assume-unchanged", "src/clean"]);
    const markers = {
      merge: "MERGE_HEAD",
      rebase: "REBASE_HEAD",
      "cherry-pick": "CHERRY_PICK_HEAD",
      bisect: "BISECT_LOG",
      locked: "locked",
    };
    if (scenario in markers)
      yield* f.fs.writeFileString(
        `${admin}/${markers[scenario as keyof typeof markers]}`,
        "fixture",
      );
    if (scenario === "lfs") yield* f.write(".gitattributes", "* filter=lfs\n");
    if (scenario === "submodule") {
      yield* f.command(f.worktree, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        f.root,
        "module",
      ]);
    }
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      expect((yield* checkout.release(target, project).pipe(Effect.result))._tag).toBe("Failure");
      if (scenario === "cone" || scenario === "non-cone" || scenario === "user-source-patterns") {
        const before = (yield* f.command(f.worktree, ["sparse-checkout", "list"])).stdout;
        yield* checkout.restore(f.worktree);
        expect((yield* f.command(f.worktree, ["sparse-checkout", "list"])).stdout).toBe(before);
      }
      if (scenario === "user-source-patterns")
        expect(yield* f.fs.exists(`${f.worktree}/src/clean`)).toBe(false);
      else expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("content");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each([
  "staged",
  "moved-branch",
  "deleted-branch",
  "created-file",
  "detached",
  "symlink",
  "unmerged",
  "unmerged-delete",
] as const)("preserves changes across release and restore: %s", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("src/clean", "original");
    yield* f.write("docs/clean", "source");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
    if (scenario !== "detached") yield* f.command(f.worktree, ["checkout", "-b", "feature"]);
    if (scenario === "staged") {
      yield* f.write("src/clean", "staged");
      yield* f.command(f.worktree, ["add", "."]);
    }
    if (scenario === "symlink") {
      yield* f.fs.remove(`${f.worktree}/src/clean`);
      yield* f.fs.symlink("../.gitignore", `${f.worktree}/src/clean`);
    }
    if (scenario === "unmerged" || scenario === "unmerged-delete") {
      if (scenario === "unmerged-delete") yield* f.command(f.worktree, ["rm", "src/clean"]);
      else yield* f.write("src/clean", "stashed");
      yield* f.command(f.worktree, ["stash"]);
      yield* f.write("src/clean", "conflict");
      yield* f.command(f.worktree, ["commit", "-am", "fixture: conflicting change"]);
      const pop = yield* f.git.execute({
        operation: "fixture",
        cwd: f.worktree,
        args: ["stash", "pop"],
        allowNonZeroExit: true,
      });
      expect(pop.exitCode).toBe(1);
    }
    const contentBefore = yield* f.fs.readFileString(`${f.worktree}/src/clean`);
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      yield* checkout.release(f.worktree, f.root);
      if (scenario === "moved-branch")
        yield* f.command(f.root, ["update-ref", "refs/heads/feature", "main"]);
      if (scenario === "deleted-branch")
        yield* f.command(f.root, ["update-ref", "-d", "refs/heads/feature"]);
      if (scenario === "created-file") yield* f.write("src/clean", "new edit");
      const status = (yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout;
      yield* checkout.restore(f.worktree);
      expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe(
        status,
      );
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe(
        scenario === "created-file" ? "new edit" : contentBefore,
      );
      if (scenario === "symlink")
        expect(yield* f.fs.readLink(`${f.worktree}/src/clean`)).toBe("../.gitignore");
      expect(yield* f.fs.readFileString(`${f.worktree}/docs/clean`)).toBe("source");
      if (scenario === "detached") {
        const head = yield* f.git.execute({
          operation: "fixture",
          cwd: f.worktree,
          args: ["symbolic-ref", "-q", "HEAD"],
          allowNonZeroExit: true,
        });
        expect(head.exitCode).toBe(1);
      }
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each(["ignored", "untracked", "regenerable"] as const)(
  "accepts removal of a local file after a verified release, including another recovery stop: %s",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("src/clean", "source");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
      const target =
        kind === "ignored" ? ".scratch/note" : kind === "untracked" ? "note" : "dist/output";
      yield* f.write(target, "local");
      yield* Effect.gen(function* () {
        const checkout = yield* makeCheckout;
        yield* checkout.release(f.worktree, f.root);
        if (kind === "regenerable") {
          const deletion = yield* makeDeletion;
          const selected = yield* deletion.inspect(f.worktree, ["dist/"]);
          expect(selected).toEqual([`${f.worktree}/dist`]);
          for (const path of selected) yield* deletion.remove(f.worktree, path);
        } else yield* f.fs.remove(`${f.worktree}/${target}`);
        const stopped = yield* makeCheckout.pipe(
          Effect.provideService(CheckoutLimits, {
            entries: 100_000,
            bytes: 1_000_000,
            step: (step) => (step === "restore-recorded" ? Effect.die("stop") : Effect.void),
          }),
        );
        yield* stopped.restore(f.worktree).pipe(Effect.exit);
        yield* checkout.restore(f.worktree);
        expect(yield* f.fs.exists(`${f.worktree}/${target}`)).toBe(false);
        expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("source");
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each([
  "release-journal-written",
  "release-journal-renamed",
  "release-journal-durable",
  "released-journal-written",
  "released-journal-renamed",
  "released-journal-durable",
  "restore-journal-written",
  "restore-journal-renamed",
  "restore-journal-durable",
  "release-recorded",
  "release-set",
  "release-finished",
  "restore-recorded",
  "restore-disabled",
  "restore-finished",
])("recovers after a stop at %s", (stopped) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("src/clean", "original");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
    yield* f.write("src/dirty", "keep");
    yield* f.write(".scratch/note", "before stop");
    yield* Effect.gen(function* () {
      const normal = yield* makeCheckout;
      const interrupted = yield* makeCheckout.pipe(
        Effect.provideService(CheckoutLimits, {
          entries: 100_000,
          bytes: 1_000_000,
          step: (step) => (step === stopped ? Effect.die("simulated stop") : Effect.void),
        }),
      );
      if (stopped.startsWith("release"))
        yield* interrupted.release(f.worktree, f.root).pipe(Effect.exit);
      else {
        yield* normal.release(f.worktree, f.root);
        yield* interrupted.restore(f.worktree).pipe(Effect.exit);
      }
      yield* f.write(".scratch/note", "edited after stop");
      yield* normal.restore(f.worktree);
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("original");
      expect(yield* f.fs.readFileString(`${f.worktree}/src/dirty`)).toBe("keep");
      expect(yield* f.fs.readFileString(`${f.worktree}/.scratch/note`)).toBe("edited after stop");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each([
  "exit",
  "error",
  "timeout",
  "stdout-limit",
  "stderr-limit",
  "unterminated-list",
  "file-limit",
  "protected-file-limit",
  "byte-limit",
  "windows",
] as const)("fails closed before mutation: %s", (failure) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const platform = yield* HostProcess.Platform;
    yield* f.write("src/clean", "original");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    yield* f.write(".scratch/note", "protected");
    if (failure === "protected-file-limit") {
      yield* f.write(".scratch/second", "protected");
      yield* f.write(".scratch/third", "protected");
    }
    const driver = GitVcsDriver.GitVcsDriver.of({
      ...f.git,
      execute: (input) => {
        if (!input.args.includes("status")) return f.git.execute(input);
        if (failure === "error" || failure === "timeout")
          return Effect.fail(
            new GitCommandError({
              operation: "fixture",
              command: "git status",
              cwd: input.cwd,
              detail: failure === "timeout" ? "Timed out" : "Synthetic failure",
            }),
          );
        return f.git.execute(input).pipe(
          Effect.map((result) => ({
            ...result,
            ...(failure === "exit" ? { exitCode: 1 as typeof result.exitCode } : {}),
            ...(failure === "stdout-limit" ? { stdoutTruncated: true } : {}),
            ...(failure === "stderr-limit" ? { stderrTruncated: true } : {}),
            ...(failure === "unterminated-list" ? { stdout: " M src/clean" } : {}),
          })),
        );
      },
    });
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      const result = yield* checkout.release(f.worktree, f.root).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("original");
      expect(yield* f.fs.readFileString(`${f.worktree}/.scratch/note`)).toBe("protected");
      expect((yield* f.command(f.worktree, ["ls-files", "-t", "-z"])).stdout).not.toContain("S ");
    }).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      Effect.provideService(CheckoutLimits, {
        entries: failure === "file-limit" ? 1 : failure === "protected-file-limit" ? 2 : 100_000,
        bytes: failure === "byte-limit" ? 0 : 1_000_000,
      }),
      Effect.provideService(HostProcess.Platform, failure === "windows" ? "win32" : platform),
    );
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect("undoes an un-checkout when verification returns different status", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("src/clean", "original");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    let statusReads = 0;
    const driver = GitVcsDriver.GitVcsDriver.of({
      ...f.git,
      execute: (input) =>
        f.git
          .execute(input)
          .pipe(
            Effect.map((result) =>
              input.args.includes("status") && ++statusReads === 2
                ? { ...result, stdout: "?? unexpected\0" }
                : result,
            ),
          ),
    });
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      expect((yield* checkout.release(f.worktree, f.root).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("original");
      expect((yield* f.command(f.worktree, ["ls-files", "-t", "-z"])).stdout).not.toContain("S ");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect(
  "retains recovery state and fails loudly when a protected file changes during restore",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("src/clean", "original");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
      yield* f.write(".scratch/note", "protected");
      const admin = (yield* f.command(f.worktree, [
        "rev-parse",
        "--absolute-git-dir",
      ])).stdout.trim();
      yield* Effect.gen(function* () {
        const normal = yield* makeCheckout;
        yield* normal.release(f.worktree, f.root);
        const modified = yield* makeCheckout.pipe(
          Effect.provideService(CheckoutLimits, {
            entries: 100_000,
            bytes: 1_000_000,
            step: (step) =>
              step === "restore-disabled"
                ? f.write(".scratch/note", "changed during restore").pipe(Effect.orDie)
                : Effect.void,
          }),
        );
        const result = yield* modified.restore(f.worktree).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.message).toContain("differ");
        expect(yield* f.fs.exists(`${admin}/styal-checkout.json`)).toBe(true);
        expect(yield* f.fs.readFileString(`${f.worktree}/.scratch/note`)).toBe(
          "changed during restore",
        );
        yield* f.write(".scratch/note", "protected");
        yield* normal.restore(f.worktree);
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each(
  [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--absolute-git-dir"],
    ["rev-parse", "--git-common-dir"],
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["symbolic-ref", "--quiet", "HEAD"],
    ["config", "--bool", "core.sparseCheckout"],
    ["ls-files", "-v", "-z"],
    ["submodule", "status", "--recursive"],
    ["check-attr", "-z", "--stdin", "filter"],
    ["ls-files", "-z"],
    ["check-attr", "--cached", "-z", "--stdin", "filter"],
    ["ls-files", "--stage", "-z"],
    ["diff-files", "--name-only", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ].map((args) => ({ args })),
)("keeps checkout when inspection fails at $args", ({ args }) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("src/clean", "original");
    yield* f.write(".gitattributes", "*.txt text\n");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    let failed = false;
    const driver = GitVcsDriver.GitVcsDriver.of({
      ...f.git,
      execute: (input) => {
        if (input.args.slice(2).join("\0") !== args.join("\0")) return f.git.execute(input);
        failed = true;
        return Effect.fail(
          new GitCommandError({
            operation: "fixture",
            command: "git",
            cwd: input.cwd,
            detail: "Synthetic inspection failure",
          }),
        );
      },
    });
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      expect((yield* checkout.release(f.worktree, f.root).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(failed).toBe(true);
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("original");
      expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe("");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each(["nested-ignored", "nested-ignored-case", "deleted"] as const)(
  "preserves nested ignored files and refuses unstaged deletions: %s",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("src/clean", "source");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
      const directory = scenario === "nested-ignored-case" ? "SRC" : "src";
      if (scenario !== "deleted") yield* f.write(`${directory}/cache/local`, "irreplaceable");
      else yield* f.fs.remove(`${f.worktree}/src/clean`);
      const before = (yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout;
      yield* Effect.gen(function* () {
        const checkout = yield* makeCheckout;
        expect((yield* checkout.release(f.worktree, f.root).pipe(Effect.result))._tag).toBe(
          scenario === "deleted" ? "Failure" : "Success",
        );
        if (scenario !== "deleted")
          expect(yield* f.fs.readFileString(`${f.worktree}/${directory}/cache/local`)).toBe(
            "irreplaceable",
          );
        else expect(yield* f.fs.exists(`${f.worktree}/src/clean`)).toBe(false);
        expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe(
          before,
        );
        yield* checkout.restore(f.worktree);
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each([
  "new-file",
  "obstruction",
  "ignored-obstruction",
  "symlink-obstruction",
  "recreated-source",
] as const)("recovery can finish after a filesystem change: %s", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write("docs/source", "source");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: sources"]);
    yield* f.write(".scratch/note", "protected");
    yield* Effect.gen(function* () {
      const normal = yield* makeCheckout;
      if (scenario === "new-file") {
        const stopped = yield* makeCheckout.pipe(
          Effect.provideService(CheckoutLimits, {
            entries: 100_000,
            bytes: 1_000_000,
            step: (step) => (step === "release-set" ? Effect.die("stop") : Effect.void),
          }),
        );
        yield* stopped.release(f.worktree, f.root).pipe(Effect.exit);
        yield* f.write("new-note", "new");
      } else {
        yield* normal.release(f.worktree, f.root);
        const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
        if (scenario === "symlink-obstruction")
          yield* Effect.promise(() => physical.symlink("absent-target", `${f.worktree}/docs`));
        else yield* f.write("docs", "obstruction");
        if (scenario === "ignored-obstruction") {
          const admin = (yield* f.command(f.worktree, [
            "rev-parse",
            "--absolute-git-dir",
          ])).stdout.trim();
          yield* f.fs.writeFileString(`${admin}/../../info/exclude`, "/docs\n");
        }
        for (const _attempt of [1, 2, 3]) {
          const result = yield* normal.restore(f.worktree).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.message).toContain("docs");
          if (scenario === "symlink-obstruction")
            expect(yield* Effect.promise(() => physical.readlink(`${f.worktree}/docs`))).toBe(
              "absent-target",
            );
          else expect(yield* f.fs.readFileString(`${f.worktree}/docs`)).toBe("obstruction");
        }
        yield* f.fs.rename(`${f.worktree}/docs`, `${f.worktree}/moved-note`);
        if (scenario === "recreated-source") {
          const racing = yield* makeCheckout.pipe(
            Effect.provideService(CheckoutLimits, {
              entries: 100_000,
              bytes: 1_000_000,
              step: (step) =>
                step === "restore-recorded"
                  ? f.write("docs/source", "new edit").pipe(Effect.orDie)
                  : Effect.void,
            }),
          );
          yield* racing.restore(f.worktree).pipe(Effect.result);
          expect(yield* f.fs.readFileString(`${f.worktree}/docs/source`)).toBe("new edit");
        }
      }
      yield* normal.restore(f.worktree);
      expect(yield* f.fs.readFileString(`${f.worktree}/docs/source`)).toBe(
        scenario === "recreated-source" ? "new edit" : "source",
      );
      expect(yield* f.fs.readFileString(`${f.worktree}/.scratch/note`)).toBe("protected");
      if (scenario === "symlink-obstruction") {
        const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
        expect(yield* Effect.promise(() => physical.readlink(`${f.worktree}/moved-note`))).toBe(
          "absent-target",
        );
      } else
        expect(
          yield* f.fs.readFileString(
            `${f.worktree}/${scenario === "new-file" ? "new-note" : "moved-note"}`,
          ),
        ).toBe(scenario === "new-file" ? "new" : "obstruction");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect.each(
  ["release-recorded", "release-set", "restore-recorded", "restore-disabled"].flatMap((stopped) =>
    [".gitignore", "src/dirty"].map((target) => ({ stopped, target })),
  ),
)(
  "refuses a new deletion of $target after a stop at $stopped without resurrecting it",
  ({ stopped, target }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.write("src/clean", "source");
      yield* f.write("src/dirty", "original");
      yield* f.command(f.worktree, ["add", "."]);
      yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
      yield* f.write("src/dirty", "local edit");
      yield* Effect.gen(function* () {
        const normal = yield* makeCheckout;
        const interrupted = yield* makeCheckout.pipe(
          Effect.provideService(CheckoutLimits, {
            entries: 100_000,
            bytes: 1_000_000,
            step: (step) => (step === stopped ? Effect.die("stop") : Effect.void),
          }),
        );
        if (stopped.startsWith("release"))
          yield* interrupted.release(f.worktree, f.root).pipe(Effect.exit);
        else {
          yield* normal.release(f.worktree, f.root);
          yield* interrupted.restore(f.worktree).pipe(Effect.exit);
        }
        yield* f.fs.remove(`${f.worktree}/${target}`);
        const status = (yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout;
        for (const _attempt of [1, 2]) {
          const result = yield* normal.restore(f.worktree).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.message).toContain(target);
          expect(yield* f.fs.exists(`${f.worktree}/${target}`)).toBe(false);
          expect((yield* f.command(f.worktree, ["status", "--porcelain=v1", "-z"])).stdout).toBe(
            status,
          );
        }
        yield* f.command(f.worktree, ["rm", "--cached", "--sparse", "--", target]);
        yield* normal.restore(f.worktree);
        expect(yield* f.fs.exists(`${f.worktree}/${target}`)).toBe(false);
        expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("source");
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
    }).pipe(Effect.provide(nodeLayer)),
);

it.effect("keeps sources when the recovery directory cannot be synced", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const physical = yield* PhysicalFileSystem.PhysicalFileSystem;
    yield* f.write("src/clean", "source");
    yield* f.command(f.worktree, ["add", "."]);
    yield* f.command(f.worktree, ["commit", "-m", "fixture: source"]);
    const admin = (yield* f.command(f.worktree, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    yield* Effect.gen(function* () {
      const normal = yield* makeCheckout;
      const unsynced = yield* makeCheckout.pipe(
        Effect.provideService(
          PhysicalFileSystem.PhysicalFileSystem,
          PhysicalFileSystem.PhysicalFileSystem.of({
            ...physical,
            open: (target, flags, mode) =>
              target === admin
                ? Promise.reject(new Error("directory sync unavailable"))
                : physical.open(target, flags, mode),
          }),
        ),
      );
      expect((yield* unsynced.release(f.worktree, f.root).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("source");
      yield* normal.restore(f.worktree);
      expect(yield* f.fs.readFileString(`${f.worktree}/src/clean`)).toBe("source");
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);

it.effect("roots a missing worktree at its own path inside an enclosing checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const missing = `${f.worktree}/nested/feature`;
    yield* Effect.gen(function* () {
      const checkout = yield* makeCheckout;
      expect(yield* checkout.root(missing)).toBe(f.worktree);
      expect(yield* checkout.root(missing, { worktree: true })).toBe(missing);
      expect(yield* checkout.root(f.worktree, { worktree: true })).toBe(f.worktree);
    }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, f.git));
  }).pipe(Effect.provide(nodeLayer)),
);
