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

  it("follows the configured behavior once a turn is running", () => {
    const queueing = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "queue",
    });
    const steering = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: true,
      followUpBehavior: "steer",
    });

    expect(queueing.label).toBe("Queue");
    expect(queueing.icon).toBe("list.number");
    expect(queueing.action).toBe("queue");
    expect(queueing.alternate).toBe("steer");
    expect(steering.label).toBe("Steer");
    expect(steering.icon).toBe("arrow.turn.left.up");
    expect(steering.action).toBe("steer");
    expect(steering.alternate).toBe("queue");
    expect(steering.offersFollowUpChoice).toBe(true);
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
