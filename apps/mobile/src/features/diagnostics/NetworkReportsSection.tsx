import { useAtomValue } from "@effect/atom-react";
import type { NetworkReports } from "@t3tools/client-runtime/network-reports";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { networkReports } from "../../state/network-reports";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  describeNetworkReport,
  formatReportStart,
  networkKindLabel,
  routeKindLabel,
  summarizeByNetworkKind,
} from "./network-report-model";

const MAX_LISTED_REPORTS = 30;

/**
 * How connections behaved under each network type while the app was open,
 * so a trip on a train or a weak signal can be checked afterwards.
 */
export function NetworkReportsSection() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const allReports = useAtomValue(networkReports.reportsValueAtom);
  const clear = useAtomCommand(networkReports.clear);
  const [clearing, setClearing] = useState(false);
  // Reports of an environment removed while the app was closed age out on their own.
  const reports = allReports.filter((report) => catalog.entries.has(report.environmentId));
  const showEnvironment = new Set(reports.map((report) => report.environmentId)).size > 1;
  // Fixed while the screen is open; only today-or-earlier matters for formatting.
  const [now] = useState(Date.now);

  return (
    <>
      <SettingsSection title="Network, last 7 days">
        {reports.length === 0 ? (
          <View className="gap-1 px-6 py-8">
            <Text className="text-center text-base text-foreground">No network reports yet</Text>
            <Text className="text-center text-sm text-foreground-muted">
              A report is added after each stretch of use on one network, up to 15 minutes long.
            </Text>
          </View>
        ) : (
          summarizeByNetworkKind(reports).map((summary, index) => (
            <View
              key={summary.networkKind}
              className={index === 0 ? "gap-0.5 p-4" : "gap-0.5 border-t border-border-subtle p-4"}
            >
              <Text className="text-base text-foreground">
                {networkKindLabel(summary.networkKind)}
              </Text>
              <Text className="text-sm tabular-nums text-foreground-muted">
                {formatDuration(summary.durationMs)} · {summary.connectedPercent}% connected ·{" "}
                {summary.drops === 1 ? "1 drop" : `${summary.drops} drops`}
              </Text>
            </View>
          ))
        )}
      </SettingsSection>

      {reports.length > 0 ? (
        <SettingsSection title="Network reports">
          {reports.slice(0, MAX_LISTED_REPORTS).map((report, index) => (
            <NetworkReportRow
              key={`${report.environmentId}:${report.startedAt}`}
              report={report}
              environmentLabel={
                showEnvironment
                  ? catalog.entries.get(report.environmentId)?.target.label
                  : undefined
              }
              first={index === 0}
              now={now}
            />
          ))}
        </SettingsSection>
      ) : null}

      <View className="gap-3">
        <SettingsSection>
          <SettingsActionRow
            icon="trash"
            label="Clear network reports"
            tone="danger"
            disabled={allReports.length === 0 || clearing}
            loading={clearing}
            onPress={() => {
              setClearing(true);
              void clear(undefined).finally(() => setClearing(false));
            }}
          />
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Reports record the network type and how styal connected, never the network or carrier
          name. They stay on this device for 7 days, and each environment&apos;s server receives its
          own as usage data unless telemetry is turned off there.
        </Text>
      </View>
    </>
  );
}

function NetworkReportRow(props: {
  readonly report: NetworkReports.StoredNetworkReport;
  readonly environmentLabel: string | undefined;
  readonly first: boolean;
  readonly now: number;
}) {
  const { metrics } = props.report;
  return (
    <View className={props.first ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="shrink text-base font-t3-medium text-foreground" numberOfLines={1}>
          {networkKindLabel(metrics.networkKind)} · {routeKindLabel(metrics.routeKind)}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {formatReportStart(props.report.startedAt, props.now)}
        </Text>
      </View>
      {props.environmentLabel === undefined ? null : (
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.environmentLabel}
        </Text>
      )}
      {describeNetworkReport(metrics).map((line) => (
        <Text
          key={line.text}
          className={
            line.trouble
              ? "text-sm text-danger-foreground"
              : "text-sm tabular-nums text-foreground-muted"
          }
        >
          {line.text}
        </Text>
      ))}
    </View>
  );
}
