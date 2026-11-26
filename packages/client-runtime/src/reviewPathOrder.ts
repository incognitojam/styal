const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const lockfiles = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "uv.lock",
  "deno.lock",
  "poetry.lock",
  "Pipfile.lock",
  "mix.lock",
  "pubspec.lock",
  "Package.resolved",
]);

export function reviewPathTier(path: string): number {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.at(-1) ?? "";
  const directories = parts.slice(0, -1);
  if (
    lockfiles.has(name) ||
    /\.(?:snap|min\.js|min\.css)$|\.(?:generated|gen)\./.test(name) ||
    directories.some((part) =>
      ["__snapshots__", "__generated__", "dist", "build", "vendor"].includes(part),
    ) ||
    (parts.at(-2) === "meta" && /^(?:_journal|\d+_snapshot)\.json$/.test(name))
  )
    return 2;
  if (
    /\.(?:test|spec)\.|^test_.+\.py$|_test\.(?:go|py|rs|rb|exs|dart|c|cc|cpp|h|hpp)$|_spec\.rb$|[a-z0-9](?:Tests?|Spec)\.(?:swift|java|kt|kts|scala|cs|m|mm)$/.test(
      name,
    ) ||
    directories.some(
      (part) =>
        ["__tests__", "tests", "test", "__fixtures__", "fixtures", "testdata", "testkit"].includes(
          part.toLowerCase(),
        ) || /[a-z0-9](?:UI)?Tests$/.test(part),
    )
  )
    return 1;
  return 0;
}

export function compareReviewPaths(left: string, right: string): number {
  return reviewPathTier(left) - reviewPathTier(right) || collator.compare(left, right);
}
