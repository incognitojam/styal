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
    "List registered hardware devices this thread's project may use: whether each is online, who holds its lease, and its actions with their tiers (read: any time; operate: needs your lease; approve: needs your lease and the user's approval). Reach registered hardware only through these tools or the proxy URL from hardware_acquire, never by calling its address directly.",
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
    "Take the lease on a hardware device so this thread can run its operate and approve actions. The lease survives between turns while you keep using it, and ends after the idle time, when you call hardware_release, or when the user revokes it; ending it runs the device's cleanup. Returns a loopback proxyBaseUrl that forwards read and operate actions for scripts on this machine, e.g. `curl $proxyBaseUrl/calibrate/led?n=3`. Calling it again renews the lease.",
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
    "Run one action from hardware_list on a device. Read actions work without a lease. Operate and approve actions need this thread's lease; approve actions wait until the user answers an approval card (up to 10 minutes) and fail if they decline.",
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
    "Hand a hardware device back when you are done so other threads can use it. Runs the device's cleanup, such as leaving calibration mode.",
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
