import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId, type AssetImagePreview } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ChatMarkdownAssetImage, ChatMarkdownImage } from "./ChatMarkdownMedia";

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

it("clears standalone loading semantics after decode while retaining the image node", async () => {
  const pending = (
    <ChatMarkdownImage
      src={null}
      alt="standalone screenshot"
      copyMarkdown={undefined}
      standalone
      actionsSource={{ kind: "image", name: "screenshot", src: null }}
    />
  );
  await using screen = await render(pending);
  const frame = screen.getByRole("status", { name: "Loading image" }).element();
  const loaded = new Promise<EventTarget | null>((resolve) => {
    frame.addEventListener("load", (event) => resolve(event.target), {
      capture: true,
      once: true,
    });
  });
  await screen.rerender(
    <ChatMarkdownImage
      {...pending.props}
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    />,
  );
  const loadedImage = await loaded;
  const image = screen.getByRole("img", { name: "standalone screenshot" });
  await expect.element(image).toBeVisible();
  expect(image.element()).toBe(loadedImage);
  expect(frame.getAttribute("role")).toBeNull();
  expect(frame.getAttribute("aria-label")).toBeNull();
});

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
