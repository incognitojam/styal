import type { ComponentProps } from "react";
import { View } from "react-native";
import type { PullRequestMergeIntent } from "@t3tools/shared/threadPullRequests";
import { SymbolView } from "../../components/AppSymbol";

export function PullRequestMergeIntentIcon({
  mergeIntent,
  ...symbol
}: ComponentProps<typeof SymbolView> & { mergeIntent?: PullRequestMergeIntent | undefined }) {
  return (
    <View className="relative">
      <SymbolView {...symbol} />
      {mergeIntent ? (
        <View className="absolute -top-0.5 -right-0.5 size-1 rounded-full bg-adaptive-emerald-600-400" />
      ) : null}
    </View>
  );
}
