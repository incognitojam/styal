import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

// Bumped by each successful source checkout; project file and folder reads refresh on it.
export const sourceCheckoutRevision = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(0).pipe(Atom.keepAlive),
);

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const checkoutState = Atom.family((_target: { environmentId: EnvironmentId; cwd: string }) =>
    Atom.make<{ pending: boolean; error: string | null }>({ pending: false, error: null }),
  );
  const checkout = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:git:check-out-sources",
    tag: WS_METHODS.gitCheckOutSources,
    scheduler: vcsCommandScheduler,
    concurrency: vcsCommandConcurrency,
  });
  return {
    sourceCheckoutAction: checkoutState,
    checkOutSources: {
      ...checkout,
      run: async (registry, target) => {
        const state = checkoutState({ environmentId: target.environmentId, cwd: target.input.cwd });
        registry.set(state, { pending: true, error: null });
        const result = await checkout.run(registry, target);
        if (result._tag === "Success") {
          registry.update(sourceCheckoutRevision(target.environmentId), (revision) => revision + 1);
        }
        const error = result._tag === "Failure" ? Cause.squash(result.cause) : null;
        registry.set(state, {
          pending: false,
          error: error === null ? null : error instanceof Error ? error.message : String(error),
        });
        return result;
      },
    } satisfies typeof checkout,
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
      onSettled: ({ environmentId, input }, registry) =>
        invalidateCachedVcsRefs(registry, { environmentId, cwd: input.cwd }),
    }),
  };
}
