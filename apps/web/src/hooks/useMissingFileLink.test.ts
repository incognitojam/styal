import { workspaceFileLookup } from "@t3tools/client-runtime/workspace-basename-lookup";
import { describe, expect, it } from "vite-plus/test";

import { isMissingFileLink } from "./useMissingFileLink";

const missing = { isSuccess: true, data: null };
const loading = { isSuccess: false, data: null };
const searched = (paths: readonly string[], truncated = false) => ({
  isSuccess: true,
  data: { entries: paths.map((path) => ({ path, kind: "file" as const })), truncated },
});
const shortened = workspaceFileLookup("ui/command.tsx", "/repo");

describe("isMissingFileLink", () => {
  it("keeps a path that exists as written", () => {
    expect(
      isMissingFileLink({
        literal: { isSuccess: true, data: { kind: "file" } },
        lookup: shortened,
        search: loading,
      }),
    ).toBe(false);
  });

  it("keeps a path until the host has answered", () => {
    expect(isMissingFileLink({ literal: loading, lookup: null, search: loading })).toBe(false);
  });

  it("drops a missing path that has no workspace lookup", () => {
    expect(isMissingFileLink({ literal: missing, lookup: null, search: loading })).toBe(true);
  });

  it("keeps a missing path until the workspace search has answered", () => {
    expect(isMissingFileLink({ literal: missing, lookup: shortened, search: loading })).toBe(false);
  });

  it("keeps a missing path that the workspace search resolves", () => {
    expect(
      isMissingFileLink({
        literal: missing,
        lookup: shortened,
        search: searched(["apps/web/src/components/ui/command.tsx"]),
      }),
    ).toBe(false);
  });

  it("drops a missing path that the workspace search does not resolve", () => {
    expect(
      isMissingFileLink({
        literal: missing,
        lookup: shortened,
        search: searched(["apps/web/src/components/ui/commandBar.tsx"]),
      }),
    ).toBe(true);
  });

  it("drops a missing path whose suffix matches more than one file", () => {
    expect(
      isMissingFileLink({
        literal: missing,
        lookup: shortened,
        search: searched(["apps/web/src/ui/command.tsx", "apps/mobile/src/ui/command.tsx"]),
      }),
    ).toBe(true);
  });

  it("drops a missing path that a full page of fuzzy results does not resolve", () => {
    expect(
      isMissingFileLink({
        literal: missing,
        lookup: shortened,
        search: searched(
          Array.from({ length: 25 }, (_, index) => `apps/web/src/components/Command${index}.tsx`),
          true,
        ),
      }),
    ).toBe(true);
  });

  it("keeps a missing path while the workspace index is still scanning", () => {
    expect(
      isMissingFileLink({
        literal: missing,
        lookup: shortened,
        search: searched(["apps/web/src/components/ui/commandBar.tsx"], true),
      }),
    ).toBe(false);
  });
});
