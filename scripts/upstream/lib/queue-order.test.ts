import { assert, describe, it } from "@effect/vitest";
import type { Integration } from "../queue.ts";
import { queueOrderError, queueOrderGap, type QueueOrderInput } from "./queue-order.ts";

const sha = (n: number) => n.toString(16).padStart(4, "0").repeat(10);
/** Upstream integration n merges PR 100 + n. */
const integrations: Integration[] = Array.from({ length: 10 }, (_, index) => ({
  sha: sha(index + 1),
  parents: [sha(index)],
  title: `upstream change ${index + 1}`,
  empty: false,
  pr: 100 + index + 1,
}));
const imports = (...numbers: number[]) =>
  numbers.map((n) => ({
    sha: sha(0xf000 + n),
    message: `import upstream change ${n}\n\nUpstream-PR: ${100 + n}\n`,
  }));
const earlyImport = (n: number) => ({
  sha: sha(0xe000 + n),
  message: `import upstream change ${n}\n\nEarly-Import: fixes a regression from change 2.\nUpstream-PR: ${100 + n}\n`,
});
const check = (input: Partial<QueueOrderInput>) =>
  queueOrderGap({
    integrations,
    mainCommits: [],
    candidateCommits: [],
    exceptions: {},
    mainTracked: [],
    candidateTracked: [],
    ...input,
  });
const skippedPRs = (input: Partial<QueueOrderInput>) =>
  check(input).skipped.map((entry) => entry.pr);

describe("upstream queue order", () => {
  it("blocks a batch that starts after the first pending entries", () => {
    const gap = check({ mainCommits: imports(1), candidateCommits: imports(5, 6, 7) });

    assert.deepEqual(
      gap.skipped.map((entry) => entry.pr),
      [102, 103, 104],
    );
    assert.deepEqual(gap.laterCommits, imports(5, 6, 7));
    const error = queueOrderError(gap)!;
    assert.include(
      error,
      "leaves 3 earlier pending queue entries behind while recording later ones: 000200020002 #102 upstream change 2;",
    );
    assert.include(error, "f005f005f005 import upstream change 5;");
    assert.include(error, "`Early-Import: <reason>`");
  });

  it("passes a batch that continues from the reconciled boundary", () => {
    assert.deepEqual(
      skippedPRs({ mainCommits: imports(1), candidateCommits: imports(2, 3, 4) }),
      [],
    );
    assert.isNull(queueOrderError(check({ candidateCommits: imports(1, 2) })));
  });

  it("passes a declared early import inside an in-order batch", () => {
    assert.deepEqual(skippedPRs({ candidateCommits: [...imports(1, 2), earlyImport(8)] }), []);
  });

  it("blocks an undeclared import far ahead of the batch", () => {
    const gap = check({ candidateCommits: imports(1, 2, 8) });

    assert.deepEqual(
      gap.skipped.map((entry) => entry.pr),
      [103, 104, 105, 106, 107],
    );
    assert.deepEqual(gap.laterCommits, imports(8));
  });

  it("counts skip and already-present exceptions as accounted for", () => {
    const exceptions: QueueOrderInput["exceptions"] = {
      [sha(1)]: { disposition: "skip", reason: "Reverted later." },
      [sha(2)]: { disposition: "already present", reason: "Ported in a fork PR." },
    };
    assert.deepEqual(skippedPRs({ exceptions, candidateCommits: imports(3, 4) }), []);
  });

  it("ignores early imports and provisional snapshots already on main", () => {
    const snapshot = { base: sha(0xa), head: sha(0xb) };
    const tracked = [{ number: 106, reason: "Provisional import.", snapshot }];
    assert.deepEqual(
      skippedPRs({
        mainCommits: imports(8, 6),
        mainTracked: tracked,
        candidateTracked: tracked,
        candidateCommits: imports(1, 2, 3),
      }),
      [],
    );
  });
});
