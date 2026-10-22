import type { ProjectFileActionReview } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileActionApprovalWarning,
  fileActionCommandChanged,
  fileActionFullyApproved,
  fileActionRolesSentence,
} from "./projectFileActions.ts";

const review = (overrides: Partial<ProjectFileActionReview> = {}): ProjectFileActionReview => ({
  actionId: "setup",
  name: "Setup",
  command: "./scripts/setup.sh",
  roles: ["setup"],
  approved: null,
  hint: { kind: "none" },
  ...overrides,
});

describe("fileActionApprovalWarning", () => {
  it("names the files the command runs", () => {
    expect(fileActionApprovalWarning({ kind: "files", paths: ["scripts/setup.sh"] })).toBe(
      "Later changes to `scripts/setup.sh` run without asking again.",
    );
    expect(fileActionApprovalWarning({ kind: "files", paths: ["a.sh", "b.sh"] })).toBe(
      "Later changes to `a.sh` and `b.sh` run without asking again.",
    );
  });

  it("names a package.json script", () => {
    expect(fileActionApprovalWarning({ kind: "package-script", script: "setup" })).toBe(
      "Later changes to the `setup` script in `package.json` run without asking again.",
    );
  });

  it("falls back to the generic line", () => {
    expect(fileActionApprovalWarning({ kind: "none" })).toBe(
      "Approves this exact command. Changes to files it runs won't ask again.",
    );
  });
});

describe("approval state", () => {
  const approvedAt = "2026-10-21T12:00:00.000Z";

  it("describes roles in plain words", () => {
    expect(fileActionRolesSentence(["setup", "settle"])).toBe(
      "Runs after a worktree is created and when a thread settles.",
    );
  });

  it("is fully approved only for the same command and every role", () => {
    expect(fileActionFullyApproved(review())).toBe(false);
    expect(
      fileActionFullyApproved(
        review({ approved: { command: "./scripts/setup.sh", roles: ["setup"], approvedAt } }),
      ),
    ).toBe(true);
    expect(
      fileActionFullyApproved(
        review({
          roles: ["setup", "settle"],
          approved: { command: "./scripts/setup.sh", roles: ["setup"], approvedAt },
        }),
      ),
    ).toBe(false);
  });

  it("notices a changed command", () => {
    const changed = review({ approved: { command: "./setup.sh", roles: ["setup"], approvedAt } });
    expect(fileActionCommandChanged(changed)).toBe(true);
    expect(fileActionFullyApproved(changed)).toBe(false);
  });
});
