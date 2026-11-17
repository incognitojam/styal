import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  failImage: () => {},
  loadTiny: (_event: { source: { width: number; height: number } }) => {},
  loadImage: (_event: { source: { width: number; height: number } }) => {},
  Passthrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { absoluteFill: {} },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => (
    <div data-style={JSON.stringify(style)}>{children}</div>
  ),
}));
vi.mock("expo-image", () => ({
  Image: (props: {
    source?: { uri: string };
    onError: () => void;
    onLoad: (event: { source: { width: number; height: number } }) => void;
  }) => {
    harness.failImage = props.onError;
    if (props.source?.uri === "https://example.test/tiny") harness.loadTiny = props.onLoad;
    else harness.loadImage = props.onLoad;
    return <img alt="" />;
  },
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("react-native-svg", () => ({ parse: vi.fn(), SvgAst: () => null }));
vi.mock("@t3tools/client-runtime/state/assets", () => ({ MISSING_FILE_ACCESS_MESSAGE: "" }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/FilePreviewGallery", () => ({
  useFilePreviewGallery: () => (source: unknown) => source,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MediaActionsMenu", () => ({ MediaActionsMenu: harness.Passthrough }));
vi.mock("../../components/ui/NativePresentation", () => ({
  PresentationSource: harness.Passthrough,
}));
vi.mock("../../state/mediaActions", () => ({ useMediaActions: () => ({ actions: [] }) }));
vi.mock("../../state/assets", () => ({ useAssetUrlState: vi.fn() }));

import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { fetch } from "expo/fetch";
import { parse } from "react-native-svg";

import { MarkdownImageAvailableWidthContext, ThreadMarkdownImageView } from "./ThreadMarkdownImage";

it.each([
  {
    knownSize: { width: 180, height: 360 },
    decoded: { width: 480, height: 960 },
    expected: { width: 180, height: 360 },
  },
  {
    knownSize: { width: 320, height: 180 },
    decoded: { width: 1280, height: 720 },
    expected: { width: 320, height: 180 },
  },
  {
    knownSize: undefined,
    decoded: { width: 480, height: 960 },
    expected: { width: 240, height: 480 },
  },
  {
    knownSize: undefined,
    decoded: { width: 1280, height: 720 },
    expected: { width: 345, height: 194.0625 },
  },
  {
    knownSize: undefined,
    decoded: { width: 480, height: 960 },
    reserveFrame: true,
    sourceDimensions: { width: 120, height: 40 },
    expected: { width: 120, maxWidth: 120, aspectRatio: 3 },
  },
  {
    knownSize: undefined,
    decoded: { width: 390, height: 844 },
    reserveFrame: true,
    placeholderSize: { width: 30, height: 64 },
    expected: { width: 225, maxWidth: 225, aspectRatio: 30 / 64 },
  },
  {
    knownSize: { width: 180, height: 360 },
    decoded: { width: 480, height: 960 },
    reserveFrame: true,
    availableWidth: 0,
    expected: { width: "100%", maxWidth: 180, aspectRatio: 0.5 },
  },
])(
  "uses declared or natural dimensions and ignores later downsampled sizes: $expected",
  async ({
    knownSize,
    decoded,
    expected,
    reserveFrame,
    availableWidth,
    sourceDimensions,
    placeholderSize,
  }) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const frameSize = () =>
      [...container.querySelectorAll<HTMLElement>("div[data-style]")]
        .map((element) => JSON.parse(element.dataset.style ?? "null") as Record<string, unknown>)
        .find((style) => typeof style?.width === "number" || style?.width === "100%");
    try {
      await act(async () =>
        root.render(
          <MarkdownImageAvailableWidthContext value={availableWidth ?? 345}>
            <ThreadMarkdownImageView
              uri="https://example.test/hero.png"
              sourceKey="workspace:hero.png"
              unavailable={false}
              alt={null}
              knownSize={knownSize}
              reserveFrame={reserveFrame}
              sourceDimensions={sourceDimensions}
              placeholderUri={placeholderSize ? "https://example.test/tiny" : undefined}
              onPressPreview={() => {}}
            />
          </MarkdownImageAvailableWidthContext>,
        ),
      );
      if (placeholderSize) await act(async () => harness.loadTiny({ source: placeholderSize }));
      if (knownSize || reserveFrame) expect(frameSize()).toEqual(expected);
      else expect(frameSize()).toEqual({ width: 345, aspectRatio: 16 / 9 });
      await act(async () => harness.loadImage({ source: decoded }));
      const first = frameSize();
      expect(first).toEqual(expected);

      await act(async () =>
        harness.loadImage({ source: { ...decoded, width: decoded.width - 1 } }),
      );
      expect(frameSize()).toEqual(first);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("retries a failed image once its URI comes back through null", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const viewOriginal = vi.fn();
  const view = (uri: string | null) => (
    <ThreadMarkdownImageView
      uri={uri}
      onViewOriginal={viewOriginal}
      sourceKey="attachment:a"
      unavailable={false}
      alt={null}
      onPressPreview={() => {}}
    />
  );
  try {
    await act(async () => root.render(view("https://example.test/a.png")));
    await act(async () => harness.failImage());
    expect(container.textContent).toContain("Image unavailable");
    expect(viewOriginal).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="View original"]')!.click(),
    );
    expect(viewOriginal).toHaveBeenCalledOnce();

    await act(async () => root.render(view(null)));
    await act(async () => root.render(view("https://example.test/a.png")));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(container.querySelector("img")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("fetches a failed SVG again on the next mount but keeps a parsed one", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Microtask scheduling lets act() flush an unmounted atom's removal before the next render.
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const fetchSvg = vi.mocked(fetch);
  vi.mocked(parse).mockReturnValue({ props: {} } as ReturnType<typeof parse>);
  const container = document.createElement("div");
  const root = createRoot(container);
  const uri = "https://example.test/a.svg";
  const view = (mounted: boolean) => (
    <RegistryContext.Provider value={registry}>
      {mounted ? (
        <ThreadMarkdownImageView
          uri={uri}
          sourceKey="attachment:svg"
          unavailable={false}
          alt={null}
          format="svg"
          onPressPreview={() => {}}
        />
      ) : null}
    </RegistryContext.Provider>
  );
  try {
    fetchSvg.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).toContain("Image unavailable"));

    await act(async () => root.render(view(false)));
    fetchSvg.mockResolvedValue({ ok: true, status: 200, text: async () => "<svg />" } as never);
    await act(async () => root.render(view(true)));
    await vi.waitFor(() => expect(container.textContent).not.toContain("Image unavailable"));
    expect(fetchSvg).toHaveBeenCalledTimes(2);

    await act(async () => root.render(view(false)));
    await act(async () => root.render(view(true)));
    expect(container.textContent).not.toContain("Image unavailable");
    expect(fetchSvg).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});

it("does not parse an obsolete SVG response after its last reader unmounts", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      queueMicrotask(task);
      return () => {};
    },
  });
  const root = createRoot(document.createElement("div"));
  const fetchSvg = vi.mocked(fetch);
  const parseSvg = vi.mocked(parse);
  fetchSvg.mockReset();
  parseSvg.mockClear();
  const body = Promise.withResolvers<string>();
  fetchSvg.mockResolvedValue({ ok: true, status: 200, text: () => body.promise } as never);
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ThreadMarkdownImageView
            uri="https://example.test/obsolete.svg"
            sourceKey="attachment:obsolete"
            unavailable={false}
            alt={null}
            format="svg"
            onPressPreview={() => {}}
          />
        </RegistryContext.Provider>,
      ),
    );
    expect(fetchSvg).toHaveBeenCalledOnce();
    const signal = fetchSvg.mock.calls[0]![1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () => body.resolve("<svg />"));
    expect(parseSvg).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    registry.dispose();
  }
});
