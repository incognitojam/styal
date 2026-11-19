import * as NodeFS from "node:fs";
for (const [file, pattern] of [
  [
    "Checkout.ts",
    /if \(platform === "win32"\)\s*return yield\* fail\("Worktree source cleanup is unavailable on Windows\."\);/,
  ],
  ["Sweep.ts", /if \(platform === "win32"\) \{[\s\S]*?\n    \}/],
  ["CheckoutSweep.ts", /if \(platform === "win32"\) return;/],
]) {
  const path = `apps/server/src/worktreeCleanup/${file}`;
  const before = NodeFS.readFileSync(path, "utf8");
  if (!pattern.test(before)) throw new Error(`Missing guard: ${file}`);
  NodeFS.writeFileSync(path, before.replace(pattern, ""));
  console.log(`Lifted Windows guard: ${file}`);
}
