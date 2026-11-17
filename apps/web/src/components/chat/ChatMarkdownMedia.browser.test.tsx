import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId, type AssetImagePreview } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { MarkdownTable } from "./MarkdownTable";
import {
  authoredImageSizeStyle,
  ChatMarkdownAssetImage,
  ChatMarkdownImage,
} from "./ChatMarkdownMedia";

// Every evaluation of the URL query is one mint: the first read, then one per refresh.
const assetQuery = vi.hoisted(() => ({ mints: 0, failPreview: false, holdTiny: false }));
vi.mock(import("~/state/assets"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const createUrl = Atom.family((_key: string) =>
    Atom.make(() => {
      assetQuery.mints += 1;
      const input = JSON.parse(_key) as { resource: { imagePreview?: AssetImagePreview } };
      if (assetQuery.holdTiny && input.resource.imagePreview?.width === 64)
        return AsyncResult.initial();
      return AsyncResult.success({
        ...(input.resource.imagePreview ? { imagePreview: input.resource.imagePreview } : {}),
        relativeUrl:
          assetQuery.failPreview &&
          input.resource.imagePreview &&
          input.resource.imagePreview.width !== 64
            ? "data:image/png;base64,AAAA"
            : "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }).pipe(Atom.keepAlive),
  );
  const actual = await original();
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target: { readonly input: unknown }) => createUrl(JSON.stringify(target.input)),
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { Option } = await import("effect");
  const { PrimaryConnectionTarget } = await import("@t3tools/client-runtime/connection");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-1"),
    label: "Local",
    httpBaseUrl: "http://localhost:1",
    wsBaseUrl: "ws://localhost:1",
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: target.wsBaseUrl,
    httpAuthorization: null,
    target,
  };
  return {
    ...(await original()),
    usePreparedConnection: () => Option.some(prepared),
  };
});
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));

describe("ChatMarkdownAssetImage", () => {
  it("does not re-mint an unchanged workspace image's URL on remount", async () => {
    assetQuery.mints = 0;
    const image = (
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: "docs/diagram.png",
        }}
        alt="diagram"
        workspaceMutationId="mutation-1"
      />
    );

    {
      await using screen = await render(image);
      await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    }
    // The first mount at a known revision re-mints the cached URL once.
    expect(assetQuery.mints).toBe(2);

    await using screen = await render(<ChatMarkdownAssetImage {...image.props} />);
    await expect.element(screen.getByRole("img", { name: "diagram" })).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
  });
  it("opens a visible PR image with its display variant and retains an explicit original", async () => {
    assetQuery.mints = 0;
    assetQuery.holdTiny = true;
    using _tiny = {
      [Symbol.dispose]: () => {
        assetQuery.holdTiny = false;
      },
    };
    const onImageExpand = vi.fn();
    await using screen = await render(
      <div style={{ height: 200, overflowY: "auto" }}>
        <div style={{ height: 250 }} />
        <ChatMarkdownAssetImage
          environmentId={EnvironmentId.make("environment-1")}
          resource={{
            _tag: "github-media",
            cwd: "/synthetic",
            url: "https://github.com/user-attachments/assets/pending-tiny",
          }}
          alt="screenshot"
          onImageExpand={onImageExpand}
        />
      </div>,
    );
    await vi.waitFor(() => expect(assetQuery.mints).toBe(2));
    const image = screen.getByRole("button", { name: "Preview screenshot" });
    image.element().scrollIntoView();
    await expect.element(image).toBeVisible();
    await image.click();
    expect(onImageExpand).toHaveBeenCalledOnce();
    const item = onImageExpand.mock.calls[0]![0].images[0];
    expect(item.actionsSource.asset.resource.imagePreview.width).toBeGreaterThanOrEqual(320);
    expect(item.actionsSource.originalAsset.resource).not.toHaveProperty("imagePreview");
    expect(assetQuery.mints).toBe(2);
  });
});

it("loads long-table rows against the panel viewport rather than the table scroller", async () => {
  assetQuery.mints = 0;
  await using screen = await render(
    <div data-panel style={{ height: 200, overflowY: "auto" }}>
      <MarkdownTable>
        <tbody>
          {Array.from({ length: 10 }, (_, row) => (
            <tr key={row}>
              <td style={{ height: 250 }}>
                <ChatMarkdownAssetImage
                  environmentId={EnvironmentId.make("environment-1")}
                  resource={{
                    _tag: "github-media",
                    cwd: "/synthetic",
                    url: `https://github.com/user-attachments/assets/long-table-${row}`,
                  }}
                  alt={`Row ${row}`}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </MarkdownTable>
    </div>,
  );
  await expect.element(screen.getByRole("img", { name: "Row 0" })).toBeVisible();
  const row0 = screen.getByRole("img", { name: "Row 0" }).element();
  await expect.element(screen.getByRole("img", { name: "Row 1" })).toBeInTheDocument();
  for (let row = 2; row < 10; row++)
    expect(screen.container.querySelector(`img[alt="Row ${row}"]`)).toBeNull();
  expect(assetQuery.mints).toBe(4);
  const before = assetQuery.mints;
  screen.container.querySelector("[data-panel]")!.scrollTop = 2000;
  await expect.element(screen.getByRole("img", { name: "Row 8" })).toBeVisible();
  expect(assetQuery.mints).toBeGreaterThan(before);
  expect(row0.isConnected).toBe(true);
});

it.each([
  { width: 300, height: undefined },
  { width: 180, height: 360 },
])(
  "reserves the frame through decode and clears loading semantics: $width × $height",
  async ({ width, height }) => {
    const pending = (
      <ChatMarkdownImage
        src={null}
        alt="standalone screenshot"
        copyMarkdown={undefined}
        standalone
        reserveFrame
        style={authoredImageSizeStyle(width, height)}
        actionsSource={{ kind: "image", name: "screenshot", src: null }}
      />
    );
    await using screen = await render(pending);
    const frame = screen.getByRole("status", { name: "Loading image" }).element();
    await screen.rerender(
      <ChatMarkdownImage {...pending.props} sourceDimensions={{ width: 120, height: 40 }} />,
    );
    const before = frame.getBoundingClientRect();
    expect(before.width).toBeGreaterThan(0);
    expect(before.height).toBeGreaterThan(0);
    expect(before.width).toBe(width);
    const loaded = new Promise<EventTarget | null>((resolve) => {
      frame.addEventListener(
        "load",
        (event) => {
          if ((event.target as HTMLImageElement).alt === "standalone screenshot")
            resolve(event.target);
        },
        { capture: true },
      );
    });
    await screen.rerender(
      <ChatMarkdownImage
        {...pending.props}
        sourceDimensions={{ width: 120, height: 40 }}
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
      />,
    );
    const loadedImage = await loaded;
    const image = screen.getByRole("img", { name: "standalone screenshot" });
    await expect.element(image).toBeVisible();
    expect(image.element()).toBe(loadedImage);
    expect(frame.getAttribute("role")).toBeNull();
    expect(frame.getAttribute("aria-label")).toBeNull();
    expect(frame.getBoundingClientRect().width).toBe(before.width);
    expect(frame.getBoundingClientRect().height).toBe(before.height);
  },
);

it("loads an original only after selecting recovery from a failed preview", async () => {
  assetQuery.mints = 0;
  assetQuery.failPreview = true;
  try {
    await using screen = await render(
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "github-media",
          cwd: "/synthetic",
          url: "https://github.com/user-attachments/assets/rejected-image",
        }}
        alt="rejected"
        standalone
      />,
    );
    await expect.element(screen.getByRole("alert")).toBeInTheDocument();
    expect(assetQuery.mints).toBe(2);
    await screen.getByRole("button", { name: "View original" }).click();
    await expect.element(screen.getByRole("img", { name: "rejected" })).toBeVisible();
    expect(assetQuery.mints).toBe(3);
  } finally {
    assetQuery.failPreview = false;
  }
});

it.each([
  { panelWidth: 320, imageWidth: 1280, imageHeight: 1138 },
  { panelWidth: 420, imageWidth: 1280, imageHeight: 1138 },
  { panelWidth: 719, imageWidth: 1080, imageHeight: 2400 },
])(
  "matches main's #1528 table sizing with at most one neighbour rebalance at $panelWidth px",
  async ({ panelWidth, imageWidth, imageHeight }) => {
    const view = (src: string | null, preview = true, known = 2, loaded = 2) => (
      <div className="chat-markdown" style={{ width: panelWidth }}>
        <table>
          <thead>
            <tr>
              <th />
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Folded and open reports</td>
              {["Before", "After"].map((alt, index) => (
                <td key={alt}>
                  <ChatMarkdownImage
                    key={String(preview)}
                    src={index < loaded ? src : null}
                    alt={alt}
                    standalone
                    reserveFrame={preview}
                    sourceDimensions={
                      index < known ? { width: imageWidth, height: imageHeight } : undefined
                    }
                    copyMarkdown={undefined}
                    actionsSource={{ kind: "image", name: alt, src }}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
    const source = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}"/>`)}`;
    await using screen = await render(view(source, false));
    await expect.element(screen.getByRole("img", { name: "Before" })).toBeVisible();
    const originalWidths = ["Before", "After"].map(
      (name) => screen.getByRole("img", { name }).element().getBoundingClientRect().width,
    );
    await screen.rerender(view(null, true, 0));
    const table = screen.container.querySelector("table")!;
    const frames = [...table.querySelectorAll<HTMLElement>('[role="status"]')];
    const frameSizes = () =>
      frames.map((frame) => {
        const { width, height } = frame.getBoundingClientRect();
        return { width, height };
      });
    const initial = frameSizes();
    expect(initial.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
    const stages = [initial];
    await screen.rerender(view(null, true, 1));
    stages.push(frameSizes());
    await screen.rerender(view(null));
    stages.push(frameSizes());
    expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(panelWidth);
    const sizes = frames.map((frame) => frame.getBoundingClientRect().height);
    expect(frames.every((frame) => frame.getBoundingClientRect().width <= panelWidth / 2)).toBe(
      true,
    );
    for (const [index, frame] of frames.entries())
      expect(Math.abs(frame.getBoundingClientRect().width - originalWidths[index]!)).toBeLessThan(
        2,
      );
    await screen.rerender(view(source, true, 2, 1));
    await expect.element(screen.getByRole("img", { name: "Before" })).toBeVisible();
    stages.push(frameSizes());
    await screen.rerender(view(source));
    await expect.element(screen.getByRole("img", { name: "After" })).toBeVisible();
    stages.push(frameSizes());
    for (const [index] of frames.entries()) {
      const changes = stages.slice(1).filter((stage, step) => {
        const before = stages[step]![index]!;
        const after = stage[index]!;
        return before.width !== after.width || before.height !== after.height;
      });
      expect(changes.length).toBeLessThanOrEqual(2);
    }
    expect(stages[3]).toEqual(stages[2]);
    expect(stages[4]).toEqual(stages[2]);
    expect(frames.map((frame) => frame.getBoundingClientRect().height)).toEqual(sizes);
  },
);
