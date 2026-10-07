import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function createSourceControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const defaultRepository = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:source-control:default-repository",
    tag: WS_METHODS.sourceControlGetDefaultRepository,
  });
  return {
    discovery: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:source-control-discovery",
      tag: WS_METHODS.serverDiscoverSourceControl,
    }),
    repository: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:repository",
      tag: WS_METHODS.sourceControlLookupRepository,
    }),
    defaultRepository,
    issues: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:issues",
      tag: WS_METHODS.sourceControlListIssues,
    }),
    issue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:issue",
      tag: WS_METHODS.sourceControlGetIssue,
    }),
    references: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:source-control:references",
      tag: WS_METHODS.sourceControlResolveReferences,
    }),
    cloneRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:clone-repository",
      tag: WS_METHODS.sourceControlCloneRepository,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    setDefaultRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:set-default-repository",
      tag: WS_METHODS.sourceControlSetDefaultRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      // A new default can move the checkout to another project group, whose
      // settings rows read the default again; they must not get the old pin.
      onSuccess: ({ environmentId, input: { cwd } }, registry) =>
        Effect.sync(() => registry.refresh(defaultRepository({ environmentId, input: { cwd } }))),
    }),
    // Clone-backed project creation. The RPC returns once the project exists
    // and the clone runs in the background; `projectClones` carries progress.
    startProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-start",
      tag: WS_METHODS.projectCloneStart,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Cancel and retry share the start queue so a double click cannot race
    // two actions against the same clone.
    cancelProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-cancel",
      tag: WS_METHODS.projectCloneCancel,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    retryProjectClone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:project-clone-retry",
      tag: WS_METHODS.projectCloneRetry,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId }) => environmentId,
      },
    }),
    // Every clone the environment tracks. Empty until a clone starts; a
    // finished clone drops out after a grace period, a failed one stays.
    projectClones: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:source-control:project-clones",
      tag: WS_METHODS.subscribeProjectClones,
    }),
    publishRepository: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:source-control:publish-repository",
      tag: WS_METHODS.sourceControlPublishRepository,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: (target, registry) =>
        invalidateCachedVcsRefs(registry, {
          environmentId: target.environmentId,
          cwd: target.input.cwd,
        }),
    }),
  };
}
