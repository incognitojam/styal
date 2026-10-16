import * as Context from "effect/Context";

import type { PreparedConnection } from "../connection/model.ts";
import type { SocketMeter } from "./collector.ts";

/**
 * Hands each new RPC session a meter for its socket. The network reports
 * layer provides it; without that layer sessions are not measured.
 */
export class NetworkMeters extends Context.Reference<{
  readonly forConnection: (connection: PreparedConnection) => SocketMeter | undefined;
}>("@t3tools/client-runtime/networkReports/meter/NetworkMeters", {
  defaultValue: () => ({ forConnection: () => undefined }),
}) {}
