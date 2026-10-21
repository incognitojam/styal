import type { Dispatch, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastTarget: null as unknown,
  lastResource: null as unknown,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.faviconUrl,
}));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.lastResource = resource;
    return resource === null ? { _tag: "Loading" } : { _tag: "Success", url: testState.faviconUrl };
  },
}));
vi.mock("../state/assets", () => ({
  projectFaviconUrlAtom: (input: unknown) => {
    testState.lastTarget = input;
  },
}));

import { ProjectFavicon } from "./ProjectFavicon";

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
  });

  it("requests a server-validated legacy project favicon", () => {
    ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      legacyProjectId: "legacy-project",
    });

    expect(testState.lastResource).toEqual({
      _tag: "legacy-project-favicon",
      projectId: "legacy-project",
    });
  });
});
