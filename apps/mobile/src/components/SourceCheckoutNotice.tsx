import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { gitEnvironment } from "../state/git";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";
import { StyalMark } from "./StyalMark";

export function SourceCheckoutNotice(props: {
  environmentId: EnvironmentId;
  cwd: string;
  context?: "files" | "skills";
  onCheckedOut?: () => void;
}) {
  const { environmentId, cwd } = props;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const action = useAtomValue(gitEnvironment.sourceCheckoutAction({ environmentId, cwd }));
  const allowed = useAtomValue(gitEnvironment.checkOutSources.permissionAtom(environmentId));
  const checkOut = useAtomCommand(gitEnvironment.checkOutSources);
  if (!status.data?.sourceCheckout) return null;
  return (
    <View className="gap-2 px-4 py-2" accessibilityLiveRegion="polite">
      <View className="flex-row flex-wrap items-center gap-2">
        <View accessible accessibilityLabel="Only in styal">
          <StyalMark height={14} colorClassName="accent-foreground-muted" />
        </View>
        <AppText className="text-sm text-foreground">
          {status.data.sourceCheckout === "released"
            ? "Source files released"
            : "Source checkout interrupted"}
        </AppText>
        <Button
          label="Check out again"
          size="compact"
          tone="secondary"
          disabled={!allowed}
          loading={action.pending}
          onPress={async () => {
            const result = await checkOut({ environmentId, input: { cwd } });
            status.refresh();
            if (result._tag === "Success") props.onCheckedOut?.();
          }}
        />
      </View>
      {props.context ? (
        <AppText className="text-xs text-foreground-muted">
          {props.context === "skills"
            ? "Project skills are available after checking out source files."
            : "Check out again to open tracked source files."}
        </AppText>
      ) : null}
      {status.data?.sourceCheckout === "recovery-required" ? (
        <AppText className="text-xs text-foreground-muted">
          Source checkout was interrupted. Check out again to recover.
        </AppText>
      ) : null}
      {action.error ? (
        <AppText className="text-sm text-danger" accessibilityRole="alert">
          {action.error}
        </AppText>
      ) : null}
    </View>
  );
}
