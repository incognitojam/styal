/**
 * What the Checks tab says for the three sets it has to answer for: none reported, a green run,
 * and a failing one with a hand-off on it. The component is called as a plain function and its
 * tree read for text — it holds no state of its own, so nothing here needs a renderer.
 */
import type { PullRequestCheck } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestChecksNavButton, PullRequestChecksTab } from "./PullRequestChecksTab";
import { pullRequestFindingKey } from "./pullRequestDetail.logic";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function check(overrides: Partial<PullRequestCheck> = {}): PullRequestCheck {
  return { name: "build", status: "success", description: null, url: null, ...overrides };
}

function render(props: Parameters<typeof PullRequestChecksTab>[0]): string {
  return textOf(PullRequestChecksTab(props));
}

describe("PullRequestChecksTab", () => {
  it("keeps the empty answer readable, so the tab is worth opening with no checks", () => {
    const text = render({ checks: [] });
    expect(text).toContain("No checks reported.");
    // No verdict to head a list that has nothing in it.
    expect(text).not.toContain("All checks have passed");
  });

  it("heads the list with the host's rollup and the count behind it", () => {
    const text = render({ checks: [check(), check({ name: "lint" })] });
    expect(text).toContain("All checks have passed");
    expect(text).toContain("All checks passed");
    expect(text).toContain("build");
    expect(text).toContain("Passed");
  });

  it("offers the fix only on the checks that failed", () => {
    const failing = check({ name: "typecheck", status: "failure" });
    const text = render({
      checks: [check(), failing],
      fixCheckLabel: "Fix",
      onFixFinding: () => {},
    });
    expect(text).toContain("Some checks were not successful");
    expect(text).toContain("1 of 2 failing");
    // One button for the one failing run, and none for the run that passed.
    expect(text.match(/Fix/g)).toHaveLength(1);
  });

  it("says which check is preparing, and leaves the rest of the buttons alone", () => {
    const failing = check({ name: "typecheck", status: "failure" });
    const text = render({
      checks: [failing],
      fixCheckLabel: "Fix",
      pendingFinding: pullRequestFindingKey({ kind: "check", check: failing }),
      onFixFinding: () => {},
    });
    expect(text).toContain("Preparing...");
    expect(text).not.toContain("Fix");
  });

  it("draws no fix button where there is nowhere to hand the failure to", () => {
    const text = render({ checks: [check({ status: "failure" })] });
    expect(text).not.toContain("Fix");
  });
});

describe("PullRequestChecksNavButton", () => {
  it("opens the Checks tab from the tab bar summary", () => {
    const onSelect = vi.fn();
    const element = PullRequestChecksNavButton({
      checks: [check({ status: "failure" }), check({ name: "lint" })],
      onSelect,
    });
    const props = element.props as {
      readonly onClick: () => void;
      readonly className: string;
      readonly "aria-label": string;
    };

    expect(element.type).toBe("button");
    expect(props["aria-label"]).toBe("Open checks: 1 of 2 failing");
    expect(props.className).toContain("hover:bg-accent");

    props.onClick();
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
