import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { gitEnvironment } from "../state/git";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { AppActivityIndicator } from "./ui/AppActivityIndicator";
import { SymbolView } from "./ui/AppSymbol";
import { AppText } from "./ui/AppText";
import { Button } from "./ui/Button";

const CONTEXT_HINT = {
  files: "Tracked files open after checkout.",
  skills: "Project skills load after checkout.",
} as const;

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
  const state = status.data?.sourceCheckout;
  if (!state) return null;
  return (
    <View className="gap-1 px-4 py-1" accessibilityLiveRegion="polite">
      <View className="min-h-10 flex-row items-center gap-2.5">
        {action.pending ? (
          <AppActivityIndicator size="small" colorClassName="accent-foreground-muted" />
        ) : (
          <SymbolView name="tray.and.arrow.down" size={16} tintColorClassName="accent-icon-muted" />
        )}
        <View className="min-w-0 flex-1">
          <AppText textRole="footnote" className="text-foreground-secondary">
            {action.pending
              ? "Checking out source files…"
              : state === "released"
                ? "Source files released"
                : "Source checkout interrupted"}
          </AppText>
          {props.context && !action.pending ? (
            <AppText textRole="caption" className="text-foreground-muted">
              {CONTEXT_HINT[props.context]}
            </AppText>
          ) : null}
        </View>
        {action.pending ? null : (
          <Button
            label="Check out again"
            size="compact"
            tone="text"
            disabled={!allowed}
            onPress={async () => {
              const result = await checkOut({ environmentId, input: { cwd } });
              status.refresh();
              if (result._tag === "Success") props.onCheckedOut?.();
            }}
          />
        )}
      </View>
      {action.error ? (
        <View className="flex-row items-start gap-2.5 pb-1">
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-danger-foreground"
          />
          <AppText
            textRole="footnote"
            className="min-w-0 flex-1 text-danger-foreground"
            accessibilityRole="alert"
          >
            {action.error}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
