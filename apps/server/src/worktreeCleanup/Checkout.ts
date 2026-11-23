import { WorktreeCleanupError } from "@t3tools/contracts";
import * as PhysicalFileSystem from "@t3tools/shared/PhysicalFileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeManagedWorktreeBoundary, makeIsManagedGitRoot } from "../worktreesDirectory.ts";
import { makeInspectGit } from "./gitInspection.ts";

export class CheckoutLimits extends Context.Reference<{
  readonly entries: number;
  readonly bytes: number;
  readonly step?: (step: string) => Effect.Effect<void>;
}>("worktreeCleanup/CheckoutLimits", {
  defaultValue: () => ({ entries: 100_000, bytes: 1_073_741_824 }),
}) {}

const Journal = Schema.Struct({
  estimatedBytes: Schema.optionalKey(Schema.Number),
  phase: Schema.Literals(["releasing", "released", "restoring"]),
  status: Schema.String,
  index: Schema.String,
  head: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  files: Schema.Record(Schema.String, Schema.String),
  recoveryFiles: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
  const snapshot = Effect.fn("WorktreeCleanup.checkoutSnapshot")(function* (
    root: string,
    protectedNames: readonly string[] = [],
  ) {
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
    const names = [
      ...new Set([...`${dirty}${others}${ignored}`.split("\0").filter(Boolean), ...protectedNames]),
    ];
    if (names.length > limits.entries)
      return yield* fail("Worktree checkout inspection exceeded its file limit.");
    const files: Record<string, string> = Object.create(null);
    let bytes = 0;
    for (const name of names) {
      if (path.isAbsolute(name) || name.split("/").some((part) => part === ".." || part === ".git"))
        return yield* fail("Unsafe worktree file path.");
      const target = path.join(root, name);
      const parent = yield* io(() =>
        fs.realpath(path.dirname(target)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }),
      );
      if (parent !== null && parent !== path.dirname(target))
        return yield* fail("Worktree file has a symlinked parent.");
      const stat = yield* io(() =>
        fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }),
      );
      if (stat === null) {
        files[name] = "missing";
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink())
        return yield* fail(`Worktree file "${name}" is a special file or nested repository.`);
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
    return {
      status,
      index: yield* crypto.digestHex(Digest.sha256, new TextEncoder().encode(index)),
      head: yield* command(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1]),
      branch: yield* command(root, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]),
      files,
    };
  });
  const verify = Effect.fn("WorktreeCleanup.verifyCheckout")(function* (
    root: string,
    before: Omit<typeof Journal.Type, "phase">,
  ) {
    const after = yield* snapshot(root, Object.keys(before.files));
    if (
      before.status !== after.status ||
      before.index !== after.index ||
      (before.head !== undefined && before.head !== after.head) ||
      (before.branch !== undefined && before.branch !== after.branch) ||
      Object.entries(before.files).some(([name, hash]) => after.files[name] !== hash)
    )
      return yield* fail(
        "Worktree changes differ after checkout; recovery is required before using the workspace.",
      );
  });
  const journalPath = (admin: string) => path.join(admin, "styal-checkout.json");
  const syncAdmin = Effect.fn("WorktreeCleanup.syncCheckoutDirectory")(function* (admin: string) {
    yield* io(async () => {
      const directory = await fs.open(admin, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  });
  const save = Effect.fn("WorktreeCleanup.saveCheckout")(function* (
    admin: string,
    value: typeof Journal.Type,
  ) {
    const text = yield* encode(value);
    const temporary = `${journalPath(admin)}.new`;
    yield* io(async () => {
      const handle = await fs.open(temporary, "w", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    const phase =
      value.phase === "releasing"
        ? "release"
        : value.phase === "restoring"
          ? "restore"
          : "released";
    yield* step(`${phase}-journal-written`);
    yield* io(() => fs.rename(temporary, journalPath(admin)));
    yield* step(`${phase}-journal-renamed`);
    yield* syncAdmin(admin);
    yield* step(`${phase}-journal-durable`);
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
    const entries = yield* command(root, ["ls-files", "-t", "--stage", "-z"]);
    if (entries && !entries.endsWith("\0")) return yield* fail("Incomplete checkout index.");
    const indexed = entries.split("\0").filter(Boolean);
    if (indexed.length > limits.entries)
      return yield* fail("Worktree checkout inspection exceeded its file limit.");
    const checked = new Set<string>();
    for (const entry of indexed) {
      if (!entry.startsWith("S ")) continue;
      const name = entry.slice(entry.indexOf("\t") + 1);
      if (
        !/^S [0-9]{6} [0-9a-f]+ 0\t/.test(entry) ||
        path.isAbsolute(name) ||
        name.split("/").some((part) => part === ".." || part === ".git")
      )
        return yield* fail("Invalid or conflicted checkout index.");
      const parts = name.split("/");
      for (let i = 0; i < parts.length; i++) {
        const relative = parts.slice(0, i + 1).join("/");
        if (checked.has(relative)) continue;
        const stat = yield* io(() =>
          fs.lstat(path.join(root, relative)).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
        );
        if (stat === null) break;
        const leaf = i === parts.length - 1;
        if (
          (!leaf && !stat.isDirectory()) ||
          (leaf &&
            !entry.startsWith("S 160000 ") &&
            (stat.isDirectory() || (stat.isSymbolicLink() && !entry.startsWith("S 120000 "))))
        )
          return yield* fail(
            `Local path "${relative}" blocks source checkout. Move it aside and retry.`,
          );
        checked.add(relative);
      }
    }
    const originals = journal.recoveryFiles ?? journal.files;
    const before = yield* snapshot(root, Object.keys(originals));
    const records = before.status.split("\0");
    const stagedDeletions = new Set<string>();
    for (let i = 0; i < records.length - 1; i++) {
      const record = records[i]!;
      if (/^(DD|AU|UD|UA|DU|AA|UU) /.test(record)) continue;
      if (record[1] === "D")
        return yield* fail(
          `Tracked file "${record.slice(3)}" was deleted. Stage or undo the deletion before retrying checkout.`,
        );
      if (record[0] === "D") stagedDeletions.add(record.slice(3));
      if (/^[RC]|^.[RC]/.test(record)) i++;
    }
    for (const name of Object.keys(originals)) {
      if (
        before.files[name] === "missing" &&
        journal.phase !== "released" &&
        !stagedDeletions.has(name)
      )
        return yield* fail(
          `Protected file "${name}" is missing. Restore it before retrying checkout.`,
        );
    }
    const recoveryFiles = Object.fromEntries(
      Object.entries(before.files).filter(([, hash]) => hash !== "missing"),
    );
    yield* save(admin, { ...before, recoveryFiles, phase: "restoring" });
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
    yield* syncAdmin(admin);
    yield* step("restore-finished");
  }, Effect.uninterruptible);
  const verifyOwnership = Effect.fn("WorktreeCleanup.verifyOwnership")(function* (
    root: string,
    project: string,
  ) {
    const admin = yield* adminDirectory(root);
    if (admin === null) return yield* fail("Not a linked worktree.");
    yield* identity(root, admin);
    const commonPath = path.resolve(
      root,
      (yield* command(root, ["rev-parse", "--git-common-dir"])).trimEnd(),
    );
    const ownerPath = path.resolve(
      project,
      (yield* command(project, ["rev-parse", "--git-common-dir"])).trimEnd(),
    );
    const common = yield* io(() => fs.realpath(commonPath));
    const owner = yield* io(() => fs.realpath(ownerPath));
    if (
      common !== owner ||
      admin === common ||
      path.dirname(admin) !== path.join(common, "worktrees")
    )
      return yield* fail("Worktree belongs to another repository.");
    return admin;
  });
  const release = Effect.fn("WorktreeCleanup.releaseCheckout")(function* (
    root: string,
    project: string,
    beforeChange: Effect.Effect<void, WorktreeCleanupError> = Effect.void,
  ) {
    if (platform === "win32")
      return yield* fail("Worktree source cleanup is unavailable on Windows.");
    const admin = yield* verifyOwnership(root, project);
    for (const name of [
      "locked",
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "sequencer",
      "SQUASH_MSG",
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
    const tracked = trackedPaths.split("\0").filter(Boolean);
    if (tracked.length > limits.entries)
      return yield* fail("Worktree checkout inspection exceeded its file limit.");
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
      if (
        fields.some(
          (value, index) =>
            index % 3 === 2 && value !== "unspecified" && value !== "unset" && value !== "",
        )
      )
        return yield* fail("Worktree uses a Git content filter, including Git LFS.");
    }
    const safeSnapshot = Effect.fn("WorktreeCleanup.safeSourceCheckout")(function* () {
      const current = yield* snapshot(root);
      if (Object.values(current.files).includes("missing"))
        return yield* fail("Worktree has an unstaged deletion; sources kept.");
      if (current.status.split("\0").some((entry) => entry.startsWith(" A ")))
        return yield* fail("Worktree has intent-to-add changes; sources kept.");
      return current;
    });
    const before = yield* safeSnapshot();
    const names = [...new Set(tracked.filter((name) => name.includes("/")))];
    const allocated = yield* io(async () => {
      const sizes = new Map<string, number>();
      for (const name of names) {
        const target = path.join(root, name);
        const stat = await fs.lstat(target);
        if (stat.isFile() && stat.nlink === 1) sizes.set(target, stat.blocks * 512);
      }
      return sizes;
    });
    yield* save(admin, { ...before, phase: "releasing" });
    yield* step("release-recorded");
    let mutationStarted = false;
    const result = yield* Effect.gen(function* () {
      const final = yield* safeSnapshot();
      if (
        before.status !== final.status ||
        before.index !== final.index ||
        before.head !== final.head ||
        before.branch !== final.branch ||
        Object.entries(before.files).some(([name, hash]) => final.files[name] !== hash) ||
        Object.keys(before.files).length !== Object.keys(final.files).length
      )
        return yield* fail("Worktree files changed during inspection; sources kept.");
      yield* beforeChange;
      mutationStarted = true;
      yield* command(root, ["sparse-checkout", "set", "--no-cone", "--stdin"], [0], "/*\n!/*/\n");
      yield* step("release-set");
      yield* verify(root, before);
      const estimatedBytes = yield* io(async () => {
        let bytes = 0;
        for (const [target, size] of allocated) {
          const missing = await fs.lstat(target).then(
            () => false,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return true;
              throw error;
            },
          );
          if (missing) bytes += size;
        }
        return bytes;
      });
      yield* save(admin, { ...before, phase: "released", estimatedBytes });
      return estimatedBytes;
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (mutationStarted) yield* restore(root);
      else {
        yield* io(() => fs.unlink(journalPath(admin)));
        yield* syncAdmin(admin);
      }
      return yield* result.failure;
    }
    yield* step("release-finished");
    return result.success;
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
  return { release, restore, state, verifyOwnership };
});

export const makeCheckoutRoot = Effect.gen(function* () {
  const fs = yield* PhysicalFileSystem.PhysicalFileSystem;
  const path = yield* Path.Path;
  const git = yield* makeInspectGit;
  const boundaryFor = yield* makeManagedWorktreeBoundary;
  const isManagedGitRoot = yield* makeIsManagedGitRoot;
  const fail = (message: string) => new WorktreeCleanupError({ reason: "run-failed", message });
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: () => fail("Could not identify the workspace checkout."),
    });
  const root = Effect.fn("WorktreeCleanup.checkoutRoot")(function* (
    cwd: string,
    forLease = false,
    recordedWorktree?: string,
  ) {
    const resolved = path.resolve(cwd);
    let canonical = resolved;
    let parent = path.isAbsolute(cwd) ? cwd : `${path.resolve(".")}${path.sep}${cwd}`;
    const missing: string[] = [];
    while (true) {
      const real = yield* io(() =>
        fs.realpath(parent).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }),
      );
      if (real !== null) {
        canonical = path.join(real, ...missing);
        break;
      }
      if (path.dirname(parent) === parent) break;
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
    const boundary = yield* boundaryFor(cwd);
    const unavailable = () =>
      fail(
        `Worktree "${cwd}" is missing its Git data. Run git worktree repair from the main repository if its registration still exists, or move your files out and remove this folder so styal can recreate it.`,
      );
    if (boundary?.escaped) return yield* unavailable();
    if (boundary !== null) {
      const leasePath =
        recordedWorktree === undefined
          ? boundary.leasePath
          : yield* boundary.canonical(recordedWorktree);
      if (
        missing.length > 0 &&
        !(yield* io(() =>
          fs.stat(leasePath).then(
            () => true,
            () => false,
          ),
        )) &&
        !(yield* io(() =>
          fs.stat(path.join(parent, ".git")).then(
            () => true,
            () => false,
          ),
        ))
      )
        return leasePath;
      const reported = yield* git(parent, ["rev-parse", "--show-toplevel"]);
      if (reported.exitCode === 0 && !reported.stdoutTruncated) {
        const top = yield* io(() => fs.realpath(reported.stdout.trimEnd()));
        if (yield* isManagedGitRoot(boundary, top, recordedWorktree)) return top;
        if (
          forLease ||
          (missing.length > 0 &&
            !(yield* io(() =>
              fs.stat(leasePath).then(
                () => true,
                () => false,
              ),
            )))
        )
          return leasePath;
        return yield* unavailable();
      }
      if (
        forLease ||
        (missing.length > 0 &&
          !(yield* io(() =>
            fs.stat(leasePath).then(
              () => true,
              () => false,
            ),
          )))
      )
        return leasePath;
      return canonical;
    }
    for (let directory = canonical; ; directory = path.dirname(directory)) {
      const marker = yield* io(() =>
        fs.lstat(path.join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }),
      );
      if (marker?.isFile() || marker?.isDirectory()) return directory;
      if (path.dirname(directory) === directory) return canonical;
    }
  });
  return root;
});
