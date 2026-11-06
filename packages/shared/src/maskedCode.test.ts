import { describe, expect, it } from "@effect/vitest";

import { applyMaskedEdit, maskCode } from "./maskedCode.ts";

const CODE = "abcdefgh123456";

describe("maskCode", () => {
  it.each([
    ["", ""],
    ["abc", "abc"],
    ["abcdef", "abcdef"],
    ["abcdefg", "*bcdefg"],
    [CODE, "********123456"],
  ])("masks %j as %j", (code, masked) => {
    expect(maskCode(code)).toBe(masked);
  });
});

describe("applyMaskedEdit", () => {
  const masked = maskCode(CODE);
  it.each([
    { name: "a paste into an empty field", code: "", text: CODE, caret: CODE.length, out: CODE },
    { name: "a paste with no caret", code: "", text: CODE, caret: undefined, out: CODE },
    {
      name: "replacing everything with a paste",
      code: CODE,
      text: "new-code-789",
      caret: 12,
      out: "new-code-789",
    },
    { name: "clearing the field", code: CODE, text: "", caret: 0, out: "" },
    { name: "typing at the end", code: CODE, text: `${masked}7`, caret: 15, out: `${CODE}7` },
    {
      name: "backspace at the end",
      code: CODE,
      text: masked.slice(0, -1),
      caret: 13,
      out: CODE.slice(0, -1),
    },
    {
      name: "backspace at the end with no caret",
      code: CODE,
      text: masked.slice(0, -1),
      caret: undefined,
      out: CODE.slice(0, -1),
    },
    {
      name: "backspace inside the masked part",
      code: CODE,
      text: `*******123456`,
      caret: 1,
      out: "acdefgh123456",
    },
    {
      name: "typing inside the masked part",
      code: CODE,
      text: `**X******123456`,
      caret: 3,
      out: "abXcdefgh123456",
    },
    { name: "no change", code: CODE, text: masked, caret: 14, out: CODE },
  ])("handles $name", ({ code, text, caret, out }) => {
    expect(applyMaskedEdit(code, text, caret)).toBe(out);
  });

  it("recovers the code from the masked text it shows after each keystroke", () => {
    let code = "";
    for (const character of CODE) {
      const typed = maskCode(code) + character;
      code = applyMaskedEdit(code, typed, typed.length);
    }
    expect(code).toBe(CODE);
  });
});
