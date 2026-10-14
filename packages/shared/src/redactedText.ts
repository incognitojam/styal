const REDACTED_TEXT_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * A stand-in for sensitive text such as an account email. It keeps the
 * value's length and its `@ . - _` separators, and the same value always
 * produces the same placeholder, so the redacted text looks like a real
 * address without revealing it.
 */
export function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }

  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return REDACTED_TEXT_ALPHABET[Math.abs(state) % REDACTED_TEXT_ALPHABET.length] ?? "x";
  };

  return Array.from(value, (char) => {
    if (char === "@" || char === "." || char === "-" || char === "_") return char;
    return nextChar();
  }).join("");
}
