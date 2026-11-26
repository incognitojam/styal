import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings.ts";
import { DEFAULT_MODEL, DEFAULT_MODEL_BY_PROVIDER } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
const decode = Schema.decodeUnknownSync(ClientSettingsSchema);
it("decodes fresh and saved alert preferences and chooses the carried provider models", () => {
  expect(decode({}).notificationMode).toBe("sound");
  expect(decode({ notificationMode: "off" }).notificationMode).toBe("off");
  expect(DEFAULT_CLIENT_SETTINGS.notificationMode).toBe("sound");
  expect(DEFAULT_MODEL).toBe("gpt-6.2-sol");
  expect(DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")]).toBe("claude-opus-5-5");
});
