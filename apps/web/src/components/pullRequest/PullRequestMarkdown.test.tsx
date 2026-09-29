import type { PullRequestDetailView, EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ChatMarkdown", () => ({
  default: ({
    imageRenderer,
  }: {
    imageRenderer: (props: { src: string; alt: string }) => ReactNode;
  }) => (
    <div>
      {imageRenderer({ src: "https://example.com/first.png", alt: "First" })}
      {imageRenderer({ src: "images/second.png", alt: "Second" })}
    </div>
  ),
}));

vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: () => ({ _tag: "Success", url: "http://localhost/authorized-second.png" }),
}));

vi.mock("../chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: ({
    preview,
    onClose,
  }: {
    preview: { index: number; images: { name: string }[] };
    onClose: () => void;
  }) => (
    <button type="button" onClick={onClose}>
      {`${preview.index}:${preview.images.map((image) => image.name).join(",")}`}
    </button>
  ),
}));

import { PullRequestMarkdown } from "./PullRequestMarkdown";

describe("PullRequestMarkdown image preview", () => {
  it("opens the clicked image at its position in the PR gallery and closes it", async () => {
    const linked = new Set<number>();
    const elements: {
      closest: (selector: string) => unknown;
    }[] = [];
    const scope = { querySelectorAll: () => elements };
    let renderer: ReactTestRenderer;
    await act(() => {
      renderer = create(
        <PullRequestMarkdown
          text="![First](https://example.com/first.png) ![Second](https://example.com/second.png)"
          detail={
            {
              provider: "github",
              repository: "example/repo",
              url: "https://github.com/example/repo/pull/1",
              headBranch: "main",
              workspaceRoot: "/workspace/repo",
            } as PullRequestDetailView
          }
          environmentId={"test-environment" as EnvironmentId}
        />,
        {
          createNodeMock: (element) => {
            if (element.type !== "img") return null;
            const index = elements.length;
            const node = {
              closest: (selector: string) =>
                selector === "[data-image-gallery]"
                  ? scope
                  : selector === "a" && linked.has(index)
                    ? { href: "https://example.com" }
                    : null,
            };
            elements.push(node);
            return node;
          },
        },
      );
    });

    const images = renderer!.root.findAllByType("img");
    expect(images).toHaveLength(2);
    expect(images[1]!.props.src).toBe("http://localhost/authorized-second.png");
    await act(() => {
      images[1]!.props.onClick({
        currentTarget: elements[1],
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(renderer!.root.findByType("button").children).toEqual(["1:First,Second"]);

    await act(() => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    linked.add(0);
    await act(() => {
      images[0]!.props.onClick({
        currentTarget: elements[0],
        preventDefault() {},
        stopPropagation() {},
      });
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    await act(() => renderer!.unmount());
  });
});
