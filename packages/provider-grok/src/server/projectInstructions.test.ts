import { assert, it } from "@effect/vitest";
import { withGrokProjectInstructions } from "./projectInstructions.ts";

it("adds project rules before Grok's launch flags without changing an empty launch", () => {
  const spawn = {
    command: "grok",
    args: ["--permission-mode", "default", "agent", "stdio"],
    cwd: "/workspace/atlas",
  };
  assert.strictEqual(withGrokProjectInstructions(undefined, spawn), spawn);
  assert.strictEqual(withGrokProjectInstructions("", spawn), spawn);
  assert.deepEqual(withGrokProjectInstructions("Use synthetic fixtures.", spawn), {
    ...spawn,
    args: ["--rules", "Use synthetic fixtures.", ...spawn.args],
  });
});
