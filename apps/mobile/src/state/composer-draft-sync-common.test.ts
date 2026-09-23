import { describe, expect, it } from "@effect/vitest";
import { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";

import { composerDraftSyncCommon } from "./composer-draft-sync-common";

const terminalRecord = {
  version: 1 as const,
  kind: "terminal" as const,
  contextId: ComposerContextId.make("terminal-1"),
  label: "Terminal 1 · visible lines 1–2",
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1 (visible output)",
  lineStart: 1,
  lineEnd: 2,
  text: "npm ERR! missing optional dependency",
};

describe("composerDraftSyncCommon", () => {
  it("shares a text-only draft", () => {
    expect(composerDraftSyncCommon({ text: "Reinstall Codex", attachments: [] })).toEqual({
      text: "Reinstall Codex",
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
    });
  });

  it("keeps a draft with a context chip on this device", () => {
    expect(
      composerDraftSyncCommon({
        text: `Why did this fail? ${formatComposerContextReference(terminalRecord)} `,
        context: { version: 1, records: [terminalRecord] },
        attachments: [],
      }),
    ).toBeNull();
  });
});
