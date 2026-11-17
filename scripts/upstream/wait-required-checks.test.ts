import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import {
  readRequiredChecks,
  requiredCheckStates,
  waitRequiredChecks,
} from "./wait-required-checks.ts";

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
    check_suite: { id: 10 },
    name: "Fork Mobile Native Lint",
    app: { id: 15368 },
    status: "completed",
    conclusion: "success",
  };
  const hold = { id: 1, context: "Intake landing hold", state: "success" };
  const evaluate = (runs = [run], statuses = [hold]) => requiredCheckStates(rules, runs, statuses);
  await waitRequiredChecks(() => evaluate(), { timeoutMs: 0, intervalMs: 1 });
  NodeAssert.throws(() => requiredCheckStates([], [], []), /No required status checks/);
  for (const conclusion of ["neutral", "skipped"]) {
    await waitRequiredChecks(() => evaluate([{ ...run, conclusion }]), {
      timeoutMs: 0,
      intervalMs: 1,
    });
  }
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
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

it("waits for replacement suites and attempts before accepting old successful jobs", () => {
  const rules = [
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "lint", integration_id: 15368 }] },
    },
  ];
  const run = {
    id: 100,
    name: "lint",
    check_suite: { id: 10 },
    app: { id: 15368 },
    status: "completed",
    conclusion: "success",
  };
  const owner = {
    id: 1,
    workflow_id: 2,
    check_suite_id: 10,
    status: "completed",
  };
  const check = (workflows = [owner], suites = [{ id: 10, app: run.app, status: "completed" }]) =>
    requiredCheckStates(rules, [run], [], suites, workflows)[0]!.state;
  NodeAssert.equal(check(), "success");
  NodeAssert.equal(check([owner], [{ id: 10, app: run.app, status: "queued" }]), "pending");
  NodeAssert.equal(check([{ ...owner, status: "queued" }]), "pending");
  NodeAssert.equal(check([owner, { ...owner, id: 3, check_suite_id: 11 }]), "pending");
  NodeAssert.equal(
    check([owner, { ...owner, id: 3, check_suite_id: 11, status: "queued" }]),
    "pending",
  );
  NodeAssert.equal(check([owner], [{ id: 11, app: run.app, status: "queued" }]), "pending");
  NodeAssert.equal(
    check(
      [
        owner,
        {
          ...owner,
          id: 3,
          workflow_id: 4,
          check_suite_id: 11,
          status: "queued",
        },
      ],
      [{ id: 11, app: run.app, status: "queued" }],
    ),
    "success",
  );
});

it("refreshes added and removed rules on every poll and a final single-pass read", async () => {
  let round = 0;
  const api = (path: string): Array<unknown> => {
    if (path === "rules/branches/main") {
      round++;
      return [
        [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: (round === 1
                ? ["hold", "removed"]
                : round === 2
                  ? ["hold", "added"]
                  : ["hold"]
              ).map((context) => ({ context })),
            },
          },
        ],
      ];
    }
    if (path.includes("check-runs")) return [{ check_runs: [] }];
    if (path.includes("check-suites")) return [{ check_suites: [] }];
    if (path.includes("actions/runs")) return [{ workflow_runs: [] }];
    return [[{ id: 1, context: "hold", state: "success" }]];
  };
  let now = 0;
  const seen: Array<string> = [];
  await waitRequiredChecks(
    () => {
      const states = readRequiredChecks(api, "a".repeat(40));
      seen.push(
        states
          .filter((state) => state.state === "pending")
          .map((state) => state.context)
          .join(),
      );
      return states;
    },
    { timeoutMs: 100, intervalMs: 1 },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  NodeAssert.deepEqual(seen, ["removed", "added", ""]);
  round = 1;
  await NodeAssert.rejects(
    waitRequiredChecks(() => readRequiredChecks(api, "a".repeat(40)), {
      timeoutMs: 0,
      intervalMs: 1,
    }),
    /Timed out.*added/,
  );
});
