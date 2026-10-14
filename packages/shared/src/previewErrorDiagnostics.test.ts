import { describe, expect, it } from "vite-plus/test";
import {
  previewAutomationFailureReason,
  previewAutomationFailureReasonSuffix,
} from "./previewErrorDiagnostics.ts";

describe("previewAutomationFailureReason", () => {
  it("prefers structured network codes to names and message text", () => {
    const cause = Object.assign(new TypeError("SyntaxError: net::ERR_FAILED private-text"), {
      code: "ERR_CONNECTION_REFUSED",
    });
    expect(previewAutomationFailureReason(cause)).toBe("ERR_CONNECTION_REFUSED");
    expect(previewAutomationFailureReasonSuffix(cause)).toBe(
      " [styal-preview-reason=ERR_CONNECTION_REFUSED]",
    );
  });

  it("uses the CDP exception class without inspecting its page-controlled description", () => {
    expect(
      previewAutomationFailureReason({
        text: "private-text",
        exception: { className: "SyntaxError", description: "TypeError: private-text" },
      }),
    ).toBe("SyntaxError");
    expect(
      previewAutomationFailureReason({
        exception: { className: "CustomError", description: "TypeError: private-text" },
      }),
    ).toBeUndefined();
  });

  it("ignores unknown IPC tokens and limits inspection of wrapped and hostile errors", () => {
    expect(
      previewAutomationFailureReason(
        new Error(
          "Error invoking remote method 'preview:evaluate': [styal-preview-reason=CustomError]",
        ),
      ),
    ).toBeUndefined();
    const cyclic = { cause: undefined as unknown };
    cyclic.cause = cyclic;
    expect(previewAutomationFailureReason(cyclic)).toBeUndefined();
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error("private-text");
        },
      },
    );
    expect(previewAutomationFailureReasonSuffix(throwing)).toBe("");
    let nested: unknown = new TypeError("private-text");
    for (let depth = 0; depth < 5; depth++) nested = { cause: nested };
    expect(previewAutomationFailureReason(nested)).toBeUndefined();
  });
});
