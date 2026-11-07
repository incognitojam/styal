import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadSearchInput,
  type OrchestratorMcpThreadSearchPage,
  type OrchestratorMcpThreadSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as FeatureUsage from "../telemetry/FeatureUsage.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { readCaller, unavailable } from "./threadAccess.ts";

export class ThreadSearchMcpService extends Context.Service<
  ThreadSearchMcpService,
  {
    readonly search: (
      input: OrchestratorMcpThreadSearchInput,
    ) => Effect.Effect<
      OrchestratorMcpThreadSearchResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
    >;
  }
>()("@styal/cli/mcp/ThreadSearchMcpService") {}

type Machine = OrchestratorMcpThreadSearchResult["machines"][number];
type Match = OrchestratorMcpThreadSearchResult["matches"][number];

const make = Effect.gen(function* () {
  const search = yield* ThreadSearch.ThreadSearch;
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

  const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
  const searchAcrossMachines = Effect.fn("ThreadSearchMcpService.search")(
    function* (input: OrchestratorMcpThreadSearchInput) {
      const { scope, caller } = yield* readCaller();
      const label = Option.isSome(environment)
        ? (yield* environment.value.getDescriptor).label
        : scope.environmentId;
      const single = input.environmentId !== undefined || input.projectId !== undefined;
      const localOnly = scope.client?.linked === true;
      if (
        localOnly &&
        input.environmentId !== undefined &&
        input.environmentId !== scope.environmentId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "A forwarded search only searches the machine receiving it.",
        });
      }
      const notes: string[] = [];
      const pages: Array<{ readonly machine: Machine; readonly matches: ReadonlyArray<Match> }> =
        [];
      const labelled = (
        page: OrchestratorMcpThreadSearchPage,
        environmentId: EnvironmentId,
        environmentLabel: string,
      ) =>
        page.matches.map((match) => ({
          ...match,
          environmentId,
          environmentLabel,
          link:
            match.link ??
            McpInvocationContext.threadLinkFor(
              environmentId === scope.environmentId ? scope : { environmentId, client: undefined },
              match.threadId,
            ),
        }));
      if (input.environmentId === undefined || input.environmentId === scope.environmentId) {
        const page = yield* search
          .searchThreads({
            query: input.query,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            projectId: input.projectId ?? (single || localOnly ? caller?.projectId : undefined),
          })
          .pipe(Effect.mapError(unavailable));
        pages.push({
          machine: {
            environmentId: scope.environmentId,
            environmentLabel: label,
            status: "searched",
          },
          matches: labelled(page, scope.environmentId, label),
        });
      }
      const includePeers =
        !localOnly &&
        (input.environmentId === undefined
          ? input.projectId === undefined
          : input.environmentId !== scope.environmentId);
      if (includePeers) {
        if (scope.linkedEnvironments === false || Option.isNone(forwarding)) {
          notes.push(
            "Linked machines were not searched: linked environments is off or unavailable here.",
          );
        } else {
          const peers = forwarding.value;
          const listed = yield* peers.links(scope).pipe(Effect.result);
          if (listed._tag === "Failure") {
            notes.push(`Linked machines were not searched: ${listed.failure.message}`);
          } else {
            const links = [
              ...new Map(listed.success.links.map((link) => [link.environmentId, link])).values(),
            ].filter(
              (link) =>
                link.environmentId !== scope.environmentId &&
                (input.environmentId === undefined
                  ? input.projectId === undefined
                  : link.environmentId === input.environmentId),
            );
            if (input.environmentId !== undefined && links.length === 0) {
              pages.push({
                machine: {
                  environmentId: input.environmentId,
                  environmentLabel: input.environmentId,
                  status: "skipped",
                  reason: "This machine is not linked.",
                },
                matches: [],
              });
            }
            const remote = yield* Effect.forEach(
              links,
              (link) =>
                Effect.gen(function* () {
                  const machine = {
                    environmentId: link.environmentId,
                    environmentLabel: link.label,
                  };
                  if (link.status !== "reachable") {
                    return {
                      machine: {
                        ...machine,
                        status:
                          link.status === "unreachable"
                            ? ("offline" as const)
                            : ("skipped" as const),
                        reason:
                          link.status === "expired"
                            ? "The link has expired."
                            : "The machine did not answer.",
                      },
                      matches: [],
                    };
                  }
                  const result = yield* peers
                    .searchThreads(scope, link.environmentId, {
                      query: input.query,
                      ...(input.limit === undefined ? {} : { limit: input.limit }),
                      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                    })
                    .pipe(Effect.timeout("10 seconds"), Effect.result);
                  if (result._tag === "Failure") {
                    return {
                      machine: {
                        ...machine,
                        status:
                          result.failure._tag === "TimeoutError"
                            ? ("offline" as const)
                            : ("skipped" as const),
                        reason:
                          result.failure._tag === "TimeoutError"
                            ? "The search timed out."
                            : result.failure.message,
                      },
                      matches: [],
                    };
                  }
                  return {
                    machine: { ...machine, status: "searched" as const },
                    matches: labelled(result.success, link.environmentId, link.label),
                  };
                }),
              { concurrency: 2 },
            );
            pages.push(...remote);
          }
        }
      }
      const limit = input.limit ?? 50;
      const matches: Match[] = [];
      // Peers rank independently, so interleave their ranked pages instead of inventing a global score.
      for (let index = 0; index < limit && matches.length < limit; index++) {
        for (const page of pages) {
          const match = page.matches[index];
          if (match !== undefined && matches.length < limit) matches.push(match);
        }
      }
      return { matches, machines: pages.map((page) => page.machine), notes };
    },
    (operation, input) =>
      Effect.flatMap(McpInvocationContext.McpInvocationContext, (scope) =>
        input.environmentId !== undefined ||
        input.projectId !== undefined ||
        scope.client?.linked === true ||
        Option.isNone(analytics)
          ? operation
          : FeatureUsage.observe(
              { feature: "fleet-thread-search", action: "search", source: "agent" },
              operation,
            ).pipe(Effect.provideService(AnalyticsService.AnalyticsService, analytics.value)),
      ),
  );
  return ThreadSearchMcpService.of({ search: searchAcrossMachines });
});

export const layer = Layer.effect(ThreadSearchMcpService, make);
