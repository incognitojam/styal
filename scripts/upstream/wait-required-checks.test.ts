import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import { requiredCheckStates, waitRequiredChecks } from "./wait-required-checks.ts";

it("requires the latest successful evidence from the ruleset's integration, including the hold", async () => {
  const rules = [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "Fork Mobile Native Lint", integration_id: 15368 },
          { context: "Intake landing hold" },
        ],
      },
    },
  ];
  const run = {
    id: 1,
    name: "Fork Mobile Native Lint",
    app: { id: 15368 },
    status: "completed",
    conclusion: "success",
  };
  const hold = { id: 1, context: "Intake landing hold", state: "success" };
  const evaluate = (runs = [run], statuses = [hold]) => requiredCheckStates(rules, runs, statuses);
  await waitRequiredChecks(() => evaluate(), { timeoutMs: 0, intervalMs: 1 });
  NodeAssert.throws(() => requiredCheckStates([], [], []), /No required status checks/);
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", "timed_out"]) {
    await NodeAssert.rejects(
      waitRequiredChecks(() => evaluate([run, { ...run, id: 2, conclusion }]), {
        timeoutMs: 0,
        intervalMs: 1,
      }),
      new RegExp(`Fork Mobile Native Lint \\(${conclusion}\\)`),
    );
  }
  for (const runs of [[], [{ ...run, app: { id: 42 } }], [{ ...run, status: "in_progress" }]]) {
    await NodeAssert.rejects(
      waitRequiredChecks(() => evaluate(runs), { timeoutMs: 0, intervalMs: 1 }),
      /Timed out waiting for required checks: Fork Mobile Native Lint/,
    );
  }
  await NodeAssert.rejects(
    waitRequiredChecks(() => evaluate([run], []), { timeoutMs: 0, intervalMs: 1 }),
    /Intake landing hold/,
  );
  let attempts = 0;
  let now = 0;
  await waitRequiredChecks(
    () => evaluate(attempts++ ? [run] : []),
    { timeoutMs: 100, intervalMs: 10 },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  NodeAssert.strictEqual(attempts, 2);
  attempts = 0;
  await NodeAssert.rejects(
    waitRequiredChecks(
      () => {
        attempts++;
        return evaluate([]);
      },
      { timeoutMs: 20, intervalMs: 10 },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
    /Timed out.*Fork Mobile Native Lint/,
  );
  NodeAssert.strictEqual(attempts, 3);
});
