import {
  PULL_REQUEST_DEPLOYMENT_PAGE,
  PULL_REQUEST_DEPLOYMENT_STATUS_LABELS,
  isFailedPullRequestDeployment,
  orderPullRequestDeployments,
  pullRequestDeploymentCommit,
  pullRequestDeploymentsTitle,
} from "@t3tools/client-runtime/pull-request-deployments";
import {
  EnvironmentId,
  type PullRequestDeployment,
  type PullRequestDeploymentStatus,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { reportForkClientUsage } from "../../state/forkClientUsage";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { PR_ROW_LAYOUT } from "./pullRequestAnimations";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { PullRequestSectionHeading } from "./PullRequestSectionHeading";

const STATUS_ICONS: Record<PullRequestDeploymentStatus, { icon: AppSymbolName; tint: string }> = {
  success: { icon: "checkmark.circle", tint: "accent-adaptive-emerald-600-400" },
  failure: { icon: "exclamationmark.circle", tint: "accent-danger-foreground" },
  error: { icon: "exclamationmark.circle", tint: "accent-danger-foreground" },
  "in-progress": { icon: "clock", tint: "accent-warning-foreground" },
  queued: { icon: "clock", tint: "accent-warning-foreground" },
  pending: { icon: "clock", tint: "accent-warning-foreground" },
  waiting: { icon: "clock", tint: "accent-warning-foreground" },
  inactive: { icon: "minus", tint: "accent-icon-muted" },
  unknown: { icon: "circle.dashed", tint: "accent-icon-muted" },
};

type UsageAction = "open_environment" | "open_logs";

/** Render only when the PR has deployments: the section keeps a clock running for its ages. */
export function PullRequestDeployments(props: {
  readonly deployments: ReadonlyArray<PullRequestDeployment>;
  readonly truncated: boolean;
  readonly headSha: string | undefined;
  readonly environmentId: string;
}) {
  const { deployments } = props;
  const [showAll, setShowAll] = useState(false);
  // Ages are shown in whole minutes, so a per-second tick would only re-render unchanged rows.
  const nowMs = useVisibleSecondClock(true, 60_000);
  const environmentId = EnvironmentId.make(props.environmentId);
  const ordered = orderPullRequestDeployments(deployments);
  const canCollapse = ordered.length > PULL_REQUEST_DEPLOYMENT_PAGE;
  const visible =
    showAll || !canCollapse ? ordered : ordered.slice(0, PULL_REQUEST_DEPLOYMENT_PAGE);
  const open = async (url: string, action: UsageAction) => {
    const opened = await tryOpenExternalUrl(url, "deployment");
    void reportForkClientUsage(environmentId, {
      feature: "pull-request-deployments",
      action,
      outcome: opened ? "success" : "failure",
    });
  };
  return (
    <Animated.View layout={PR_ROW_LAYOUT} className="gap-3">
      <PullRequestSectionHeading>
        {pullRequestDeploymentsTitle(deployments)}
      </PullRequestSectionHeading>
      <PullRequestCardGroup>
        {visible.map((deployment, index) => (
          <DeploymentRow
            key={deployment.id}
            deployment={deployment}
            headSha={props.headSha}
            nowMs={nowMs}
            last={index === visible.length - 1 && !canCollapse && !props.truncated}
            onOpen={(url, action) => void open(url, action)}
          />
        ))}
        {props.truncated ? (
          <Text
            className={`px-4 py-3 text-2xs text-foreground-muted ${canCollapse ? "border-b border-border-subtle" : ""}`}
          >
            Environments not deployed recently may be missing.
          </Text>
        ) : null}
        {canCollapse ? (
          <PullRequestCardRow
            title={showAll ? "Show less" : `Show all ${ordered.length}`}
            icon="ellipsis.circle"
            compact
            expanded={showAll}
            onPress={() => {
              setShowAll(!showAll);
              if (!showAll)
                void reportForkClientUsage(environmentId, {
                  feature: "pull-request-deployments",
                  action: "show_all",
                  outcome: "success",
                });
            }}
          />
        ) : null}
      </PullRequestCardGroup>
    </Animated.View>
  );
}

function DeploymentRow(props: {
  readonly deployment: PullRequestDeployment;
  readonly headSha: string | undefined;
  readonly nowMs: number;
  readonly last: boolean;
  readonly onOpen: (url: string, action: UsageAction) => void;
}) {
  const { deployment } = props;
  const { icon, tint } = STATUS_ICONS[deployment.status];
  const label = PULL_REQUEST_DEPLOYMENT_STATUS_LABELS[deployment.status];
  const inactive = deployment.status === "inactive";
  const environmentUrl = inactive ? null : deployment.environmentUrl;
  const logUrl = deployment.logUrl;
  const commit = pullRequestDeploymentCommit(deployment, props.headSha);
  const age = relativeTime(deployment.updatedAt, props.nowMs);
  const reason =
    isFailedPullRequestDeployment(deployment) && deployment.description
      ? deployment.description
      : null;
  return (
    <View
      className={`min-h-13 flex-row items-start gap-3 px-4 py-3 ${props.last ? "" : "border-b border-border-subtle"}`}
    >
      <View className="pt-px">
        <SymbolView name={icon} size={18} tintColorClassName={tint} />
      </View>
      <View
        accessible
        accessibilityLabel={[
          deployment.environment,
          label,
          commit ? `${commit.older ? "older commit" : "commit"} ${commit.shortSha}` : null,
          `updated ${age} ago`,
          reason,
        ]
          .filter(Boolean)
          .join(", ")}
        className="min-w-0 flex-1 gap-0.5"
      >
        <Text
          className={`text-sm font-t3-medium ${inactive ? "text-foreground-muted" : ""}`}
          numberOfLines={1}
        >
          {deployment.environment}
        </Text>
        <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
          {label}
          {commit ? (
            <>
              {" · "}
              <Text className="font-mono text-2xs text-foreground-muted">{commit.shortSha}</Text>
            </>
          ) : null}
          {` · ${age}`}
        </Text>
        {reason ? (
          <Text selectable className="text-2xs text-foreground-muted" numberOfLines={4}>
            {reason}
          </Text>
        ) : null}
      </View>
      {logUrl ? (
        <DeploymentLink
          label="Logs"
          accessibilityLabel={`View deployment logs for ${deployment.environment}`}
          onPress={() => props.onOpen(logUrl, "open_logs")}
        />
      ) : null}
      {environmentUrl ? (
        <DeploymentLink
          label="Open"
          icon="arrow.up.right"
          accessibilityLabel={`Open ${deployment.environment}`}
          onPress={() => props.onOpen(environmentUrl, "open_environment")}
        />
      ) : null}
    </View>
  );
}

function DeploymentLink(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      hitSlop={8}
      className="flex-row items-center gap-0.5 active:opacity-70"
    >
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.icon ? (
        <SymbolView name={props.icon} size={11} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
}
