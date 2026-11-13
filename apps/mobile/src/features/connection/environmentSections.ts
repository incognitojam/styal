import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

export interface EnvironmentSectionsInput {
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly cloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord> | null;
}

export interface EnvironmentSections {
  readonly localEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectedCloudEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly availableCloudEnvironments: ReadonlyArray<RelayClientEnvironmentRecord>;
}

/**
 * Ids of the environments that already occupy a styal Link slot. A backend saved directly is
 * not one of them, so it must not suppress the cloud environment that happens to share its id.
 */
export function relayManagedEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly isRelayManaged: boolean;
  }>,
): ReadonlySet<EnvironmentId> {
  return new Set(
    environments
      .filter((environment) => environment.isRelayManaged)
      .map((environment) => environment.environmentId),
  );
}

export function splitEnvironmentSections(input: EnvironmentSectionsInput): EnvironmentSections {
  const savedEnvironmentIds = relayManagedEnvironmentIds(input.connectedEnvironments);

  return {
    localEnvironments: input.connectedEnvironments.filter(
      (environment) => !environment.isRelayManaged,
    ),
    connectedCloudEnvironments: input.connectedEnvironments.filter(
      (environment) => environment.isRelayManaged,
    ),
    availableCloudEnvironments: (input.cloudEnvironments ?? []).filter(
      (environment) => !savedEnvironmentIds.has(environment.environmentId),
    ),
  };
}

export function machineListEntries<
  T extends { readonly environmentId: EnvironmentId; readonly label: string },
>(saved: ReadonlyArray<T>, discovered: ReadonlyArray<RelayClientEnvironmentRecord>) {
  const known = new Set(saved.map((machine) => machine.environmentId));
  return [
    ...saved.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      saved: machine,
    })),
    ...discovered
      .filter((machine) => !known.has(machine.environmentId))
      .map((machine) => ({
        environmentId: machine.environmentId,
        label: machine.label,
        saved: null,
      })),
  ];
}
export function untabbedMachineLinks<T extends { readonly environmentId: EnvironmentId }>(
  links: ReadonlyArray<T>,
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
) {
  const known = new Set(machines.map((machine) => machine.environmentId));
  return links.filter((link) => !known.has(link.environmentId));
}
