import { createContext, useContext, useState } from "react";
import { Pressable, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMediaActions } from "../state/mediaActions";
import type { FilePreviewImages } from "./ui/FilePreviewModal.types";
import { MediaPreviewHeader } from "./MediaPreviewHeader";
import { SymbolView } from "./ui/AppSymbol";
import { AppText } from "./ui/AppText";

type MediaImagePreviewProps = {
  readonly source: FilePreviewImages;
  readonly onRequestClose: () => void;
};

const ImagePreviewContext = createContext<MediaImagePreviewProps | null>(null);

function ImagePreviewHeader(header: { readonly imageIndex: number }) {
  const props = useContext(ImagePreviewContext)!;
  const source = props.source.images[header.imageIndex];
  const insets = useSafeAreaInsets();
  const [originalHint, setOriginalHint] = useState(false);
  const mediaActions = useMediaActions(source?.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70" style={{ paddingTop: insets.top }}>
      <MediaPreviewHeader
        title={source?.name ?? "Image"}
        media={mediaActions}
        closeAccessibilityLabel="Close image"
        onClose={props.onRequestClose}
      >
        {source?.previewImage ? (
          <View className="size-12">
            {source.onViewOriginal ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="View original"
                onPress={source.onViewOriginal}
                onLongPress={() => setOriginalHint(true)}
                onPressOut={() => setOriginalHint(false)}
                className="size-12 items-center justify-center"
              >
                <SymbolView name="eye" size={20} tintColor="#ffffff" type="monochrome" />
                {originalHint ? (
                  <View className="absolute right-0 top-full min-w-28 rounded-md bg-black/90 px-2 py-1">
                    <AppText className="text-xs text-white" numberOfLines={1}>
                      View original
                    </AppText>
                  </View>
                ) : null}
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </MediaPreviewHeader>
    </View>
  );
}

// Images still resolving show the viewer's loading page, and remount by key once their URL arrives.
export function imageViewingProps(source: FilePreviewImages) {
  return {
    images: source.images.map((image) => (image.uri ? { uri: image.uri } : {})),
    keyExtractor: (_: unknown, index: number) => source.images[index]?.uri ?? `pending:${index}`,
    // Stays fixed: react-native-image-viewing remounts the Modal and replays its fade when it changes.
    imageIndex: source.selectedIndex,
  };
}

export function MediaImagePreview(props: MediaImagePreviewProps) {
  return (
    <ImagePreviewContext value={props}>
      <ImageViewing
        {...imageViewingProps(props.source)}
        visible
        presentationStyle="fullScreen"
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled={false}
        doubleTapToZoomEnabled
        HeaderComponent={ImagePreviewHeader}
      />
    </ImagePreviewContext>
  );
}
