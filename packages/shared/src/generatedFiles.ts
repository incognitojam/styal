const GENERATED_LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "deno.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Lockfiles whose generated contents rarely benefit from being open in a review by default. */
export function isGeneratedLockfilePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return GENERATED_LOCKFILE_NAMES.has(normalized.slice(normalized.lastIndexOf("/") + 1));
}
