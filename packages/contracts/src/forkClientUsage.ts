import * as Schema from "effect/Schema";

/** Bump when extending the vocabulary; clients require the complete version before reporting. */
export const FORK_CLIENT_USAGE_VERSION = 4;

export const WebBuildUpdateUsageAction = Schema.Literals(["notice_shown", "refresh_requested"]);
export type WebBuildUpdateUsageAction = typeof WebBuildUpdateUsageAction.Type;

/** Closed UI observations only: content, paths and identifiers stay in the client. */
export const ForkClientUsageInput = Schema.Union([
  Schema.Struct({
    feature: Schema.Literal("pull-request-deployments"),
    action: Schema.Literals(["open_environment", "open_logs", "show_all"]),
    outcome: Schema.Literals(["success", "failure"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("web-build-update-notice"),
    action: WebBuildUpdateUsageAction,
  }),
  Schema.Struct({
    feature: Schema.Literal("diff-file-review-order"),
    action: Schema.Literals(["relevance_selected", "alphabetical_selected"]),
    view: Schema.Literals(["changes", "pull_request"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("mentioned-time-chips"),
    action: Schema.Literal("details_opened"),
  }),
  Schema.Struct({
    feature: Schema.Literal("setup-thread-settlement"),
    action: Schema.Literal("continued"),
    settleOnMerge: Schema.Boolean,
    settleWhenInactive: Schema.Boolean,
  }),
  Schema.Struct({
    feature: Schema.Literal("sidebar-project-filter"),
    action: Schema.Literals(["filter_set", "filter_cleared"]),
    entryPoint: Schema.Literals(["filter_menu", "project_menu", "thread_menu"]),
  }),
  Schema.Struct({
    feature: Schema.Literal("sidebar-project-filter"),
    action: Schema.Literal("thread_started"),
  }),
]);
export type ForkClientUsageInput = typeof ForkClientUsageInput.Type;
