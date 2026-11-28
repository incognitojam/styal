import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { TunnelSnapshot } from "./AccountTunnels.ts";

export class AccountReservation extends Context.Service<
  AccountReservation,
  {
    userId: string;
    reservationGeneration: number;
    uuid: Effect.Effect<string>;
    state: TunnelSnapshot;
    record: (allocations: TunnelSnapshot["allocations"]) => Promise<void>;
  }
>()("t3code-relay/objects/AccountReservation") {}
