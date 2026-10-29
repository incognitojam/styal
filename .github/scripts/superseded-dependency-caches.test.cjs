const { createHash } = require("node:crypto");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

test("keeps current generations and leaves slots without a current entry alone", () => {
  const current = hash("current");
  const old = hash("old");
  const filter = hash("filter");
  const cache = (id, dependency, date, host = "Linux-X64", ref = "refs/heads/main") => ({
    id,
    key: `installed-deps-v1-${host}-${dependency}-${filter}`,
    ref,
    created_at: date,
    size_in_bytes: 100,
  });
  const pages = [
    {
      actions_caches: [
        cache(1, current, "2026-10-01"),
        cache(2, old, "2026-10-02"),
        cache(3, old, "2026-09-01"),
        cache(4, current, "2026-10-02"),
        cache(5, old, "2026-09-01", "Windows-X64"),
      ],
    },
    {
      actions_caches: [
        cache(6, old, "2026-10-02", "Windows-X64"),
        cache(7, old, "2026-10-02", "Linux-X64", "refs/pull/1/merge"),
        { id: 8, ref: "refs/heads/main", key: "other-cache" },
        {
          ...cache(9, old, "2026-09-01"),
          key: `installed-deps-v1-Linux-X64-${old}-${hash("other-filter")}`,
        },
      ],
    },
  ];
  const select = (currentHash) =>
    execFileSync(
      "jq",
      [
        "-c",
        "-s",
        "--arg",
        "current",
        currentHash,
        "--arg",
        "current_pnpm",
        hash("pnpm-current"),
        "-f",
        ".github/scripts/superseded-dependency-caches.jq",
      ],
      { input: pages.map(JSON.stringify).join("\n"), encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).id);
  // Slurp produces the same paginated array as gh api --paginate --slurp.
  assert.deepEqual(select(current), [2, 3]);
  assert.deepEqual(select(hash("missing")), []);
});

test("pnpm stores require a current lockfile hash in each OS and architecture slot", () => {
  const current = hash("pnpm-current");
  const old = hash("old");
  const cache = (id, dependency, slot = "Linux-x64-pnpm", ref = "refs/heads/main") => ({
    id,
    key: `vite-plus-${slot}-${dependency}`,
    ref,
    size_in_bytes: 100,
  });
  const pages = [
    {
      actions_caches: [
        cache(1, current),
        cache(2, old),
        cache(3, current),
        cache(4, old, "Windows-x64-pnpm"),
        cache(5, old, "Linux-arm64-pnpm"),
        cache(6, old, "Linux-x64-pnpm", "refs/pull/1/merge"),
        cache(7, old, "Linux-x64-pnpm", "refs/heads/feature"),
        cache(8, old, "Linux-x64-npm"),
        cache(9, current, "Windows-x64-pnpm", "refs/heads/feature"),
      ],
    },
  ];
  const select = (currentHash) =>
    execFileSync(
      "jq",
      [
        "-c",
        "--arg",
        "current",
        hash("installed-current"),
        "--arg",
        "current_pnpm",
        currentHash,
        "-f",
        ".github/scripts/superseded-dependency-caches.jq",
      ],
      { input: JSON.stringify(pages), encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  assert.deepEqual(select(current), [
    { id: 2, key: `vite-plus-Linux-x64-pnpm-${old}`, size_in_bytes: 100, created_at: null },
  ]);
  assert.deepEqual(select(hash("missing")), []);
  assert.deepEqual(select(""), []);
});
