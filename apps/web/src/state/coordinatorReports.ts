import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const dismissCoordinatorReport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread:report:dismiss",
  tag: ORCHESTRATION_V2_WS_METHODS.dismissReport,
});
