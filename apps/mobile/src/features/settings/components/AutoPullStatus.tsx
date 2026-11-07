import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { vcsEnvironment } from "../../../state/vcs";

export function AutoPullStatus({
  environmentId,
  cwd,
  label,
  enabled,
  source,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  label?: string | undefined;
  enabled: boolean;
  source: string;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
  );
  const last = query.data?.autoPull?.lastRun;
  return (
    <View className="gap-2 px-4 py-3">
      {label ? (
        <Text textRole="footnote" className="font-t3-medium">
          {label}
        </Text>
      ) : null}
      <Text textRole="footnote">
        {enabled ? "On" : "Off"} · {source}
      </Text>
      {last ? (
        <>
          <Text textRole="footnote">Last result: {last.outcome}</Text>
          <Text textRole="footnote">Last checked: {new Date(last.checkedAt).toLocaleString()}</Text>
          {last.detail ? (
            <Text textRole="footnote">
              {last.outcome === "failed" ? "Error" : "Reason"}: {last.detail}
            </Text>
          ) : null}
        </>
      ) : null}
      {query.error ? (
        <Text textRole="footnote">Could not load the last check: {query.error}</Text>
      ) : query.isPending && query.data === null ? (
        <Text textRole="footnote">Loading last check…</Text>
      ) : !query.data?.autoPull ? (
        <Text textRole="footnote">
          Automatic pull diagnostics are unavailable from this server.
        </Text>
      ) : !last ? (
        <Text textRole="footnote">No check recorded this server session.</Text>
      ) : null}
    </View>
  );
}
