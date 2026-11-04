import { View } from "react-native";

import { type AppSymbolName, SymbolView } from "./ui/AppSymbol";
import { AppText as Text } from "./ui/AppText";
import { cn } from "../lib/cn";

export interface StatusTone {
  readonly label: string;
  readonly pillClassName: string;
  readonly textClassName: string;
}

export function StatusPill(
  props: StatusTone & {
    readonly size?: "default" | "compact";
    readonly icon?: AppSymbolName;
    readonly iconTintClassName?: string;
  },
) {
  const size = props.size ?? "default";
  return (
    <View
      className={cn(
        "flex-row items-center gap-1 rounded-full",
        size === "compact" ? "px-2.5 py-1" : "px-3 py-1.5",
        props.pillClassName,
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={size === "compact" ? 10 : 12}
          tintColorClassName={props.iconTintClassName ?? "accent-foreground-muted"}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
      <Text
        className={cn(
          "font-t3-bold",
          size === "compact" ? "text-2xs" : "text-xs",
          props.textClassName,
        )}
      >
        {props.label}
      </Text>
    </View>
  );
}
