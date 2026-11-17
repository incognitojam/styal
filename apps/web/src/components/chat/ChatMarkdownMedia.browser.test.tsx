import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId, type AssetImagePreview } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
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
      <ChatMarkdownAssetImage
        environmentId={EnvironmentId.make("environment-1")}
        resource={{
          _tag: "github-media",
          cwd: "/synthetic",
          url: "https://github.com/user-attachments/assets/pending-tiny",
        }}
        alt="screenshot"
        onImageExpand={onImageExpand}
      />,
    );
    const image = screen.getByRole("button", { name: "Preview screenshot" });
    await expect.element(image).toBeVisible();
    await image.click();
    expect(onImageExpand).toHaveBeenCalledOnce();
    const item = onImageExpand.mock.calls[0]![0].images[0];
    expect(item.actionsSource.asset.resource.imagePreview.width).toBeGreaterThanOrEqual(320);
    expect(item.actionsSource.originalAsset.resource).not.toHaveProperty("imagePreview");
    expect(assetQuery.mints).toBe(2);
  });
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
      frame.addEventListener("load", (event) => resolve(event.target), {
        capture: true,
        once: true,
      });
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

it("fits preview frames inside narrow comparison table cells", async () => {
  const view = (src: string | null) => (
    <div className="chat-markdown" style={{ width: 420 }}>
      <table>
        <tbody>
          <tr>
            {["Before", "After"].map((alt) => (
              <td key={alt}>
                <ChatMarkdownImage
                  src={src}
                  alt={alt}
                  standalone
                  reserveFrame
                  sourceDimensions={{ width: 1280, height: 800 }}
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
  await using screen = await render(view(null));
  const table = screen.container.querySelector("table")!;
  expect(table.getBoundingClientRect().width).toBeLessThanOrEqual(420);
  const frames = [...table.querySelectorAll<HTMLElement>('[role="status"]')];
  const sizes = frames.map((frame) => frame.getBoundingClientRect().height);
  expect(frames.every((frame) => frame.getBoundingClientRect().width <= 210)).toBe(true);
  await screen.rerender(
    view("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  );
  await expect.element(screen.getByRole("img", { name: "Before" })).toBeVisible();
  expect(frames.map((frame) => frame.getBoundingClientRect().height)).toEqual(sizes);
});
