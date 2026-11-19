/** Oldest first across kinds; the key keeps rows with the same time in a stable order. */
export function oldestFirst<Row>(
  rows: ReadonlyArray<Row>,
  at: (row: Row) => string,
  key: (row: Row) => string,
): Row[] {
  return [...rows].sort((a, b) => at(a).localeCompare(at(b)) || key(a).localeCompare(key(b)));
}
