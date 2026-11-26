import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema } from "./settings.ts";
const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
it("keeps fresh input and approval sounds quiet and preserves explicit choices", () => {
  expect(decode({})).toMatchObject({
    completionSound: "t3-completion",
    inputSound: "none",
    approvalSound: "none",
  });
  expect(decode({ inputSound: "t3-input", approvalSound: "t3-input" })).toMatchObject({
    inputSound: "t3-input",
    approvalSound: "t3-input",
  });
});
