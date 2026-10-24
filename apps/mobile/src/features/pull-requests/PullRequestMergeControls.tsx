import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestMergeMethod } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PullRequestMergeIntentIcon } from "./PullRequestMergeIntentIcon";
import {
  pullRequestMergeIntentLabel,
  resolvePullRequestMergeIntent,
} from "@t3tools/shared/threadPullRequests";
import {
  pullRequestChecksState,
  resolvePullRequestMergeNow,
  resolvePullRequestPrimaryControl,
} from "@t3tools/shared/pullRequestMergeControl";
import { Menu } from "../../components/ui/Menu";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowedMergeMethods,
  canPerformPullRequestAction,
  mergeUnavailableReason,
  MERGE_CONFLICT_REASON,
  MERGE_METHODS,
  PR_ACTION_ICONS,
  pullRequestActionLabel,
} from "./pullRequestActions";
import { pullRequestStackMerge, singlePullRequestMergeAllowed } from "./pullRequestStack";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";
import type { PullRequestStackState } from "./usePullRequestStack";
import { PullRequestGlyph } from "./pullRequestGlyphs";

export function PullRequestMergeControls(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
  readonly stack: PullRequestStackState;
}) {
  const { pr, stack } = props;
  const mergeIntent = resolvePullRequestMergeIntent(pr);
  const terminology = sourceControlClients.get(pr.provider).changeRequest;
  const target = pullRequestTarget(props.params);
  const permissions = usePullRequestPermissions(props.params, pr);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const refreshDetail = useAtomRefresh(composerPullRequests.detail(target));
  const refreshActivity = useAtomRefresh(composerPullRequests.activity(target));
  const [selectedMethod, setSelectedMethod] = useState<PullRequestMergeMethod | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const methods = allowedMergeMethods(pr);
  const preferred =
    selectedMethod ??
    (AsyncResult.isSuccess(preferences) ? preferences.value.pullRequestMergeMethod : undefined) ??
    "squash";
  const method = methods.includes(preferred)
    ? preferred
    : methods.includes("squash")
      ? "squash"
      : methods[0];
  const scope = stack.stack ? pullRequestStackMerge(stack.stack, pr.number, terminology) : null;
  const canMergeSingle = singlePullRequestMergeAllowed({
    supportsStackActions: stack.supportsStackActions,
    hasStack: stack.stack !== null,
    isFresh: stack.isFresh,
  });
  const checkingStack =
    permissions.connected && stack.supportsStackActions && !stack.isFresh && !stack.error;
  const reason =
    (!permissions.connected
      ? "Reconnect to merge."
      : mergeUnavailableReason(pr, permissions.canWrite, terminology)) ??
    (stack.stack
      ? !stack.supportsStackActions
        ? "This environment can display stacks but cannot merge them."
        : !stack.isFresh
          ? "Refresh the stack before merging."
          : scope?.reason
      : !canMergeSingle
        ? stack.error
          ? "Couldn't check stack membership. Refresh before merging."
          : "Checking stack membership…"
        : null);
  const autoAction = pr.autoMergeEnabled ? "disable-auto-merge" : "enable-auto-merge";
  const canAutoMerge =
    (autoAction === "disable-auto-merge" || (!stack.stack && canMergeSingle)) &&
    permissions.canWrite &&
    canPerformPullRequestAction(pr, autoAction);
  // A stack merges every layer below this one, so this pull request's own readiness cannot
  // decide it; stacks keep the plain merge button.
  const mergeControlInput = {
    state: pr.state,
    isDraft: pr.isDraft,
    mergeability: pr.mergeability,
    checksState: pullRequestChecksState(pr.checks),
    mergeReadiness: stack.stack ? undefined : pr.mergeReadiness,
    autoMergeEnabled: pr.autoMergeEnabled,
    hasMergeMethod: method !== undefined,
    canMerge: method !== undefined && !reason,
    canMarkReady: false,
    canEnableAutoMerge: autoAction === "enable-auto-merge" && canAutoMerge,
  };
  const primary = resolvePullRequestPrimaryControl(mergeControlInput);
  const mergeNow = stack.stack
    ? null
    : resolvePullRequestMergeNow({
        ...mergeControlInput,
        canBypassRequirements: pr.viewerPermissions.bypassMergeRequirements === true,
      });
  const primaryAction =
    primary === "enable-auto-merge"
      ? "enable-auto-merge"
      : primary === "auto-merge-armed" && canAutoMerge
        ? "disable-auto-merge"
        : "merge";
  const blockedReason =
    primaryAction === "merge" && !stack.stack && pr.mergeReadiness === "blocked"
      ? "Waiting for the repository's merge requirements."
      : null;
  const canMerge = !busy && method !== undefined && !reason && !blockedReason;
  const mergeLabel = method
    ? scope && scope.layers.length > 1
      ? `${MERGE_METHODS[method].title} stack (${scope.layers.length})`
      : MERGE_METHODS[method].title
    : "Merge unavailable";
  const label =
    primaryAction === "merge"
      ? mergeLabel
      : primaryAction === "enable-auto-merge"
        ? "Enable auto-merge"
        : "Disable auto-merge";
  const canPressPrimary = primaryAction === "merge" ? canMerge : !busy;
  const prominent = canPressPrimary && primaryAction !== "disable-auto-merge";
  const mergeNowLabel = mergeNow === "bypass" ? "Bypass rules and merge" : "Merge now";
  const menuMethods = methods.length > 1 ? methods : [];
  const menuAutoAction = canAutoMerge && primaryAction === "merge" ? autoAction : null;

  const perform = async (action: "merge" | "enable-auto-merge" | "disable-auto-merge") => {
    if (
      pending.current ||
      busy ||
      (action !== "disable-auto-merge" && !method) ||
      (action === "merge" ? !canMerge && mergeNow === null : !canAutoMerge)
    )
      return;
    pending.current = true;
    setBusy(true);
    const response = await runAction({
      ...target,
      input: {
        ...target.input,
        action,
        ...(action === "merge" && method && stack.stack && scope
          ? {
              stackNumber: stack.stack.number,
              expectedStackHeads: scope.heads,
              mergeMethod: method,
            }
          : action === "merge" && method
            ? {
                resolveMergeMethod: (fresh) => {
                  if (
                    !canPerformPullRequestAction(fresh, "merge") ||
                    !allowedMergeMethods(fresh).includes(method)
                  )
                    throw new Error(`The ${terminology.singular} changed. Refresh before merging.`);
                  return method;
                },
              }
            : action === "enable-auto-merge" && method
              ? { mergeMethod: method }
              : {}),
      },
    });
    // A stack can partly merge before the provider reports a failure.
    refreshDetail();
    refreshActivity();
    stack.refresh();
    pending.current = false;
    setBusy(false);
    if (AsyncResult.isFailure(response)) {
      const cause = squashAtomCommandFailure(response);
      Dialog.alert(
        "Couldn't complete the merge action",
        cause instanceof Error ? cause.message : "Try again.",
      );
    }
  };
  const confirm = (
    action: "merge" | "enable-auto-merge" | "disable-auto-merge",
    bypass = false,
  ) => {
    const title =
      action === "merge" && bypass
        ? "Bypass rules and merge?"
        : action === "merge"
          ? scope && scope.layers.length > 1
            ? `Merge ${scope.layers.length} stack layers?`
            : `${pullRequestActionLabel("merge", terminology)}?`
          : action === "enable-auto-merge"
            ? "Enable auto-merge?"
            : "Disable auto-merge?";
    const message =
      action === "merge" && bypass
        ? `Merge #${pr.number} into ${pr.baseBranch} using ${method} now, without waiting for its required checks and reviews.`
        : action === "merge" && scope
          ? `Merge ${scope.layers.map((layer) => `#${layer.number}`).join(" → ")} into ${stack.stack?.base} using ${method}. Layers above #${pr.number} stay open.`
          : action === "enable-auto-merge"
            ? `Merge #${pr.number} using ${method} when its requirements are met. This may happen immediately.`
            : action === "disable-auto-merge"
              ? `Stop the provider from automatically merging this ${terminology.singular}.`
              : `Merge #${pr.number} into ${pr.baseBranch} using ${method}.`;
    Dialog.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text:
          action === "merge" ? (bypass ? "Bypass and merge" : mergeLabel) : title.replace("?", ""),
        onPress: () => void perform(action),
      },
    ]);
  };
  return (
    <View className="gap-2 border-t border-border-subtle p-3">
      <View
        className={
          Platform.OS === "android"
            ? "flex-row items-center gap-2"
            : `flex-row overflow-hidden rounded-xl border-continuous ${prominent ? "bg-prominent-action" : "bg-subtle-strong"}`
        }
      >
        {Platform.OS === "android" ? (
          <View className="min-w-0 flex-1">
            <Button
              label={busy ? "Working…" : !permissions.connected ? "Reconnect to merge" : label}
              tone={primaryAction === "disable-auto-merge" ? "secondary" : "primary"}
              fullWidth
              disabled={!canPressPrimary}
              loading={busy || checkingStack}
              onPress={() => confirm(primaryAction)}
            />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              scope ? `${label}, ${scope.layers.length} stack layers through #${pr.number}` : label
            }
            accessibilityState={{ disabled: !canPressPrimary, busy: busy || checkingStack }}
            disabled={!canPressPrimary}
            onPress={() => confirm(primaryAction)}
            className="min-h-11 min-w-0 flex-1 flex-row items-center justify-center gap-2 px-3 py-2 active:opacity-70"
          >
            {busy || checkingStack ? (
              <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
            ) : (
              <SymbolView
                name={PR_ACTION_ICONS[primaryAction]}
                size={16}
                tintColorClassName={
                  prominent ? "accent-prominent-action-foreground" : "accent-icon-muted"
                }
              />
            )}
            <Text
              className={`shrink text-center text-sm font-t3-semibold ${prominent ? "text-prominent-action-foreground" : "text-foreground-muted"}`}
            >
              {busy ? "Working…" : !permissions.connected ? "Reconnect to merge" : label}
            </Text>
          </Pressable>
        )}
        {menuMethods.length > 0 || mergeNow !== null || menuAutoAction !== null ? (
          <Menu
            title="Merge options"
            actions={[
              ...menuMethods.map((id) => ({
                id,
                title: MERGE_METHODS[id].title,
                state: id === method ? ("on" as const) : ("off" as const),
                attributes: { disabled: busy },
              })),
              ...(mergeNow !== null
                ? [
                    {
                      id: "merge-now",
                      title: mergeNowLabel,
                      image: PullRequestGlyph.merged,
                      attributes: { disabled: busy, destructive: mergeNow === "bypass" },
                    },
                  ]
                : []),
              ...(menuAutoAction !== null
                ? [
                    {
                      id: menuAutoAction,
                      title: pullRequestActionLabel(menuAutoAction, terminology),
                      image: PR_ACTION_ICONS[menuAutoAction],
                      attributes: { disabled: busy },
                    },
                  ]
                : []),
            ]}
            onPressAction={({ nativeEvent }) => {
              const selected = menuMethods.find((id) => id === nativeEvent.event);
              if (selected) {
                setSelectedMethod(selected);
                savePreferences({ pullRequestMergeMethod: selected });
              } else if (nativeEvent.event === "merge-now" && mergeNow !== null)
                confirm("merge", mergeNow === "bypass");
              else if (menuAutoAction !== null && nativeEvent.event === menuAutoAction)
                confirm(menuAutoAction);
            }}
          >
            {Platform.OS === "android" ? (
              <View pointerEvents="none">
                <IconButton
                  accessibilityLabel="Merge options"
                  icon="chevron.down"
                  variant="tonal"
                />
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Merge options"
                className="min-h-11 w-11 items-center justify-center border-l border-border-subtle"
              >
                <SymbolView
                  name="chevron.down"
                  size={13}
                  tintColorClassName={
                    prominent ? "accent-prominent-action-foreground" : "accent-icon-muted"
                  }
                />
              </Pressable>
            )}
          </Menu>
        ) : null}
      </View>
      {blockedReason && !reason ? (
        <Text className="px-1 text-xs text-foreground-muted">{blockedReason}</Text>
      ) : null}
      {permissions.connected &&
      reason &&
      reason !== MERGE_CONFLICT_REASON &&
      reason !== "Checking stack membership…" &&
      !(checkingStack && reason === "Refresh the stack before merging.") ? (
        <Text className="px-1 text-xs text-foreground-muted">{reason}</Text>
      ) : null}
      {mergeIntent ? (
        <View className="flex-row items-center gap-1.5 px-1">
          <PullRequestMergeIntentIcon
            name={PullRequestGlyph.pullRequest}
            size={14}
            tintColorClassName="accent-adaptive-emerald-600-400"
            mergeIntent={mergeIntent}
          />
          <Text className="text-xs text-foreground-muted">
            {pullRequestMergeIntentLabel(mergeIntent)}
            {pr.autoMergeMethod ? ` · ${pr.autoMergeMethod}` : ""}
          </Text>
        </View>
      ) : null}
      {stack.error && stack.supportsStackActions ? (
        <Button label="Retry stack lookup" tone="text" onPress={stack.refresh} />
      ) : null}
    </View>
  );
}
