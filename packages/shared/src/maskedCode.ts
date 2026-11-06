const VISIBLE_ENDING = 6;

/** Masks a pasted sign-in code as Claude's own prompt does, so a cut-off paste still shows. */
export const maskCode = (code: string): string =>
  "*".repeat(Math.max(0, code.length - VISIBLE_ENDING)) + code.slice(-VISIBLE_ENDING);

/**
 * The real code after an edit to its masked text. `caret` is where the cursor ended up, when the
 * platform reports it. Masked characters are indistinguishable, so without it an edit inside the
 * masked part is placed as late as it can be.
 */
export const applyMaskedEdit = (code: string, masked: string, caret?: number | null): string => {
  const previous = maskCode(code);
  if (masked === previous) return code;
  let suffix = 0;
  if (caret != null) {
    suffix = Math.min(masked.length - caret, previous.length);
  } else {
    while (
      suffix < Math.min(masked.length, previous.length) &&
      masked[masked.length - 1 - suffix] === previous[previous.length - 1 - suffix]
    ) {
      suffix++;
    }
  }
  const insertedEnd = masked.length - suffix;
  let prefix = 0;
  while (
    prefix < Math.min(insertedEnd, previous.length - suffix) &&
    masked[prefix] === previous[prefix]
  ) {
    prefix++;
  }
  return (
    code.slice(0, prefix) + masked.slice(prefix, insertedEnd) + code.slice(code.length - suffix)
  );
};
