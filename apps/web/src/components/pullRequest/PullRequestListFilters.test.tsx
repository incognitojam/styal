import { CircleIcon } from "lucide-react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestFiltersMenu } from "./PullRequestListFilters";

function menu(overrides: Partial<Parameters<typeof PullRequestFiltersMenu>[0]>) {
  return PullRequestFiltersMenu({
    state: "open",
    stateOptions: [
      { value: "open", label: "Open", Icon: CircleIcon },
      { value: "closed", label: "Closed", Icon: CircleIcon },
    ],
    onState: () => undefined,
    involvement: "all",
    involvementOptions: [{ value: "all", label: "All", Icon: CircleIcon }],
    onInvolvement: () => undefined,
    filters: {},
    onFilters: () => undefined,
    host: undefined,
    hostOptions: [],
    onHost: () => undefined,
    server: undefined,
    serverOptions: [],
    onServer: () => undefined,
    projects: [],
    optionScope: [],
    projectId: undefined,
    projectEnvironmentId: undefined,
    unavailable: new Map(),
    onProject: () => undefined,
    onReset: () => undefined,
    ...overrides,
  });
}

/** The menu item whose own text reads "Reset filters". */
function findResetItem(
  node: ReactNode,
): ReactElement<{ readonly children?: ReactNode; readonly onClick: () => void }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const props = child.props as { readonly children?: ReactNode; readonly onClick?: () => void };
    if (props.onClick && Children.toArray(props.children).includes("Reset filters")) {
      return child as ReactElement<{ readonly children?: ReactNode; readonly onClick: () => void }>;
    }
    const nested = findResetItem(props.children);
    if (nested) return nested;
  }
  return undefined;
}

describe("pull request filters menu", () => {
  it("offers a reset only while a filter is off its default", () => {
    expect(findResetItem(menu({}))).toBeUndefined();
    expect(findResetItem(menu({ filters: { draft: "hide" } }))).toBeDefined();
    const onReset = vi.fn();
    findResetItem(menu({ state: "closed", onReset }))?.props.onClick();
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
