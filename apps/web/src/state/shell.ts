import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

let previousEnvironmentShellStatuses: ReadonlyMap<EnvironmentId, EnvironmentShellStatus> =
  new Map();
export const environmentShellStatusesAtom = Atom.make((get) => {
  const next = new Map<EnvironmentId, EnvironmentShellStatus>();
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    next.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
  }
  if (
    next.size === previousEnvironmentShellStatuses.size &&
    [...next].every(
      ([environmentId, status]) => status === previousEnvironmentShellStatuses.get(environmentId),
    )
  ) {
    return previousEnvironmentShellStatuses;
  }
  previousEnvironmentShellStatuses = next;
  return previousEnvironmentShellStatuses;
}).pipe(Atom.withLabel("web-environment-shell-statuses"));

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));
