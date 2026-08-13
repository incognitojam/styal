import type { SourceControlDefaultRepositoryState } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { sourceControlEnvironment } from "../../../state/sourceControl";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useAtomQueryRunner } from "../../../state/use-atom-query-runner";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";

type GitDefaultRepositorySheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** Sentinel row, matching the "Not set" option web offers. */
const UNSET_ROW_KEY = "__unset__";

function remoteLabel(state: SourceControlDefaultRepositoryState, remoteName: string): string {
  const remote = state.remotes.find((candidate) => candidate.remoteName === remoteName);
  return remote?.nameWithOwner ?? remote?.url ?? remoteName;
}

/**
 * Mobile's half of Settings → Projects → Checkout → Default repository on web:
 * which repository this checkout's pull requests, issues, and releases target.
 * Same git config the GitHub CLI's `gh repo set-default` writes.
 */
export function GitDefaultRepositorySheet(_props: GitDefaultRepositorySheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const primaryColor = useThemeColor("--color-primary");
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const [state, setState] = useState<SourceControlDefaultRepositoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const readDefaultRepository = useAtomQueryRunner(sourceControlEnvironment.defaultRepository, {
    reportFailure: false,
  });
  const writeDefaultRepository = useAtomCommand(sourceControlEnvironment.setDefaultRepository, {
    reportFailure: false,
  });

  const environmentId = selectedThread?.environmentId ?? null;
  useEffect(() => {
    if (environmentId === null || selectedThreadCwd === null) return;
    let cancelled = false;
    void readDefaultRepository({ environmentId, input: { cwd: selectedThreadCwd } }).then(
      (result) => {
        if (cancelled) return;
        if (AsyncResult.isFailure(result)) {
          setError(errorMessage(Cause.squash(result.cause)));
        } else {
          setState(result.value);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId, readDefaultRepository, selectedThreadCwd]);

  const select = useCallback(
    async (remoteName: string | null) => {
      if (environmentId === null || selectedThreadCwd === null || isSaving) return;
      setError(null);
      setIsSaving(true);
      const result = await writeDefaultRepository({
        environmentId,
        input: { cwd: selectedThreadCwd, remoteName },
      });
      setIsSaving(false);
      if (AsyncResult.isFailure(result)) {
        setError(errorMessage(Cause.squash(result.cause)));
        return;
      }
      setState(result.value);
      navigation.goBack();
    },
    [environmentId, isSaving, navigation, selectedThreadCwd, writeDefaultRepository],
  );

  const rows =
    state === null
      ? []
      : [
          ...state.remotes.map((remote) => ({
            key: remote.remoteName,
            title:
              remote.remoteName === state.defaultRemoteName && state.defaultRepositoryPath
                ? state.defaultRepositoryPath
                : remoteLabel(state, remote.remoteName),
            subtitle: remote.remoteName,
            selected: remote.remoteName === state.defaultRemoteName,
          })),
          {
            key: UNSET_ROW_KEY,
            title: "Not set",
            subtitle: "GitHub CLI decides",
            selected: state.defaultRemoteName === null,
          },
        ];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Default repository" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerClassName="gap-4 px-5 pt-2"
      >
        {error ? <ErrorBanner message={error} /> : null}
        <Text className="text-foreground-muted px-1 text-xs">
          Where pull requests, issues, and releases go for this checkout.
        </Text>
        <View className="overflow-hidden rounded-[18px] border border-border bg-card">
          {rows.map((row, index) => (
            <Pressable
              key={row.key}
              disabled={isSaving}
              className={cn(
                "flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-[0.45]",
                index > 0 && "border-t border-border-subtle",
              )}
              onPress={() => void select(row.key === UNSET_ROW_KEY ? null : row.key)}
            >
              <View className="flex-1 gap-0.5">
                <Text className="text-foreground text-base font-t3-bold">{row.title}</Text>
                <Text className="text-foreground-muted text-xs leading-snug">{row.subtitle}</Text>
              </View>
              {row.selected ? (
                <SymbolView name="checkmark" size={15} tintColor={primaryColor} type="monochrome" />
              ) : null}
            </Pressable>
          ))}
          {state === null ? (
            <View className="flex-row items-center gap-3 px-4 py-3">
              <SymbolView
                name="arrow.triangle.2.circlepath"
                size={15}
                tintColor={iconColor}
                type="monochrome"
              />
              <Text className="text-foreground-muted text-sm">Reading remotes…</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}
