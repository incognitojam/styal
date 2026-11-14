import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** Keep the advertised version compatible with clients that still send retired reports. */
export const FORK_CLIENT_USAGE_VERSION = 32;

export const ForkClientUsageInput = Schema.Struct({
  feature: Schema.Literal("device-stream-health"),
  action: Schema.Literal("session_ended"),
  platform: Schema.Literals(["android", "ios"]),
  transport: Schema.Literals(["h264", "avcc", "mjpeg"]),
  connection: Schema.Literals(["loopback", "network"]),
  durationSeconds: NonNegativeInt,
  averageFps: NonNegativeInt,
  decoderResets: NonNegativeInt,
  reconnects: NonNegativeInt,
  stalls: Schema.NullOr(NonNegativeInt),
  longestGapMs: Schema.NullOr(NonNegativeInt),
  maxAddedDelayMs: Schema.NullOr(NonNegativeInt),
});
export type ForkClientUsageInput = typeof ForkClientUsageInput.Type;

// Older clients still send retired usage; discard their values at the RPC boundary.
export const ReportForkClientUsageInput = Schema.Union([
  ForkClientUsageInput,
  Schema.Struct({
    feature: Schema.Literals([
      "integration-settings",
      "pull-request-deployments",
      "web-build-update-notice",
      "combined-update-confirmation",
      "diff-file-review-order",
      "mentioned-time-chips",
      "setup-thread-settlement",
      "sidebar-project-filter",
      "sidebar-project-groups",
      "next-unread-thread",
      "desktop-update-notice",
      "project-actions",
      "pull-request-bypass-merge",
      "incoming-share-thread",
      "shortcuts-overview",
      "work-together",
      "provider-sign-in",
      "completion-sounds",
      "machine-access",
      "machine-list",
      "client-settings",
      "mobile-settings",
    ]),
    action: Schema.String,
  }),
]);
export type ReportForkClientUsageInput = typeof ReportForkClientUsageInput.Type;
