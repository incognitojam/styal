const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareReport, OK, ATTENTION, QUIET } = require("./quiet-report.cjs");

test("routine reports stay quiet, attention and one recovery stay loud", () => {
  const ok = "report\n" + OK;
  const bad = "report\n" + ATTENTION;
  assert.equal(prepareReport(ok), ok + "\n" + QUIET);
  assert.equal(prepareReport(bad), bad);
  assert.equal(prepareReport(bad, ok), bad);
  assert.equal(prepareReport(ok, bad), ok);
  assert.equal(prepareReport(ok, "legacy report"), ok);
  assert.equal(prepareReport(ok, ok), ok + "\n" + QUIET);
  assert.equal(prepareReport(ok, ok + "\n" + QUIET), ok + "\n" + QUIET);
  assert.equal(prepareReport("unknown report"), "unknown report");
});
