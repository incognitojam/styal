import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  respond: vi.fn(),
  approvalsAtom: null as unknown,
  childrenAtom: null as unknown,
}));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/threads", () => ({
  childThreadApprovalsAtom: () => state.approvalsAtom,
  environmentThreadDetails: {},
  environmentThreadShells: { childThreadInputsAtom: () => state.childrenAtom },
  threadEnvironment: { respondToApproval: {} },
}));

import { ChildThreadApprovals } from "./ProjectNeedsYou";

function setup() {
  state.respond.mockReset();
  state.respond
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Child environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const thread = {
    environmentId: EnvironmentId.make("child-env"),
    threadId: ThreadId.make("child"),
  };
  state.approvalsAtom = Atom.make<ReadonlyArray<ChildThreadApproval>>([
    {
      thread,
      title: "Compile task",
      approval: {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        detail: "tsc --build",
        toolInput: { command: "tsc --build" },
        createdAt: "2026-11-01T00:00:00.000Z",
        responseCapability: "live",
      },
    },
  ]);
  state.childrenAtom = Atom.make([
    { environmentId: thread.environmentId, id: thread.threadId, title: "Compile task" },
  ] as unknown as ReadonlyArray<EnvironmentThreadShell>);
  return thread;
}

it("says what the subagent asks, and shows a failed decision until the user retries", async () => {
  const thread = setup();
  await using screen = await render(<ChildThreadApprovals threadRef={thread} />);
  const card = screen.getByRole("region", { name: "Approval from Compile task" });
  await expect.element(card.getByText("Wants to run tsc --build")).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Open thread" })).toBeVisible();
  await card.getByRole("button", { name: "More approval options" }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Always allow this session in “Compile task”" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
