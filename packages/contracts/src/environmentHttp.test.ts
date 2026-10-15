import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  HostActivity,
} from "./environmentHttp.ts";

const traceId = "trace-1";
const decodeHostActivity = Schema.decodeSync(HostActivity);

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});

describe("HostActivity", () => {
  it("reads activity from servers that predate shared device use", () => {
    const activity = decodeHostActivity({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
    });
    expect(activity.environmentsUsingDevices).toBe(0);
    expect(activity.threads).toBeUndefined();
  });

  it("distinguishes a checked empty thread list from older servers without details", () => {
    const activity = decodeHostActivity({
      activeSessions: 0,
      continuableSessions: 0,
      waitingSessions: 0,
      threads: [],
      terminalsRequiringConfirmation: 0,
      terminalsWithUnknownActivity: 0,
    });
    expect(activity.threads).toEqual([]);
  });
});
