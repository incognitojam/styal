import { WorktreeCleanupError } from "@t3tools/contracts";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeInspectGit } from "./gitInspection.ts";

export class CheckoutLimits extends Context.Reference<{
  readonly entries: number;
  readonly bytes: number;
  readonly step?: (step: string) => Effect.Effect<void>;
}>("worktreeCleanup/CheckoutLimits", {
  defaultValue: () => ({ entries: 100_000, bytes: 1_073_741_824 }),
}) {}

const Journal = Schema.Struct({
  bytes: Schema.optionalKey(Schema.Number),
  availableBefore: Schema.optionalKey(Schema.Number),
  availableAfter: Schema.optionalKey(Schema.Number),
  phase: Schema.Literals(["releasing", "released", "restoring"]),
  status: Schema.String,
  index: Schema.String,
  files: Schema.Record(Schema.String, Schema.String),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Journal));
const encode = Schema.encodeEffect(Schema.fromJsonString(Journal));

export const makeCheckout = Effect.gen(function* () {
  const fs = yield* PhysicalFileSystem.PhysicalFileSystem;
  const crypto = yield* Digest.Digest;
  const path = yield* Path.Path;
  const git = yield* makeInspectGit;
  const limits = yield* CheckoutLimits;
  const platform = yield* HostProcess.Platform;
  const fail = (message: string) => new WorktreeCleanupError({ reason: "run-failed", message });
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () =>
        new WorktreeCleanupError({
          reason: "run-failed",
          message: "Worktree checkout verification failed; the workspace must not be used.",
        }),
    });
  const command = Effect.fn("WorktreeCleanup.checkoutGit")(function* (
    root: string,
    args: readonly string[],
    allowed = [0],
    stdin?: string,
  ) {
    const result = yield* git(root, args, stdin).pipe(
      Effect.mapError(() => fail("Git could not complete worktree checkout verification.")),
    );
    if (!allowed.includes(result.exitCode) || result.stdoutTruncated || result.stderrTruncated)
      return yield* fail("Git checkout check failed or returned incomplete output.");
    return result.stdout;
  });
  const adminDirectory = Effect.fn("WorktreeCleanup.checkoutAdmin")(function* (root: string) {
    const file = path.join(root, ".git");
    const stat = yield* io(() =>
      fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    if (!stat?.isFile()) return null;
    const text = yield* io(() => fs.readFile(file, "utf8"));
    if (!text.startsWith("gitdir: ") || !text.endsWith("\n"))
      return yield* fail("Invalid worktree gitfile.");
    return path.resolve(root, text.slice(8).trimEnd());
  });
  const identity = Effect.fn("WorktreeCleanup.checkoutIdentity")(function* (
    root: string,
    admin: string,
  ) {
    const actual = yield* io(() => fs.realpath(root));
    const stat = yield* io(() => fs.lstat(root));
    if (actual !== root || !stat.isDirectory() || stat.isSymbolicLink())
      return yield* fail("Worktree path is an alias or is not a directory.");
    if (
      (yield* command(root, ["rev-parse", "--show-toplevel"])).trimEnd() !== root ||
      (yield* command(root, ["rev-parse", "--absolute-git-dir"])).trimEnd() !== admin ||
      (yield* io(() => fs.readFile(path.join(admin, "gitdir"), "utf8"))).trimEnd() !==
        path.join(root, ".git")
    )
      return yield* fail("Worktree registration does not match this folder.");
  });
  const snapshot = Effect.fn("WorktreeCleanup.checkoutSnapshot")(function* (root: string) {
    const status = yield* command(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const index = yield* command(root, ["ls-files", "--stage", "-z"]);
    const dirty = yield* command(root, ["diff-files", "--name-only", "-z"]);
    const others = yield* command(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const ignored = yield* command(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    for (const list of [status, index, dirty, others, ignored])
      if (list && !list.endsWith("\0")) return yield* fail("Incomplete worktree file list.");
    const names = [...new Set(`${dirty}${others}${ignored}`.split("\0").filter(Boolean))];
    if (names.length > limits.entries)
      return yield* fail("Worktree checkout inspection exceeded its file limit.");
    const files: Record<string, string> = Object.create(null);
    let bytes = 0;
    for (const name of names) {
      if (path.isAbsolute(name) || name.split("/").some((part) => part === ".." || part === ".git"))
        return yield* fail("Unsafe worktree file path.");
      const target = path.join(root, name);
      if ((yield* io(() => fs.realpath(path.dirname(target)))) !== path.dirname(target))
        return yield* fail("Worktree file has a symlinked parent.");
      const stat = yield* io(() =>
        fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        }),
      );
      if (stat === null) {
        files[name] = "missing";
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink())
        return yield* fail("Worktree contains a special file or nested repository.");
      bytes += stat.size;
      if (bytes > limits.bytes || stat.size > 64 * 1024 * 1024)
        return yield* fail("Worktree checkout inspection exceeded its byte limit.");
      const content = stat.isSymbolicLink()
        ? new TextEncoder().encode(yield* io(() => fs.readlink(target)))
        : yield* io(() => fs.readFile(target));
      const hash = yield* crypto
        .digest(Digest.sha256, content)
        .pipe(Effect.mapError(() => fail("Could not hash protected worktree files.")));
      files[name] =
        `${stat.isSymbolicLink() ? "link" : stat.mode}:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    return { status, index, files };
  });
  const verify = Effect.fn("WorktreeCleanup.verifyCheckout")(function* (
    root: string,
    before: Omit<typeof Journal.Type, "phase">,
  ) {
    const after = yield* snapshot(root);
    if (
      before.status !== after.status ||
      before.index !== after.index ||
      Object.entries(before.files).some(([name, hash]) => after.files[name] !== hash)
    )
      return yield* fail(
        "Worktree changes differ after checkout; recovery is required before using the workspace.",
      );
  });
  const journalPath = (admin: string) => path.join(admin, "styal-checkout.json");
  const save = Effect.fn("WorktreeCleanup.saveCheckout")(function* (
    admin: string,
    value: typeof Journal.Type,
  ) {
    const text = yield* encode(value);
    yield* io(async () => {
      const temporary = `${journalPath(admin)}.new`;
      const handle = await fs.open(temporary, "w", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, journalPath(admin));
    });
  });
  const step = (name: string) => limits.step?.(name) ?? Effect.void;
  const restore = Effect.fn("WorktreeCleanup.restoreCheckout")(function* (root: string) {
    const admin = yield* adminDirectory(root);
    if (admin === null) return;
    const raw = yield* io(() =>
      fs.readFile(journalPath(admin), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    if (raw === null) return;
    const journal = yield* decode(raw).pipe(
      Effect.mapError(() => fail("Invalid worktree checkout recovery record.")),
    );
    yield* identity(root, admin);
    // A released tree may have acquired new edits; interrupted mutations retain their original comparison.
    const before = journal.phase === "released" ? yield* snapshot(root) : journal;
    yield* save(admin, { ...before, phase: "restoring" });
    yield* step("restore-recorded");
    yield* command(root, ["sparse-checkout", "disable"]);
    yield* step("restore-disabled");
    yield* verify(root, before);
    const tracked = (yield* command(root, ["ls-files", "-t", "-z"])).split("\0").filter(Boolean);
    if (tracked.some((entry) => entry.startsWith("S ")))
      return yield* fail("Checkout still contains absent sparse files.");
    yield* io(() =>
      fs
        .unlink(path.join(admin, "info", "sparse-checkout"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }),
    );
    yield* io(() => fs.unlink(journalPath(admin)));
    yield* step("restore-finished");
  }, Effect.uninterruptible);
  const release = Effect.fn("WorktreeCleanup.releaseCheckout")(function* (
    root: string,
    project: string,
    beforeChange: Effect.Effect<void, WorktreeCleanupError> = Effect.void,
  ) {
    if (platform === "win32")
      return yield* fail("Worktree source cleanup is unavailable on Windows.");
    const admin = yield* adminDirectory(root);
    if (admin === null) return yield* fail("Not a linked worktree.");
    yield* identity(root, admin);
    const common = path.resolve(
      root,
      (yield* command(root, ["rev-parse", "--git-common-dir"])).trimEnd(),
    );
    const owner = path.resolve(
      project,
      (yield* command(project, ["rev-parse", "--git-common-dir"])).trimEnd(),
    );
    if (
      common !== owner ||
      admin === common ||
      !admin.startsWith(`${common}${path.sep}worktrees${path.sep}`)
    )
      return yield* fail("Worktree belongs to another repository.");
    for (const name of [
      "locked",
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-merge",
      "rebase-apply",
      "index.lock",
      "styal-checkout.json",
    ])
      if (
        yield* io(() =>
          fs.lstat(path.join(admin, name)).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
        )
      )
        return yield* fail(
          "Worktree is locked, has an operation in progress, or already has a checkout recovery record.",
        );
    if (
      yield* io(() =>
        fs.lstat(path.join(admin, "info", "sparse-checkout")).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        ),
      )
    )
      return yield* fail("Worktree has pre-existing sparse-checkout patterns.");
    const sparse = yield* command(root, ["config", "--bool", "core.sparseCheckout"], [0, 1]);
    const flags = yield* command(root, ["ls-files", "-v", "-z"]);
    if (sparse.trim() === "true" || flags.split("\0").some((entry) => /^[a-zS] /.test(entry)))
      return yield* fail("Worktree has a user sparse-checkout or hidden index flags.");
    const modules = yield* command(root, ["submodule", "status", "--recursive"]);
    if (modules.split("\n").some((line) => line && !line.startsWith("-")))
      return yield* fail("Worktree has populated submodules.");
    const trackedPaths = yield* command(root, ["ls-files", "-z"]);
    if (trackedPaths && !trackedPaths.endsWith("\0"))
      return yield* fail("Incomplete tracked file list.");
    for (const cached of [[], ["--cached"]]) {
      const attributes = yield* command(
        root,
        ["check-attr", ...cached, "-z", "--stdin", "filter"],
        [0],
        trackedPaths,
      );
      const fields = attributes.split("\0");
      if (attributes && (!attributes.endsWith("\0") || (fields.length - 1) % 3 !== 0))
        return yield* fail("Incomplete Git attribute list.");
      if (fields.some((value, index) => index % 3 === 2 && value === "lfs"))
        return yield* fail("Worktree uses Git LFS.");
    }
    const before = yield* snapshot(root);
    const available = yield* io(() => fs.statfs(root));
    yield* save(admin, { ...before, phase: "releasing" });
    yield* step("release-recorded");
    const result = yield* Effect.gen(function* () {
      yield* beforeChange;
      yield* command(root, ["sparse-checkout", "set", "--cone"]);
      yield* step("release-set");
      yield* verify(root, before);
      yield* save(admin, { ...before, phase: "released" });
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* restore(root);
      return yield* result.failure;
    }
    yield* step("release-finished");
    const after = yield* io(() => fs.statfs(root));
    const bytes = Math.max(0, after.bavail * after.bsize - available.bavail * available.bsize);
    yield* save(admin, {
      ...before,
      phase: "released",
      bytes,
      availableBefore: available.bavail * available.bsize,
      availableAfter: after.bavail * after.bsize,
    });
    return bytes;
  }, Effect.uninterruptible);
  const state = Effect.fn("WorktreeCleanup.checkoutState")(function* (root: string) {
    const admin = yield* adminDirectory(root);
    if (admin === null) return null;
    const raw = yield* io(() =>
      fs.readFile(journalPath(admin), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    );
    return raw === null
      ? null
      : yield* decode(raw).pipe(
          Effect.mapError(() => fail("Invalid worktree checkout recovery record.")),
        );
  });
  return { release, restore, state };
});
