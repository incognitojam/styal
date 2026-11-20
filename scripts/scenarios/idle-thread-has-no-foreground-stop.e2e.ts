import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "An idle thread with a watched pull request has no foreground Stop",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("sample-project");
    await t3.thread({
      project,
      title: "Completed sample",
      messages: ["Inspect the sample module"],
    });
    await t3.open();
    await screen.getByText("Completed sample", { exact: true }).first().tap();
    await expect(screen.getByText("first fixture turn complete", { exact: false })).toBeVisible();

    // A watch update can reach the shell after the last thread-detail event.
    await browser.evaluate(`async () => {
    const { appAtomRegistry: registry } = await import('/src/rpc/atomRegistry.ts');
    const { environmentShell } = await import('/src/state/shell.ts');
    const { environmentThreadShells } = await import('/src/state/threads.ts');
    const [environmentId, threadId] = location.pathname.split('/').slice(1).map(decodeURIComponent);
    const stateAtom = environmentShell.stateValueAtom(environmentId);
    const state = registry.get(stateAtom);
    registry.ensureNode(stateAtom).setInitialValue({
      ...state,
      snapshot: { ...state.snapshot, value: {
        ...state.snapshot.value,
        snapshotSequence: state.snapshot.value.snapshotSequence + 1,
      } },
    });
    const shellAtom = environmentThreadShells.threadShellAtom({ environmentId, threadId });
    const shell = registry.get(shellAtom);
    registry.ensureNode(shellAtom).setInitialValue({
      ...shell,
      pendingBackgroundTasks: [{
        taskId: 'pull-request-watch:example/sample:1',
        kind: 'monitor',
        description: 'Sample checks',
      }],
    });
    return null;
  }`);
    await app.screenshot("idle-composer");
    await expect(screen.getByRole("button", "Stop generation", { exact: true })).toBeHidden();
    await expect(screen.getByRole("button", "Submit message", { exact: true })).toBeVisible();
  },
);
