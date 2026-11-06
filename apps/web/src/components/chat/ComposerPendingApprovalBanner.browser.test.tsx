import "../../index.css";

import { RuntimeRequestId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalBanner } from "./ComposerPendingApprovalBanner";

const requestId = RuntimeRequestId.make("command-approval");
const longCommand = `printf '${"long-command ".repeat(400)}'`;
const approval: PendingApproval = {
  requestId,
  requestKind: "command",
  createdAt: "2026-11-06T00:00:00.000Z",
  detail: longCommand,
  reason: "Needs permission to run the command",
  responseCapability: "live",
};

function banner(overrides: Partial<Parameters<typeof ComposerPendingApprovalBanner>[0]> = {}) {
  const onRespondToApproval = vi.fn(async () => undefined);
  return {
    onRespondToApproval,
    element: (
      <ComposerPendingApprovalBanner
        approval={approval}
        pendingCount={1}
        isResponding={false}
        disabled={false}
        onRespondToApproval={onRespondToApproval}
        {...overrides}
      />
    ),
  };
}

it("keeps a long command complete and scrollable, and answers from the keyboard", async () => {
  const { element, onRespondToApproval } = banner({ pendingCount: 2 });
  await using screen = await render(element);

  const detail = screen.getByLabelText("Command to answer", { exact: true });
  await expect.element(detail).toHaveTextContent(longCommand);
  const node = detail.element();
  expect(getComputedStyle(node).overflowY).toBe("auto");
  expect(node.scrollHeight).toBeGreaterThan(node.clientHeight);
  await expect.element(screen.getByText("1/2")).toBeVisible();

  (screen.getByRole("button", { name: "Approve", exact: true }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onRespondToApproval).toHaveBeenLastCalledWith(requestId, "accept");

  await screen.getByRole("button", { name: "More approval options" }).click();
  await page.getByRole("menuitem", { name: "Always allow this session" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(requestId, "acceptForSession");
});

it("cannot answer when the connection cannot operate or the provider is gone", async () => {
  const blocked = banner({ disabled: true });
  await using screen = await render(blocked.element);
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();

  const gone = banner({ approval: { ...approval, responseCapability: "not_resumable" } });
  await screen.rerender(gone.element);
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
});

it("hands a feedback report to its own banner, which offers posting only beside the report", async () => {
  const { element } = banner({
    approval: {
      ...approval,
      toolName: "report_styal_issue",
      toolInput: { title: "A title", body: "A body", repository: "a/b", account: "octocat" },
      options: [
        { decision: "accept", label: "Post publicly" },
        { decision: "decline", label: "Don't send" },
      ],
    },
  });
  await using screen = await render(element);
  await expect.element(screen.getByRole("button", { name: "Review" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Post publicly" }).query()).toBeNull();
});
