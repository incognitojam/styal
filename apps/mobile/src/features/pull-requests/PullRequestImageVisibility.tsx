import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type ComponentRef,
} from "react";
import { Dimensions, View, type ViewProps } from "react-native";
import { imageIntersectsViewport, type ImageBounds } from "./pullRequestImageVisibility";
export const PullRequestMediaVisibleContext = createContext(true);

const ClipsContext = createContext<readonly RefObject<ComponentRef<typeof View> | null>[]>([]);
const pending = new Set<() => void>();

export function checkPullRequestImages() {
  for (const check of pending) check();
}

export function PullRequestImageClip(props: ViewProps) {
  const parentClips = useContext(ClipsContext);
  const ref = useRef<ComponentRef<typeof View>>(null);
  return (
    <View
      {...props}
      ref={ref}
      collapsable={false}
      onLayout={(event) => {
        props.onLayout?.(event);
        checkPullRequestImages();
      }}
    >
      <ClipsContext value={[...parentClips, ref]}>{props.children}</ClipsContext>
    </View>
  );
}

export function PullRequestLazyImage(props: { children: (visible: boolean) => ReactNode }) {
  const clips = useContext(ClipsContext);
  const active = useContext(PullRequestMediaVisibleContext);
  const [loaded, setLoaded] = useState(false);
  const checkRef = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      if (!node || loaded || !active) return;
      let disposed = false;
      let measuring = false;
      const check = () => {
        if (measuring || disposed) return;
        measuring = true;
        node.measureInWindow(async (x, y, width, height) => {
          const bounds = await Promise.all(
            clips.map(
              (clip) =>
                new Promise<ImageBounds>((resolve) => {
                  if (!clip.current) return resolve({ x: 0, y: 0, width: 0, height: 0 });
                  clip.current.measureInWindow((x, y, width, height) =>
                    resolve({ x, y, width, height }),
                  );
                }),
            ),
          );
          measuring = false;
          if (
            !disposed &&
            imageIntersectsViewport({ x, y, width, height }, [
              { x: 0, y: 0, ...Dimensions.get("window") },
              ...bounds,
            ])
          )
            setLoaded(true);
        });
      };
      checkRef.current = check;
      pending.add(check);
      check();
      return () => {
        disposed = true;
        pending.delete(check);
        checkRef.current = null;
      };
    },
    [active, clips, loaded],
  );
  return (
    <View ref={ref} collapsable={false} onLayout={() => checkRef.current?.()}>
      {props.children(loaded && active)}
    </View>
  );
}
