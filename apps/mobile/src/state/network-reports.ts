import { createNetworkReportAtoms } from "@t3tools/client-runtime/network-reports";

import { connectionAtomRuntime } from "../connection/runtime";

export const networkReports = createNetworkReportAtoms(connectionAtomRuntime);
