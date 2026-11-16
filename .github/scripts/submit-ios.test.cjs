const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { submitIos } = require("./submit-ios.cjs");

const id = "00000000-0000-4000-8000-000000000001";
const url = `https://expo.dev/accounts/example/projects/example/submissions/${id}`;

function stubEas(responses) {
  const calls = [];
  let clock = 0;
  return {
    calls,
    options: {
      timeout: 100_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      run: (args, timeout) => {
        calls.push(args);
        assert.ok(timeout > 0);
        const response =
          args[0] === "submit"
            ? { stdout: `✔ Scheduled iOS submission\nSubmission details: ${url}\n` }
            : (responses.shift() ?? { stdout: JSON.stringify({ id, status: "IN_PROGRESS" }) });
        // Execute a stub CLI process, including its stdout, stderr, and exit status.
        return spawnSync(
          process.execPath,
          [
            "-e",
            `
          const response = JSON.parse(process.argv[1]);
          process.stdout.write(response.stdout ?? '');
          process.stderr.write(response.stderr ?? '');
          process.exitCode = response.code ?? 0;
        `,
            JSON.stringify(response),
          ],
          { encoding: "utf8" },
        );
      },
    },
  };
}

function assertSubmittedOnce(calls) {
  assert.equal(calls.filter(([command]) => command === "submit").length, 1);
  assert.ok(calls[0].includes("--no-wait"));
  for (const call of calls.slice(1)) assert.deepEqual(call, ["submit:view", id, "--json"]);
}

test("DNS failures only retry reads of the scheduled submission, then allow success", async () => {
  const stub = stubEas([
    { code: 1, stderr: "getaddrinfo ENOTFOUND api.expo.dev" },
    { code: 1, stderr: "getaddrinfo ENOTFOUND api.expo.dev" },
    { stdout: JSON.stringify({ id, status: "IN_QUEUE" }) },
    { stdout: JSON.stringify({ id, status: "FINISHED" }) },
  ]);
  await submitIos("synthetic.ipa", stub.options);
  assert.equal(stub.calls.length, 5);
  assertSubmittedOnce(stub.calls);
});

for (const status of ["ERRORED", "CANCELED"]) {
  test(`${status} fails immediately without resubmitting`, async () => {
    const stub = stubEas([
      { stdout: JSON.stringify({ id, status, error: { message: "Synthetic failure" } }) },
    ]);
    await assert.rejects(submitIos("synthetic.ipa", stub.options), new RegExp(status));
    assert.equal(stub.calls.length, 2);
    assertSubmittedOnce(stub.calls);
  });
}

test("a submission that never finishes reaches the total deadline without resubmitting", async () => {
  const stub = stubEas([]);
  await assert.rejects(submitIos("synthetic.ipa", stub.options), /Timed out/);
  assertSubmittedOnce(stub.calls);
});

test("a continuous network outage also reaches the total deadline", async () => {
  const stub = stubEas(
    Array.from({ length: 10 }, () => ({ code: 1, stderr: "getaddrinfo ENOTFOUND api.expo.dev" })),
  );
  await assert.rejects(submitIos("synthetic.ipa", stub.options), /Timed out/);
  assertSubmittedOnce(stub.calls);
});

for (const result of [
  { status: 1, stdout: `Submission details: ${url}`, stderr: "Connection lost after scheduling" },
  { status: 0, stdout: "Unexpected output", stderr: "" },
]) {
  test(`ambiguous scheduling result (${result.status}) stops without retrying submit`, async () => {
    let calls = 0;
    await assert.rejects(
      submitIos("synthetic.ipa", {
        run: () => {
          calls++;
          return result;
        },
      }),
      /not be retried|do not resubmit/,
    );
    assert.equal(calls, 1);
  });
}

test("a stalled status request is bounded by the remaining overall deadline", async () => {
  const stub = stubEas([]);
  const run = stub.options.run;
  const timeouts = [];
  let clock = 0;
  stub.options.now = () => clock;
  stub.options.run = (args, timeout) => {
    if (args[0] === "submit") return run(args, timeout);
    stub.calls.push(args);
    timeouts.push(timeout);
    clock += timeout;
    return { status: null, error: new Error("ETIMEDOUT") };
  };
  await assert.rejects(submitIos("synthetic.ipa", stub.options), /Timed out/);
  assert.deepEqual(timeouts, [100_000]);
  assertSubmittedOnce(stub.calls);
});
