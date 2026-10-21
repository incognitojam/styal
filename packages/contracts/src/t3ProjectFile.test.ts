import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3ProjectFile, type T3ProjectFile as T3ProjectFileType } from "./t3ProjectFile.ts";

const decode = Schema.decodeUnknownSync(T3ProjectFile as never) as (
  input: unknown,
) => T3ProjectFileType;

describe("T3ProjectFile", () => {
  it.each(["desktop", "database", "deploy"] as const)("accepts the %s script icon", (icon) => {
    const decoded = decode({ scripts: [{ name: "Action", command: "vp run action", icon }] });

    expect(decoded.scripts?.[0]?.icon).toBe(icon);
  });
});
