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

// Same words as the web notice and the setting it comes from ("Free source files in settled worktrees").
const CONTEXT_HINT = {
  files: "Check out to see every file.",
  skills: "Check out to use project skills.",
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
        {/* Beside the first line rather than centred on the whole block. */}
        <View className="self-start pt-0.5">
          {action.pending ? (
            <AppActivityIndicator size="small" colorClassName="accent-foreground-muted" />
          ) : (
            <SymbolView
              name="tray.and.arrow.down"
              size={16}
              tintColorClassName="accent-icon-muted"
            />
          )}
        </View>
        <View className="min-w-0 flex-1">
          <AppText textRole="footnote" className="text-foreground-secondary">
            {action.pending
              ? "Checking out source files…"
              : state === "released"
                ? "Source files freed"
                : "Source checkout interrupted"}
          </AppText>
          {action.pending ? null : (
            <AppText textRole="caption" className="text-foreground-muted">
              {props.context
                ? CONTEXT_HINT[props.context]
                : state === "released"
                  ? "Unchanged files removed to save disk space. Your changes are kept."
                  : "Check out to finish putting them back."}
            </AppText>
          )}
        </View>
        {action.pending ? null : (
          <Button
            label="Check out"
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
