// @effect-diagnostics nodeBuiltinImport:off - Uses Node built-in SQLite and fs synchronously to extract trajectory token metrics.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import type { TurnTokenUsage } from "@t3tools/contracts";

export interface AntigravityStepTokens {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

function decodeVarint(buf: Uint8Array, initialOffset: number): [value: number, nextOffset: number] {
  let res = 0;
  let shift = 0;
  let offset = initialOffset;
  while (offset < buf.length) {
    const byte = buf[offset++];
    if (byte === undefined) break;
    res += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [res, offset];
}

interface ProtoField {
  readonly wireType: number;
  readonly varintValue?: number;
  readonly bytesValue?: Uint8Array;
}

function parseProto(buf: Uint8Array): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let offset = 0;
  while (offset < buf.length) {
    let tag: number;
    [tag, offset] = decodeVarint(buf, offset);
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      let val: number;
      [val, offset] = decodeVarint(buf, offset);
      let list = fields.get(fieldNum);
      if (!list) {
        list = [];
        fields.set(fieldNum, list);
      }
      list.push({ wireType, varintValue: val });
    } else if (wireType === 2) {
      let len: number;
      [len, offset] = decodeVarint(buf, offset);
      const val = buf.subarray(offset, offset + len);
      offset += len;
      let list = fields.get(fieldNum);
      if (!list) {
        list = [];
        fields.set(fieldNum, list);
      }
      list.push({ wireType, bytesValue: val });
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return fields;
}

/**
 * Decodes the generation metadata protobuf row from Antigravity's trajectory SQLite DB (`gen_metadata.data`).
 * Field 1: generation metadata submessage
 *   Field 4: token counts submessage
 *     Field 2: uncached input tokens (varint)
 *     Field 3: output tokens (varint)
 *     Field 5: cached input tokens (varint, optional)
 *     Field 9: reasoning / thinking tokens (varint, optional)
 */
export function decodeAntigravityStepTokens(data: Uint8Array): AntigravityStepTokens | undefined {
  try {
    const top = parseProto(data);
    const genBytes = top.get(1)?.[0]?.bytesValue;
    if (!genBytes) return undefined;
    const gen = parseProto(genBytes);
    const tokenBytes = gen.get(4)?.[0]?.bytesValue;
    if (!tokenBytes) return undefined;
    const tokens = parseProto(tokenBytes);
    const uncached = tokens.get(2)?.[0]?.varintValue ?? 0;
    const cached = tokens.get(5)?.[0]?.varintValue ?? 0;
    const output = tokens.get(3)?.[0]?.varintValue ?? 0;
    const reasoning = tokens.get(9)?.[0]?.varintValue ?? 0;
    return {
      inputTokens: uncached + cached,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningTokens: reasoning,
    };
  } catch {
    return undefined;
  }
}

/**
 * Returns the highest generation index currently recorded in `gen_metadata` for the conversation.
 * Returns -1 if the database or table does not exist yet.
 */
export function readAntigravityBaselineGenIndex(dbPath: string): number | undefined {
  if (!NodeFS.existsSync(dbPath)) return -1;
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT coalesce(max(idx), -1) AS maxIdx FROM gen_metadata").get() as
      | { maxIdx?: number }
      | undefined;
    return typeof row?.maxIdx === "number" ? row.maxIdx : -1;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Reads and aggregates token usage for all generation steps appended to `gen_metadata`
 * since `baselineGenIndex`.
 */
export function extractAntigravityTurnTokenUsage(input: {
  readonly dbPath: string;
  readonly baselineGenIndex?: number | undefined;
  readonly completed: boolean;
  readonly hasSubagents: boolean;
}): TurnTokenUsage {
  const { dbPath, baselineGenIndex, completed, hasSubagents } = input;
  if (baselineGenIndex === undefined || !NodeFS.existsSync(dbPath)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC")
      .all(baselineGenIndex) as Array<{ idx: number; data: Uint8Array | Buffer }>;

    if (!rows || rows.length === 0) {
      return {
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents,
      };
    }

    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let observed = false;

    for (const row of rows) {
      const parsed = decodeAntigravityStepTokens(row.data);
      if (!parsed) continue;
      observed = true;
      inputTokens += parsed.inputTokens;
      cachedInputTokens += parsed.cachedInputTokens;
      outputTokens += parsed.outputTokens;
      reasoningTokens += parsed.reasoningTokens;
    }

    if (!observed) {
      return {
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents,
      };
    }

    return {
      usageStatus: completed ? "complete" : "partial",
      usageScope: "main_agent",
      hasSubagents,
      inputTokens,
      cachedInputTokens: Math.min(inputTokens, cachedInputTokens),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, reasoningTokens),
    };
  } catch {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
