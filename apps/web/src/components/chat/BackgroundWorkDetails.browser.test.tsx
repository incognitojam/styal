import "~/index.css";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
vi.mock(import("./CommandOutputPanel"), () => ({
  useCommandOutputStreaming: () => true,
  CommandOutputPanel: ({ threadId, itemId }) => (
    <div>
      Command output stream for {threadId}/{itemId}
    </div>
  ),
}));

import { render } from "../../../test/render";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { ThreadNow } from "./ThreadNow";

it("opens full command details for short labels and keeps pending tasks current", async () => {
  const command = "python3 audit.py -j 6\n> scratch/audit.log 2>&1";
  const sourceThreadId = ThreadId.make("source-thread");
  const commandItem = (status: "running" | "completed") => ({
    id: TurnItemId.make("bash-1"),
    threadId: sourceThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-09T00:00:00Z"),
    type: "command_execution" as const,
    input: command,
    output: "Command running in background with ID: native-task",
  });
  const view = (
    description?: string,
    status: "running" | "completed" = "completed",
    ownership: "explicit" | "stored" | "native" = "explicit",
  ) => (
    <ThreadNow
      attention={null}
      syncPhase={null}
      goal={null}
      work={backgroundWorkNowItem({
        environmentId: EnvironmentId.make("test"),
        threadId: ThreadId.make("thread"),
        tasks: [
          {
            taskId: "native-task",
            itemId: ownership === "explicit" ? TurnItemId.make("bash-1") : undefined,
            kind: "command",
            description,
            command:
              ownership === "native"
                ? undefined
                : {
                    nativeItemId: "toolu-bash-1",
                    turnItemId: TurnItemId.make("bash-1"),
                    nodeId: NodeId.make("bash-1-node"),
                    threadId: sourceThreadId,
                    runId: null,
                    rootNodeId: NodeId.make("root-node"),
                    parentNodeId: NodeId.make("root-node"),
                    providerThreadId: null,
                    providerTurnId: null,
                    ordinal: 1,
                    input: command,
                    startedAt: "2026-11-09T00:00:00Z",
                  },
            awaited: true,
          },
        ],
        turnItems: [
          commandItem(status),
          {
            ...commandItem("running"),
            id: TurnItemId.make("native-match"),
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-task",
              strength: "strong",
            },
            ordinal: 2,
          },
        ],
        stopDisabled: false,
        stopping: false,
        onStop: async () => undefined,
        onOpenThread: () => undefined,
      })}
    />
  );
  await using screen = await render(view("Audit"));
  await screen.getByRole("button", { name: "Details", exact: true }).click();
  await vi.waitFor(() => expect(page.getByRole("dialog").element().textContent).toContain(command));
  await expect.element(page.getByText("Command output stream")).not.toBeInTheDocument();

  await screen.rerender(view(command));
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();
  await screen.rerender(view());
  await expect.element(page.getByRole("heading", { name: "Command", exact: true })).toBeVisible();

  await screen.rerender(view("Check remaining modules", "running"));
  await expect
    .element(page.getByRole("heading", { name: "Check remaining modules" }))
    .toBeVisible();
  await expect
    .element(page.getByText("Command output stream for source-thread/bash-1"))
    .toBeVisible();
  await screen.rerender(view("Stored ownership", "running", "stored"));
  await expect
    .element(page.getByText("Command output stream for source-thread/bash-1"))
    .toBeVisible();
  await screen.rerender(view("Native fallback", "completed", "native"));
  await expect
    .element(page.getByText("Command output stream for source-thread/native-match"))
    .toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
