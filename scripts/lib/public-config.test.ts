// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("pairs the default source-build relay with production", () => {
    const example = NodeUtil.parseEnv(
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../../.env.example"), "utf8"),
    );
    const production = NodeUtil.parseEnv(
      NodeFS.readFileSync(
        NodePath.resolve(import.meta.dirname, "../../.env.production.example"),
        "utf8",
      ),
    );
    expect(example.T3CODE_RELAY_URL).toBeTruthy();
    expect(example.T3CODE_RELAY_URL).toBe(production.T3CODE_RELAY_URL);
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "styal-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
