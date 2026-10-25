import { useFocusEffect } from "@react-navigation/native";
import { useCallback } from "react";
import { AppState } from "react-native";
import { useAtomRefresh } from "@effect/atom-react";

import { composerPullRequests } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function usePullRequestMergeCommitRefresh(params: PullRequestParams, enabled: boolean) {
  const invalidate = useAtomCommand(composerPullRequests.invalidate, { reportFailure: false });
  const refresh = useAtomRefresh(composerPullRequests.detail(pullRequestTarget(params)));
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      let mounted = true;
      let pending = false;
      const read = async () => {
        if (!mounted || pending || AppState.currentState !== "active") return;
        pending = true;
        const target = pullRequestTarget(params);
        await invalidate({
          environmentId: target.environmentId,
          input: { reference: target.input, scope: "detail" },
        });
        if (mounted) refresh();
        pending = false;
      };
      const timer = setInterval(() => void read(), 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void read();
      });
      return () => {
        mounted = false;
        clearInterval(timer);
        subscription.remove();
      };
    }, [enabled, invalidate, params, refresh]),
  );
}
