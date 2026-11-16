import { createDismissCoordinatorReportCommand } from "@t3tools/client-runtime/coordinator-reports";
import { connectionAtomRuntime } from "../connection/runtime";

export const dismissCoordinatorReport =
  createDismissCoordinatorReportCommand(connectionAtomRuntime);
