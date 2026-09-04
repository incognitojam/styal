import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { StyalProjectFile } from "./styalProjectFile.ts";

const decode = Schema.decodeUnknownSync(StyalProjectFile);

describe("StyalProjectFile", () => {
  it("decodes a full project file", () => {
    const decoded = decode({
      $schema: "https://styal.build/schema/styal.json",
      iconPath: "assets/logo.svg",
      scripts: [
        {
          id: "dev",
          name: "Dev",
          command: "pnpm dev",
          icon: "play",
        },
        { name: "Test", command: "pnpm test" },
      ],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts).toHaveLength(2);
    expect(decoded.scripts?.[0]?.id).toBe("dev");
    expect(decoded.scripts?.[0]).toEqual({
      id: "dev",
      name: "Dev",
      command: "pnpm dev",
      icon: "play",
    });
    expect(decoded.scripts?.[1]).toEqual({ name: "Test", command: "pnpm test" });
  });

  it("decodes an empty object and ignores unknown fields", () => {
    expect(decode({})).toEqual({});
    expect(decode({ futureField: true })).toEqual({});
  });

  it("trims icon paths and script fields", () => {
    const decoded = decode({
      iconPath: " assets/logo.svg ",
      scripts: [{ name: " Dev ", command: " pnpm dev " }],
    });

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("rejects scripts without a command", () => {
    expect(() => decode({ scripts: [{ name: "Dev" }] })).toThrow();
  });

  it("rejects unknown script icons", () => {
    expect(() =>
      decode({ scripts: [{ name: "Dev", command: "pnpm dev", icon: "rocket" }] }),
    ).toThrow();
  });

  it.each(["desktop", "database", "deploy"] as const)("accepts the %s script icon", (icon) => {
    const decoded = decode({ scripts: [{ name: "Action", command: "vp run action", icon }] });

    expect(decoded.scripts?.[0]?.icon).toBe(icon);
  });

  it("rejects script ids that cannot back a keybinding command", () => {
    expect(() =>
      decode({ scripts: [{ id: "Dev Server", name: "Dev", command: "pnpm dev" }] }),
    ).toThrow();
  });

  it("decodes defaultThreadEnvMode and rejects unknown modes", () => {
    expect(decode({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe("worktree");
    expect(decode({ defaultThreadEnvMode: "local" }).defaultThreadEnvMode).toBe("local");
    expect(() => decode({ defaultThreadEnvMode: "remote" })).toThrow();
  });
});
