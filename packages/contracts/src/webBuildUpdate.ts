import * as Schema from "effect/Schema";

export const WebBuildUpdateUsageAction = Schema.Literals(["notice_shown", "refresh_requested"]);
export type WebBuildUpdateUsageAction = typeof WebBuildUpdateUsageAction.Type;

/** UI observations only: deployment identifiers and page content stay in the client. */
export const WebBuildUpdateUsageInput = Schema.Struct({ action: WebBuildUpdateUsageAction });
export type WebBuildUpdateUsageInput = typeof WebBuildUpdateUsageInput.Type;
