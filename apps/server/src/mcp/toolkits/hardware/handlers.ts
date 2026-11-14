import { HardwareToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HardwareToolkit } from "./tools.ts";

const requireHardwareAccess = McpInvocationContext.requireThreadMcpCapability("hardware").pipe(
  Effect.mapError(
    () =>
      new HardwareToolError({
        code: "unavailable",
        reason:
          "Agent hardware access is turned off. The user can enable it in Settings → Hardware.",
      }),
  ),
);

const handlers = {
  hardware_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireHardwareAccess;
      const hardware = yield* HardwareService.HardwareService;
      return { devices: yield* hardware.listForThread(scope.thread.threadId, input.device) };
    }),
  ),
  hardware_acquire: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireHardwareAccess;
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.acquire(scope.thread.threadId, input);
    }),
  ),
  hardware_call: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireHardwareAccess;
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.call(scope.thread.threadId, input);
    }),
  ),
  hardware_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireHardwareAccess;
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.release(scope.thread.threadId, input.device);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof HardwareToolkit.tools>;

export const layer = McpToolAccess.toLayer(HardwareToolkit, handlers);
