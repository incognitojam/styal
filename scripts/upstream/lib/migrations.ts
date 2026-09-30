export const upstreamMigrationManifestPath = "apps/server/src/persistence/Migrations.ts";
export const upstreamMigrationDirectory = "apps/server/src/persistence/Migrations/";

export interface UpstreamMigrationEntry {
  readonly id: number;
  readonly name: string;
  /** The module the entry loads, relative to the repository root. */
  readonly path: string | null;
}

const IMPORT_PATTERN = /^import (Migration\d+) from "\.\/Migrations\/([^"]+)";$/gmu;
const ENTRY_PATTERN = /^\s*\[(\d+), "([A-Za-z0-9_]+)", (Migration\d+)\],?$/gmu;

/** Reads the `[id, name, module]` entries from the upstream migration manifest source. */
export function parseUpstreamMigrationManifest(
  source: string,
): ReadonlyArray<UpstreamMigrationEntry> {
  const pathByModule = new Map<string, string>();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    pathByModule.set(match[1]!, `${upstreamMigrationDirectory}${match[2]!}`);
  }
  return Array.from(source.matchAll(ENTRY_PATTERN), (match) => ({
    id: Number(match[1]),
    name: match[2]!,
    path: pathByModule.get(match[3]!) ?? null,
  }));
}

function describeEntry(entry: UpstreamMigrationEntry): string {
  return `${entry.id} ${entry.name}`;
}

/**
 * The migrator treats the highest recorded ID as a watermark, so the fork's upstream manifest
 * must be a prefix of upstream's: an extra, renamed or skipped entry makes databases record an
 * ID that upstream later uses for a different migration.
 */
export function checkUpstreamMigrationManifest(input: {
  readonly fork: ReadonlyArray<UpstreamMigrationEntry>;
  readonly upstream: ReadonlyArray<UpstreamMigrationEntry>;
}): ReadonlyArray<string> {
  const errors: Array<string> = [];
  for (const [index, entry] of input.fork.entries()) {
    const upstream = input.upstream[index];
    if (upstream === undefined) {
      errors.push(
        `Upstream migration manifest entry ${describeEntry(entry)} is not in upstream's manifest. Fork migrations belong in apps/server/src/persistence/ForkMigrations/.`,
      );
      continue;
    }
    if (upstream.id !== entry.id || upstream.name !== entry.name || upstream.path !== entry.path) {
      errors.push(
        `Upstream migration manifest position ${index + 1} is ${describeEntry(entry)} (${entry.path ?? "no module"}), but upstream has ${describeEntry(upstream)} (${upstream.path ?? "no module"}).`,
      );
    }
  }
  return errors;
}

/**
 * Upstream migration files are carried verbatim. Each file the fork has under the upstream
 * migration directory, and the manifest itself, must match a version that upstream has had at
 * that path.
 */
export function checkUpstreamMigrationFiles(input: {
  readonly forkBlobByPath: ReadonlyMap<string, string>;
  readonly upstreamBlobsByPath: ReadonlyMap<string, ReadonlySet<string>>;
}): ReadonlyArray<string> {
  const errors: Array<string> = [];
  for (const [path, blob] of [...input.forkBlobByPath].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const upstreamBlobs = input.upstreamBlobsByPath.get(path);
    if (upstreamBlobs === undefined) {
      errors.push(`${path} does not exist in upstream.`);
    } else if (!upstreamBlobs.has(blob)) {
      errors.push(`${path} does not match any version of that file in upstream.`);
    }
  }
  return errors;
}

/** Entries the head manifest adds or changes relative to the base manifest. */
export function changedUpstreamMigrations(input: {
  readonly base: ReadonlyArray<UpstreamMigrationEntry>;
  readonly head: ReadonlyArray<UpstreamMigrationEntry>;
}): ReadonlyArray<string> {
  const baseById = new Map(input.base.map((entry) => [entry.id, entry]));
  const headIds = new Set(input.head.map((entry) => entry.id));
  const changes: Array<string> = [];
  for (const entry of input.head) {
    const base = baseById.get(entry.id);
    if (base === undefined) changes.push(`adds ${describeEntry(entry)}`);
    else if (base.name !== entry.name || base.path !== entry.path) {
      changes.push(`changes ${describeEntry(base)} to ${describeEntry(entry)}`);
    }
  }
  for (const entry of input.base) {
    if (!headIds.has(entry.id)) changes.push(`removes ${describeEntry(entry)}`);
  }
  return changes;
}

export interface UpstreamMigrationGit {
  /** File contents at a revision, or null when the file does not exist there. */
  readonly show: (revision: string, path: string) => string | null;
  /** `git ls-tree -r` of the given paths at a revision: path to blob id. */
  readonly blobs: (revision: string, paths: ReadonlyArray<string>) => ReadonlyMap<string, string>;
  /** Every blob id each path has had in the history of a revision. */
  readonly historyBlobs: (
    revision: string,
    paths: ReadonlyArray<string>,
  ) => ReadonlyMap<string, ReadonlySet<string>>;
}

/** Checks the upstream migration history at `revision` against upstream at `upstreamRevision`. */
export function checkUpstreamMigrationsAtRevision(input: {
  readonly git: UpstreamMigrationGit;
  readonly revision: string;
  readonly upstreamRevision: string;
}): ReadonlyArray<string> {
  const paths = [upstreamMigrationManifestPath, upstreamMigrationDirectory];
  const forkManifest = input.git.show(input.revision, upstreamMigrationManifestPath);
  const upstreamManifest = input.git.show(input.upstreamRevision, upstreamMigrationManifestPath);
  if (forkManifest === null) return [`${upstreamMigrationManifestPath} is missing.`];
  if (upstreamManifest === null) {
    return [`${upstreamMigrationManifestPath} is missing from ${input.upstreamRevision}.`];
  }
  return [
    ...checkUpstreamMigrationManifest({
      fork: parseUpstreamMigrationManifest(forkManifest),
      upstream: parseUpstreamMigrationManifest(upstreamManifest),
    }),
    ...checkUpstreamMigrationFiles({
      forkBlobByPath: input.git.blobs(input.revision, paths),
      upstreamBlobsByPath: input.git.historyBlobs(input.upstreamRevision, paths),
    }),
  ];
}
