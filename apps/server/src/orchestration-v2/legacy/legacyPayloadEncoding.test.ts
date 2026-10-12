import { assert, describe, it } from "@effect/vitest";

import {
  legacyPayloadWithOrdinal,
  legacyProjectionPayloadWithOrdinal,
  preserveLegacyPayloadSize,
} from "./legacyPayloadEncoding.ts";

describe("legacy payload encoding", () => {
  it("compensates for shrinking ordinal columns without padding growing columns", () => {
    for (const [previous, ordinal, padding] of [
      [100, 1, 1],
      [128, 127, 1],
      [32_768, 32_767, 1],
      [8_388_608, 8_388_607, 1],
      [2_147_483_648, 2_147_483_647, 2],
      [140_737_488_355_328, 140_737_488_355_327, 2],
      [2, 100, 0],
    ]) {
      const payload = JSON.stringify({ ordinal: previous, body: "😀" });
      const updated = legacyProjectionPayloadWithOrdinal(payload, previous!, ordinal!);
      assert.equal(updated, " ".repeat(padding!) + legacyPayloadWithOrdinal(payload, ordinal!));
      assert.deepEqual(JSON.parse(updated), { ordinal, body: "😀" });
    }
  });
  it("changes only the root ordinal while preserving surrounding bytes", () => {
    const payload = JSON.stringify({
      legacyActivities: [{ ordinal: 456, text: 'escaped \\"ordinal\\": 999 and 😀' }],
      ordinal: 123,
      input: { ordinal: 789 },
    });
    const updated = legacyPayloadWithOrdinal(payload, 2);
    assert.equal(updated, payload.replace('"ordinal":123,', '"ordinal":2  ,'));
    assert.deepEqual(JSON.parse(updated), { ...JSON.parse(payload), ordinal: 2 });
    assert.equal(Buffer.byteLength(updated), Buffer.byteLength(payload));
  });

  it("handles whitespace, exponent notation and growing ordinals", () => {
    const payload = '{ "ordinal" : 1.2e3  , "text": "é" }';
    const updated = legacyPayloadWithOrdinal(payload, 4);
    assert.equal(Buffer.byteLength(updated), Buffer.byteLength(payload));
    assert.deepEqual(JSON.parse(updated), { ordinal: 4, text: "é" });
    assert.deepEqual(JSON.parse(legacyPayloadWithOrdinal('{"ordinal":1}', 123)), { ordinal: 123 });
  });

  it("falls back to object encoding for missing, escaped or nonnumeric fields", () => {
    for (const payload of ['{"text":"ordinal"}', '{"\\u006frdinal":123}', '{"ordinal":null}']) {
      assert.deepEqual(JSON.parse(legacyPayloadWithOrdinal(payload, 2)), {
        ...JSON.parse(payload),
        ordinal: 2,
      });
    }
  });

  it("pads small UTF-8 metadata reductions without retaining large removed fields", () => {
    const previous = '{"text":"😀","status":"interrupted"}';
    const next = '{"text":"😀","status":"completed"}';
    const updated = preserveLegacyPayloadSize(previous, next);
    assert.equal(Buffer.byteLength(updated), Buffer.byteLength(previous));
    assert.deepEqual(JSON.parse(updated), JSON.parse(next));
    assert.equal(preserveLegacyPayloadSize('{"text":"é"}', '{"text":"a"}'), '{"text":"a"} ');
    assert.equal(preserveLegacyPayloadSize(next, previous), previous);
    assert.equal(preserveLegacyPayloadSize(JSON.stringify({ text: "x".repeat(100) }), "{}"), "{}");
  });
});
