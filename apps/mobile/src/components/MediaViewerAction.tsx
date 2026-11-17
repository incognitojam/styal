import { useState } from "react";
import { View } from "react-native";
import { AppText } from "./ui/AppText";
import { IconButton } from "./ui/IconButton";
import type { AppSymbolName } from "./ui/AppSymbol";

export function MediaViewerAction(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  const [hint, setHint] = useState(false);
  return (
    <View>
      <IconButton
        accessibilityLabel={props.label}
        icon={props.icon}
        variant="standard"
        tintColorClassName="accent-white"
        disabled={props.disabled}
        onPress={props.onPress}
        onLongPress={() => setHint(true)}
        onPressOut={() => setHint(false)}
      />
      {hint ? (
        <View className="absolute right-0 top-full min-w-36 rounded-md bg-zinc-900 px-2 py-1">
          <AppText className="text-xs text-white" numberOfLines={1}>
            {props.label}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
