import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../../lib/followUpBehavior";
import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("steers by default while running and keeps queue as the alternate action", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
    });

    expect(presentation.label).toBe("Steer");
    expect(presentation.action).toBe("steer");
    expect(presentation.alternate).toBe("queue");
  });

  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });
});
