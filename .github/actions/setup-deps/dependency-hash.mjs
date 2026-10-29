import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Hash the index so filesystem traversal order, symlink support, and checkout
// line endings cannot change the generation between runners and cleanup.
export function dependencyHash(cwd = process.cwd()) {
  const paths = [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "package.json",
    ":(glob)apps/*/package.json",
    ":(glob)apps/mobile/modules/**",
    ":(glob)packages/*/package.json",
    ":(glob)infra/*/package.json",
    "scripts/package.json",
    "e2e/package.json",
    "oxlint-plugin-t3code/package.json",
    ":(glob)patches/**",
    "scripts/clean-tsgo-backups.mjs",
    ":(glob).github/actions/setup-deps/**",
  ];
  const entries = execFileSync("git", ["ls-files", "--stage", "-z", "--", ...paths], { cwd });
  if (entries.length === 0) throw new Error("No dependency inputs found in the Git index");
  return createHash("sha256").update(entries).digest("hex");
}
