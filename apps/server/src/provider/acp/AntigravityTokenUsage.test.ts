// @effect-diagnostics nodeBuiltinImport:off - Unit tests use Node sqlite and fs to create ephemeral test fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeAntigravityStepTokens,
  extractAntigravityTurnTokenUsage,
  readAntigravityBaselineGenIndex,
} from "./AntigravityTokenUsage.ts";

function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let remaining = val;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function encodeField(num: number, wireType: number, payload: Buffer): Buffer {
  const tag = (num << 3) | wireType;
  return Buffer.concat([encodeVarint(tag), payload]);
}

function makeGenMetadataBlob(
  uncachedInput: number,
  output: number,
  cachedInput = 0,
  reasoning = 0,
): Buffer {
  const tokenParts = [
    encodeField(2, 0, encodeVarint(uncachedInput)),
    encodeField(3, 0, encodeVarint(output)),
  ];
  if (cachedInput > 0) {
    tokenParts.push(encodeField(5, 0, encodeVarint(cachedInput)));
  }
  if (reasoning > 0) {
    tokenParts.push(encodeField(9, 0, encodeVarint(reasoning)));
  }
  const tokenMsg = Buffer.concat(tokenParts);
  const tokenField = encodeField(4, 2, Buffer.concat([encodeVarint(tokenMsg.length), tokenMsg]));
  const genField = encodeField(1, 2, Buffer.concat([encodeVarint(tokenField.length), tokenField]));
  return genField;
}

describe("AntigravityTokenUsage", () => {
  describe("decodeAntigravityStepTokens", () => {
    it("decodes uncached input and output tokens", () => {
      const blob = makeGenMetadataBlob(150, 45);
      const decoded = decodeAntigravityStepTokens(blob);
      expect(decoded).toEqual({
        inputTokens: 150,
        cachedInputTokens: 0,
        outputTokens: 45,
        reasoningTokens: 0,
      });
    });

    it("decodes cached input and reasoning tokens", () => {
      const blob = makeGenMetadataBlob(50, 100, 200, 40);
      const decoded = decodeAntigravityStepTokens(blob);
      expect(decoded).toEqual({
        inputTokens: 250, // 50 uncached + 200 cached
        cachedInputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 40,
      });
    });

    it("returns undefined for empty or invalid data", () => {
      expect(decodeAntigravityStepTokens(new Uint8Array([]))).toBeUndefined();
      expect(decodeAntigravityStepTokens(new Uint8Array([0xff, 0xff]))).toBeUndefined();
      expect(decodeAntigravityStepTokens(new Uint8Array([8, 1]))).toBeUndefined();
    });
  });

  describe("readAntigravityBaselineGenIndex", () => {
    it("returns -1 for nonexistent file", () => {
      expect(readAntigravityBaselineGenIndex("/nonexistent/file.db")).toBe(-1);
    });

    it("returns max index from gen_metadata", () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agy-test-"));
      const dbPath = NodePath.join(tempDir, "test.db");
      try {
        const db = new NodeSqlite.DatabaseSync(dbPath);
        db.exec("CREATE TABLE gen_metadata (idx integer primary key, data blob)");
        expect(readAntigravityBaselineGenIndex(dbPath)).toBe(-1);

        db.exec("INSERT INTO gen_metadata (idx, data) VALUES (0, X'00'), (5, X'00'), (3, X'00')");
        db.close();

        expect(readAntigravityBaselineGenIndex(dbPath)).toBe(5);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("extractAntigravityTurnTokenUsage", () => {
    it("returns unavailable if DB file does not exist", () => {
      const result = extractAntigravityTurnTokenUsage({
        dbPath: "/nonexistent/test.db",
        completed: true,
        hasSubagents: false,
      });
      expect(result).toEqual({
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      });
    });

    it("returns unavailable if no generation rows exist past baseline", () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agy-test-"));
      const dbPath = NodePath.join(tempDir, "test.db");
      try {
        const db = new NodeSqlite.DatabaseSync(dbPath);
        db.exec("CREATE TABLE gen_metadata (idx integer primary key, data blob)");
        const blob = makeGenMetadataBlob(100, 20);
        const stmt = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
        stmt.run(0, blob);
        db.close();

        const result = extractAntigravityTurnTokenUsage({
          dbPath,
          baselineGenIndex: 0,
          completed: true,
          hasSubagents: false,
        });
        expect(result).toEqual({
          usageStatus: "unavailable",
          usageScope: "main_agent",
          hasSubagents: false,
        });
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("aggregates multiple steps in a turn and reflects completion state", () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agy-test-"));
      const dbPath = NodePath.join(tempDir, "test.db");
      try {
        const db = new NodeSqlite.DatabaseSync(dbPath);
        db.exec("CREATE TABLE gen_metadata (idx integer primary key, data blob)");
        const stmt = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");

        // Step 0 was before baseline (e.g. previous turn)
        stmt.run(0, makeGenMetadataBlob(1000, 100));

        // Turn steps: idx 1 and idx 2
        stmt.run(1, makeGenMetadataBlob(200, 50, 800, 20));
        stmt.run(2, makeGenMetadataBlob(150, 80, 850, 30));
        db.close();

        const result = extractAntigravityTurnTokenUsage({
          dbPath,
          baselineGenIndex: 0,
          completed: true,
          hasSubagents: true,
        });

        // Step 1: input = 200 + 800 = 1000, cached = 800, output = 50, reasoning = 20
        // Step 2: input = 150 + 850 = 1000, cached = 850, output = 80, reasoning = 30
        // Total: input = 2000, cached = 1650, output = 130, reasoning = 50
        expect(result).toEqual({
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: true,
          inputTokens: 2000,
          cachedInputTokens: 1650,
          outputTokens: 130,
          reasoningTokens: 50,
        });

        // Partial when turn is not completed (e.g. cancelled / interrupted)
        const partialResult = extractAntigravityTurnTokenUsage({
          dbPath,
          baselineGenIndex: 0,
          completed: false,
          hasSubagents: false,
        });
        expect(partialResult.usageStatus).toBe("partial");
        expect(partialResult.hasSubagents).toBe(false);
        expect(partialResult.inputTokens).toBe(2000);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
