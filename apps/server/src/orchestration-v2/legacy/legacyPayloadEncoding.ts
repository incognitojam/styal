/**
 * Keep small metadata edits from changing the payload's byte length. SQLite can reuse
 * unchanged overflow pages only when the record size stays the same. Trailing whitespace
 * is valid JSON; cap it so removing a large obsolete field still releases its storage.
 */
export function preserveLegacyPayloadSize(previous: string, next: string): string {
  const difference = Buffer.byteLength(previous) - Buffer.byteLength(next);
  return difference > 0 && difference <= 64 ? next + " ".repeat(difference) : next;
}

// SQLite stores nonnegative ordinals in 0, 1, 2, 3, 4, 6 or 8 bytes (0 and 1 are special).
const ordinalStorageBytes = (ordinal: number): number => {
  if (ordinal <= 1) return 0;
  if (ordinal <= 127) return 1;
  if (ordinal <= 32_767) return 2;
  if (ordinal <= 8_388_607) return 3;
  if (ordinal <= 2_147_483_647) return 4;
  if (ordinal <= 140_737_488_355_327) return 6;
  return 8;
};

/** Keep the JSON body at the same record offset when the preceding ordinal column shrinks. */
export function legacyProjectionPayloadWithOrdinal(
  payload: string,
  previous: number,
  ordinal: number,
): string {
  const padding = Math.max(0, ordinalStorageBytes(previous) - ordinalStorageBytes(ordinal));
  return " ".repeat(padding) + legacyPayloadWithOrdinal(payload, ordinal);
}

/**
 * Preserve the ordinal token's width when it shrinks so bytes after it do not shift.
 * Imported payloads put their large activity arrays before the root ordinal. Search from
 * the end and parse only the suffix to distinguish the root field from nested ordinals.
 * Selection queries already validate the complete JSON.
 */
export function legacyPayloadWithOrdinal(payload: string, ordinal: number): string {
  let key = payload.lastIndexOf('"ordinal"');
  while (key !== -1) {
    const suffix = payload.slice(key);
    const match = /^"ordinal"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\s*)(?=[,}])/.exec(
      suffix,
    );
    if (match !== null) {
      try {
        // A nested field leaves extra closing braces or brackets, so this parse fails.
        JSON.parse("{" + suffix);
        const valueStart = key + match[0].length - match[1]!.length;
        return (
          payload.slice(0, valueStart) +
          String(ordinal).padEnd(match[1]!.length, " ") +
          payload.slice(key + match[0].length)
        );
      } catch {
        // Continue to the enclosing object's ordinal.
      }
    }
    key = key === 0 ? -1 : payload.lastIndexOf('"ordinal"', key - 1);
  }

  // Unusual field spellings or missing ordinals use normal object encoding.
  const value: unknown = JSON.parse(payload);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? JSON.stringify({ ...value, ordinal })
    : payload;
}
