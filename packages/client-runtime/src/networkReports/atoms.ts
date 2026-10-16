import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import { createRuntimeCommand } from "../state/runtime.ts";
import { NetworkReports, type StoredNetworkReport } from "./service.ts";

const NO_REPORTS: ReadonlyArray<StoredNetworkReport> = [];

export function createNetworkReportAtoms<R, E>(runtime: Atom.AtomRuntime<NetworkReports | R, E>) {
  const reportsAtom = runtime.atom(
    Stream.unwrap(
      NetworkReports.pipe(Effect.map((service) => SubscriptionRef.changes(service.reports))),
    ),
    { initialValue: NO_REPORTS },
  );
  const reportsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(reportsAtom)), () => NO_REPORTS),
  ).pipe(Atom.withLabel("network-reports-value"));
  const clear = createRuntimeCommand(runtime, {
    label: "network-reports:clear",
    execute: () => NetworkReports.pipe(Effect.flatMap((service) => service.clear)),
  });
  return { reportsValueAtom, clear };
}
