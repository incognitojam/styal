import {
  HardwareToolAcquireInput,
  HardwareToolAcquireResult,
  HardwareToolCallInput,
  HardwareToolCallResult,
  HardwareToolError,
  HardwareToolListInput,
  HardwareToolListResult,
  HardwareToolReleaseInput,
  HardwareToolReleaseResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HardwareService.HardwareService,
];

/** What a hardware tool fails with, including the access gate's refusal. */
const HardwareToolFailure = Schema.Union([HardwareToolError, OrchestratorMcpFailure]);

/**
 * Registered network devices, such as a microcontroller with an HTTP API.
 * Only one thread holds a device at a time; actions the user marked as needing
 * approval wait for them. Scripts use the proxy URL hardware_acquire returns.
 */
const HardwareListTool = Tool.make("hardware_list", {
  description:
    "List hardware this thread's project may use: online state, lease holder, and actions by tier (read: any time; operate: your lease; approve: your lease and the user's approval). Reach hardware only through these tools or the `hardware_acquire` proxy URL, never its address.",
  parameters: HardwareToolListInput,
  success: HardwareToolListResult,
  failure: HardwareToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List hardware")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const HardwareAcquireTool = Tool.make("hardware_acquire", {
  description:
    "Lease a hardware device for its operate and approve actions. The lease lasts across turns until it idles out, `hardware_release`, or the user revokes it; ending it runs cleanup. Returns a loopback `proxyBaseUrl` for read and operate actions from scripts, e.g. `curl $proxyBaseUrl/calibrate/led?n=3`. Call again to renew.",
  parameters: HardwareToolAcquireInput,
  success: HardwareToolAcquireResult,
  failure: HardwareToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Acquire hardware")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const HardwareCallTool = Tool.make("hardware_call", {
  description:
    "Run one `hardware_list` action. Read needs no lease. Operate and approve need your lease; approve waits up to 10 minutes for the user's approval and fails if they decline.",
  parameters: HardwareToolCallInput,
  success: HardwareToolCallResult,
  failure: HardwareToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Call hardware")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const HardwareReleaseTool = Tool.make("hardware_release", {
  description:
    "Hand a hardware device back when done so other threads can use it. Runs its cleanup, such as leaving calibration mode.",
  parameters: HardwareToolReleaseInput,
  success: HardwareToolReleaseResult,
  failure: HardwareToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Release hardware")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const HardwareToolkit = Toolkit.make(
  HardwareListTool,
  HardwareAcquireTool,
  HardwareCallTool,
  HardwareReleaseTool,
);
