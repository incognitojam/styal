import type { ReactNode } from "react";
import { View } from "react-native";

import type { useMediaActions } from "../state/mediaActions";
import { IconButton } from "./ui/IconButton";
import { MediaViewerAction } from "./MediaViewerAction";
import { AppText } from "./ui/AppText";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";

/** The bar over a full-screen image or video: always dark, whatever the app theme. */
export function MediaPreviewHeader(props: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly media: ReturnType<typeof useMediaActions>;
  readonly closeAccessibilityLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <>
      <View className="min-h-14 flex-row items-center gap-3 pl-4 pr-2">
        <AppText className="flex-1 font-t3-medium text-base text-white" numberOfLines={2}>
          {props.title}
        </AppText>
        <View
          accessibilityRole="toolbar"
          accessibilityLabel="Media actions"
          className="flex-row items-center rounded-full bg-zinc-900 px-1"
        >
          {props.media.actions.length > 0 ? (
            <MediaViewerAction
              label={props.children ? "Download original" : "Save or share"}
              icon="arrow.down"
              onPress={() => void props.media.share()}
              disabled={props.media.sharing}
            />
          ) : null}
          {props.children}
          <MediaActionsMenu media={props.media} inModal compact />
        </View>
        <View className="rounded-full bg-zinc-900">
          <IconButton
            accessibilityLabel={props.closeAccessibilityLabel}
            icon="xmark"
            tintColorClassName="accent-white"
            onPress={props.onClose}
          />
        </View>
      </View>
      <MediaSourceCaption source={props.media.title} />
    </>
  );
}
