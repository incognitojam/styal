import { isGeneratedLockfilePath } from "./generatedFiles.ts";

export type DiffFileTier = "source" | "test" | "generated";

const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "dist",
  "build",
  "vendor",
]);
// Fixtures and test harnesses only matter once the tests that load them have been read.
const TEST_DIRECTORIES = new Set([
  "__tests__",
  "tests",
  "test",
  "__fixtures__",
  "fixtures",
  "testdata",
  "testkit",
]);
// Test file names across languages: `app.test.ts`, Go's `app_test.go`, pytest's `test_app.py`,
// RSpec's `app_spec.rb`, and xUnit-style `AppTests.swift` or `AppTest.java`.
const TEST_FILE_NAME =
  /\.(?:test|spec)\.|^test_.+\.py$|_test\.(?:go|py|rs|rb|exs|dart|c|cc|cpp|h|hpp)$|_spec\.rb$|[a-z0-9](?:Tests?|Spec)\.(?:swift|java|kt|kts|scala|cs|m|mm)$/;
// Xcode and Swift Package Manager name a test target after the module it tests: `AppTests`.
const TEST_TARGET_DIRECTORY = /[a-z0-9](?:UI)?Tests$/;
// drizzle-kit's migration bookkeeping. The SQL migrations beside it stay source: they are what runs.
const DRIZZLE_META_FILE = /^(?:_journal|\d+_snapshot)\.json$/;
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Classifies a diff path by name alone. `generatedPaths` carries the repository's own
 * `linguist-generated` attributions when the caller has them, which outrank any name pattern.
 */
export function diffFileTier(path: string, generatedPaths?: ReadonlySet<string>): DiffFileTier {
  if (generatedPaths?.has(path)) {
    return "generated";
  }
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (
    isGeneratedLockfilePath(name) ||
    name.endsWith(".snap") ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    /\.(?:generated|gen)\./.test(name) ||
    (segments.at(-2) === "meta" && DRIZZLE_META_FILE.test(name)) ||
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) {
    return "generated";
  }
  if (
    TEST_FILE_NAME.test(name) ||
    segments
      .slice(0, -1)
      .some(
        (segment) =>
          TEST_DIRECTORIES.has(segment.toLowerCase()) || TEST_TARGET_DIRECTORY.test(segment),
      )
  ) {
    return "test";
  }
  return "source";
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function baseName(path: string): string {
  return stripExtension(path.split("/").at(-1) ?? "");
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

function importedPaths(
  path: string,
  lines: ReadonlyArray<string>,
  byModulePath: ReadonlyMap<string, string>,
  byBaseName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? "";
      const withExtension = specifier.startsWith(".")
        ? resolveRelative(path, specifier)
        : specifier;
      // A specifier may name the extension the module map dropped, and it need not be the one on
      // disk: TypeScript's own imports point at the `.js` beside a `.ts`.
      const extension = MODULE_EXTENSIONS.find((candidate) => withExtension.endsWith(candidate));
      const resolved =
        extension === undefined ? withExtension : withExtension.slice(0, -extension.length);
      const target =
        byModulePath.get(resolved) ??
        byModulePath.get(`${resolved}/index`) ??
        byBaseName.get(baseName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

function heapPush(heap: Array<number>, value: number): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent]! <= heap[index]!) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
}

function heapPop(heap: Array<number>): number {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const smallest = left + 1 < heap.length && heap[left + 1]! < heap[left]! ? left + 1 : left;
      if (smallest >= heap.length || heap[index]! <= heap[smallest]!) break;
      [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
      index = smallest;
    }
  }
  return top;
}

/**
 * Source files with what they import ahead of what imports them.
 *
 * Kahn's, but every step takes the lowest ready path rather than any ready node, so the same
 * change always reads the same way and files of one directory stay together. A cycle leaves nothing
 * ready: the lowest path still standing is taken anyway, which is the alphabetical order the tier
 * would have had without a graph. Ready paths wait in a min-heap of sorted ranks; this runs
 * synchronously on the UI thread, so it must stay near-linear even for an enormous diff.
 */
function orderByImports(
  paths: ReadonlyArray<string>,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): Array<string> {
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  const rank = new Map(sorted.map((path, index) => [path, index] as const));
  const pending = sorted.map((path) => imports.get(path)?.size ?? 0);
  const dependents = new Map<string, Array<number>>();
  for (const path of sorted) {
    for (const dependency of imports.get(path) ?? []) {
      const list = dependents.get(dependency);
      if (list === undefined) dependents.set(dependency, [rank.get(path)!]);
      else list.push(rank.get(path)!);
    }
  }

  const ready: Array<number> = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (pending[index] === 0) heapPush(ready, index);
  }
  const placed = Array.from({ length: sorted.length }, () => false);
  const ordered: Array<string> = [];
  let lowestUnplaced = 0;
  while (ordered.length < sorted.length) {
    let index: number;
    if (ready.length > 0) {
      index = heapPop(ready);
    } else {
      while (placed[lowestUnplaced]) lowestUnplaced += 1;
      index = lowestUnplaced;
    }
    placed[index] = true;
    const path = sorted[index]!;
    ordered.push(path);
    for (const dependent of dependents.get(path) ?? []) {
      pending[dependent] = pending[dependent]! - 1;
      // A cycle-broken path may drain to zero after it was already taken; it must not re-enter.
      if (pending[dependent] === 0 && !placed[dependent]) heapPush(ready, dependent);
    }
  }
  return ordered;
}

/**
 * The implementation a test names: `foo.test.ts`, `__tests__/foo.ts`, `foo_test.go`,
 * `test_foo.py` and `FooTests.swift` all point at their source's base name.
 */
function testedBaseName(path: string): string {
  return (path.split("/").at(-1) ?? "")
    .replace(/\.(?:test|spec)\..*$/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/^test_(?=.)/, "")
    .replace(/(?<=.)_(?:test|spec)$/, "")
    .replace(/(?<=[a-z0-9])(?:Tests?|Spec)$/, "");
}

/** How a caller's file shape maps onto the ordering: its diff path and its patch's changed lines. */
export interface DiffFileOrderAccessors<T> {
  readonly path: (file: T) => string;
  readonly changedLines: (file: T) => ReadonlyArray<string>;
}

/**
 * Diff files in reading order: source in dependency order, then the tests that cover it, then
 * whatever a tool wrote. `generatedPaths` carries repository `linguist-generated` attributions
 * on top of the name-based tiers.
 */
export function orderDiffFiles<T>(
  files: ReadonlyArray<T>,
  accessors: DiffFileOrderAccessors<T>,
  generatedPaths?: ReadonlyArray<string>,
): ReadonlyArray<T> {
  const generatedPathSet = generatedPaths === undefined ? undefined : new Set(generatedPaths);
  // A patch can list one path more than once; every entry stays, in its original relative order.
  const byPath = new Map<string, T[]>();
  for (const file of files) {
    const path = accessors.path(file);
    const entries = byPath.get(path);
    if (entries) entries.push(file);
    else byPath.set(path, [file]);
  }
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path, generatedPathSet));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousBaseNames = new Set<string>();
  const byBaseName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripExtension(path), path);
    const base = baseName(path);
    if (byBaseName.has(base)) ambiguousBaseNames.add(base);
    byBaseName.set(base, path);
  }
  for (const base of ambiguousBaseNames) byBaseName.delete(base);

  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) {
    imports.set(
      path,
      importedPaths(
        path,
        byPath.get(path)!.flatMap((file) => accessors.changedLines(file)),
        byModulePath,
        byBaseName,
      ),
    );
  }
  const orderedSource = orderByImports(sourcePaths, imports);

  const sourcePositions = new Map<string, number>();
  orderedSource.forEach((path, index) => {
    const base = baseName(path);
    if (!sourcePositions.has(base)) sourcePositions.set(base, index);
  });
  const orderedTests = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "test")
    .sort((left, right) => {
      const leftPosition = sourcePositions.get(testedBaseName(left)) ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = sourcePositions.get(testedBaseName(right)) ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.localeCompare(right);
    });

  const orderedGenerated = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "generated")
    .sort((left, right) => left.localeCompare(right));

  return [...orderedSource, ...orderedTests, ...orderedGenerated].flatMap((path) =>
    byPath.get(path)!,
  );
}

const UNLOADED_FILE_ORDER_ACCESSORS = {
  path: (file: { readonly path: string }) => file.path,
  changedLines: () => [],
};

/**
 * Reading order for a diff whose files load one by one. Without their patches there are no import
 * lines to follow, so source stays in path order ahead of its tests and generated output.
 */
export function orderUnloadedDiffFiles<T extends { readonly path: string }>(
  files: ReadonlyArray<T>,
  generatedPaths?: ReadonlyArray<string>,
): ReadonlyArray<T> {
  return orderDiffFiles(files, UNLOADED_FILE_ORDER_ACCESSORS, generatedPaths);
}
