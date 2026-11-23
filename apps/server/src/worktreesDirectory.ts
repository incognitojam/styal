import { VcsRepositoryDetectionError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";

/** Null for filesystem roots or settings not absolute on this host, including synced foreign-platform paths. */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}

export function isWithinWorktreesDirectory(
  path: Path.Path,
  directory: string,
  candidate: string,
  caseInsensitive = false,
): boolean {
  const relative = path.relative(
    caseInsensitive ? directory.toLowerCase() : directory,
    caseInsensitive ? candidate.toLowerCase() : candidate,
  );
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export const makeManagedWorktreeBoundary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  let knownDirectories: ReadonlyArray<string> = [config.worktreesDir];
  const caseRules = new Map<string, boolean>();

  // Resolve a symlink before a following "..", matching the cwd Git receives.
  const canonical = (target: string): Effect.Effect<string> => {
    const segments = target.split(path.sep);
    const dotdot = segments.indexOf("..");
    if (dotdot !== -1) {
      const prefix = segments.slice(0, dotdot).join(path.sep) || path.parse(target).root;
      return canonical(prefix).pipe(
        Effect.flatMap((real) =>
          canonical([path.dirname(real), ...segments.slice(dotdot + 1)].join(path.sep)),
        ),
      );
    }
    return fs.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(canonical(parent), (real) => path.join(real, path.basename(target)));
      }),
    );
  };
  const caseInsensitive = Effect.fn("worktreesDirectory.caseInsensitive")(function* (
    directory: string,
  ) {
    if (platform === "win32") return true;
    const cached = caseRules.get(directory);
    if (cached !== undefined) return cached;
    const original = yield* fs.lstat(directory).pipe(Effect.orElseSucceed(() => null));
    if (original === null) return false;
    const name = path.basename(directory);
    const alternateName = name.replace(/[a-zA-Z]/, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    );
    const alternate = yield* fs
      .lstat(path.join(path.dirname(directory), alternateName))
      .pipe(Effect.orElseSucceed(() => null));
    const insensitive =
      alternateName !== name &&
      original.type === "Directory" &&
      alternate?.type === "Directory" &&
      original.dev === alternate.dev &&
      original.ino._tag === "Some" &&
      alternate.ino._tag === "Some" &&
      original.ino.value === alternate.ino.value;
    caseRules.set(directory, insensitive);
    return insensitive;
  });

  return Effect.fn("worktreesDirectory.managedWorktreeBoundary")(function* (cwd: string) {
    const settings = yield* settingsService.getSettings.pipe(Effect.result);
    if (settings._tag === "Success")
      knownDirectories = managedWorktreesDirectories(
        settings.success,
        config.worktreesDir,
        path,
        home,
      );
    const resolved = path.resolve(cwd);
    const absolute = path.isAbsolute(cwd) ? cwd : `${path.resolve(".")}${path.sep}${cwd}`;
    const physical = yield* canonical(absolute);
    for (const declared of knownDirectories.toSorted((a, b) => b.length - a.length)) {
      const directory = yield* canonical(declared);
      if (isFilesystemRoot(directory, path)) continue;
      const insensitive = yield* caseInsensitive(directory);
      const physicallyInside = isWithinWorktreesDirectory(path, directory, physical, insensitive);
      const lexicallyInside = isWithinWorktreesDirectory(path, declared, resolved, insensitive);
      if (!physicallyInside && !lexicallyInside) continue;
      if (settings._tag === "Failure")
        return yield* new VcsRepositoryDetectionError({
          operation: "worktreesDirectory.managedWorktreeBoundary",
          cwd,
          detail: "Could not read managed worktree locations. The workspace cannot be used.",
          cause: settings.failure,
        });
      const owner = physicallyInside ? directory : declared;
      const candidate = physicallyInside ? physical : resolved;
      const segments = candidate
        .split(path.sep)
        .slice(owner.split(path.sep).length)
        .filter(Boolean);
      return {
        directory,
        canonical: (candidate: string) =>
          canonical(
            path.isAbsolute(candidate) ? candidate : `${path.resolve(".")}${path.sep}${candidate}`,
          ),
        cwd: physical,
        escaped: !physicallyInside,
        caseInsensitive: insensitive,
        // Only the no-repository lease fallback uses styal's folder shape; healthy roots come from Git.
        leasePath:
          segments.length >= 2 ? path.join(directory, segments[0]!, segments[1]!) : physical,
      };
    }
    return null;
  });
});

export const makeIsManagedWorktreePath = Effect.gen(function* () {
  const boundaryFor = yield* makeManagedWorktreeBoundary;
  const path = yield* Path.Path;
  return Effect.fn("worktreesDirectory.isManagedWorktreePath")(function* (worktreePath: string) {
    if (!path.isAbsolute(worktreePath) || path.resolve(worktreePath) !== worktreePath) return false;
    const boundary = yield* boundaryFor(worktreePath).pipe(Effect.orElseSucceed(() => null));
    if (boundary === null || boundary.escaped) return false;
    return boundary.cwd.split(path.sep).length - boundary.directory.split(path.sep).length === 2;
  });
});

type ManagedWorktreeBoundary = NonNullable<
  Effect.Success<ReturnType<Effect.Success<typeof makeManagedWorktreeBoundary>>>
>;

export const makeIsManagedGitRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("worktreesDirectory.isManagedGitRoot")(function* (
    boundary: ManagedWorktreeBoundary,
    root: string,
    recordedWorktree?: string,
  ) {
    if (boundary.escaped) return false;
    const top = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => null));
    if (top === null) return false;
    const within = (parent: string, child: string) =>
      isWithinWorktreesDirectory(path, parent, child, boundary.caseInsensitive);
    if (!within(boundary.directory, top)) return false;
    if (recordedWorktree !== undefined) {
      const expected = yield* boundary.canonical(recordedWorktree);
      return within(expected, top) && within(top, expected);
    }
    if (within(top, boundary.cwd) && within(boundary.cwd, top)) return true;
    const records = yield* sql<{ readonly worktreePath: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            cwd: boundary.cwd,
            operation: "worktreesDirectory.isManagedGitRoot",
            detail: "Could not read recorded worktrees. The workspace cannot be used.",
            cause,
          }),
      ),
    );
    const roots = yield* Effect.forEach(
      records,
      (record) => boundary.canonical(record.worktreePath),
      { concurrency: 16 },
    );
    const owner = roots
      .toSorted((a, b) => b.length - a.length)
      .find((candidate) => within(candidate, boundary.cwd));
    // A repository initialized below a recorded worktree has its own Git data.
    return owner === undefined || within(owner, top);
  });
});
