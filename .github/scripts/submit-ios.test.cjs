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
  assert.equal(await submitIos("synthetic.ipa", stub.options), false);
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

test("an environment notice before the status JSON does not interrupt the wait", async () => {
  const stub = stubEas([
    {
      stdout: `Environment variables loaded from production.\n${JSON.stringify({ id, status: "FINISHED" }, null, 2)}\n`,
    },
  ]);
  await submitIos("synthetic.ipa", stub.options);
  assert.equal(stub.calls.length, 2);
  assertSubmittedOnce(stub.calls);
});

test("unparseable status output retries only status reads and later recovers", async () => {
  const stub = stubEas([
    { stdout: "Unexpected response without JSON" },
    { stdout: 'Environment variables loaded.\n{"id":' },
    { stdout: JSON.stringify({ id, status: "FINISHED" }) },
  ]);
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(message);
  try {
    await submitIos("synthetic.ipa", stub.options);
  } finally {
    console.error = originalError;
  }
  assert.equal(stub.calls.length, 4);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => message.includes("retrying status only")));
  assert.ok(
    messages.every(
      (message) => !message.includes("Unexpected response") && !message.includes('"id":'),
    ),
  );
  assertSubmittedOnce(stub.calls);
});

test("queued timeout can resume later without another upload", async () => {
  const stub = stubEas(
    Array.from({ length: 10 }, () => ({ stdout: JSON.stringify({ id, status: "IN_QUEUE" }) })),
  );
  assert.equal(await submitIos("synthetic.ipa", stub.options), false);
  const resumed = stubEas([{ stdout: JSON.stringify({ id, status: "FINISHED" }) }]);
  assert.equal(await submitIos(null, { ...resumed.options, id }), true);
  assert.deepEqual(resumed.calls, [["submit:view", id, "--json"]]);
});

const { publishIos, reconcileIos } = require("./submit-ios.cjs");
const meta = {
  version: "1.0",
  build: "42",
  commit: "a".repeat(40),
  fingerprint: "synthetic-runtime",
};
function memoryStore() {
  const tags = new Map();
  return {
    tags,
    list: () => [...tags.keys()].filter((tag) => tag.startsWith("ios-pending-")),
    read: (tag) => tags.get(tag) ?? null,
    write: (tag, commit, message) => {
      assert.equal(commit, meta.commit);
      assert.ok(!tags.has(tag), "existing tags must never be overwritten");
      tags.set(tag, message);
    },
  };
}

test("pending upload is durable, later FINISHED records the original build, repeat reconciliation is inert", async () => {
  const store = memoryStore();
  const stub = stubEas([]);
  assert.equal(await publishIos("synthetic.ipa", meta, store, stub.options), false);
  assert.equal(store.read("ios-1.0-42"), null);
  assert.equal(store.read("ios-submission-1.0-42"), id);
  await assert.rejects(publishIos("synthetic.ipa", meta, store, stub.options), /existing tags/);
  assertSubmittedOnce(stub.calls);
  const resume = stubEas([{ stdout: JSON.stringify({ id, status: "FINISHED" }) }]);
  assert.equal(await reconcileIos(store, resume.options), false);
  assert.match(store.read("ios-1.0-42"), /runtime-version: synthetic-runtime/);
  await reconcileIos(store, resume.options);
  assert.deepEqual(resume.calls, [["submit:view", id, "--json"]]);
});

for (const status of ["IN_QUEUE", "ERRORED", "CANCELED", "unreadable"]) {
  test(`resuming ${status} never records an unconfirmed build or uploads`, async () => {
    const store = memoryStore();
    store.write("ios-pending-1.0-42", meta.commit, JSON.stringify(meta));
    store.write("ios-submission-1.0-42", meta.commit, id);
    const response = {
      stdout: status === "unreadable" ? "not JSON" : JSON.stringify({ id, status }),
    };
    const stub = stubEas(Array.from({ length: 20 }, () => response));
    if (status === "IN_QUEUE") assert.equal(await reconcileIos(store, stub.options), true);
    else await assert.rejects(reconcileIos(store, stub.options), /ERRORED|CANCELED|Timed out/);
    assert.equal(store.read("ios-1.0-42"), null);
    assert.ok(stub.calls.every(([command]) => command === "submit:view"));
  });
}

test("an ambiguous upload leaves a reservation that blocks recovery until inspected", async () => {
  const store = memoryStore();
  await assert.rejects(
    publishIos("synthetic.ipa", meta, store, {
      run: () => ({ status: 1, stderr: "Connection lost" }),
    }),
    /not be retried/,
  );
  await assert.rejects(reconcileIos(store), /no submission ID/);
  assert.equal(store.read("ios-1.0-42"), null);
});

test("pending A suppresses only A; native drift B can build, and completed A no longer suppresses either", async () => {
  const { hasPendingIos } = require("./submit-ios.cjs");
  const store = memoryStore();
  store.write("ios-pending-1.0-42", meta.commit, JSON.stringify(meta));
  store.write("ios-submission-1.0-42", meta.commit, id);
  assert.equal(hasPendingIos(store, meta.fingerprint), true);
  assert.equal(hasPendingIos(store, "new-native-runtime"), false);
  const stub = stubEas([{ stdout: JSON.stringify({ id, status: "FINISHED" }) }]);
  await reconcileIos(store, stub.options);
  assert.equal(hasPendingIos(store, meta.fingerprint), false);
  assert.equal(hasPendingIos(store, "new-native-runtime"), false);
});

test("macOS scheduling persists the ID and returns without polling Expo's queue", async () => {
  const store = memoryStore();
  const stub = stubEas([]);
  assert.equal(
    await publishIos("synthetic.ipa", meta, store, { ...stub.options, scheduleOnly: true }),
    false,
  );
  assert.equal(stub.calls.length, 1);
  assert.equal(store.read("ios-submission-1.0-42"), id);
  assert.equal(store.read("ios-1.0-42"), null);
});

test("a queued submission cannot consume the status budget of a later finished upload", async () => {
  const store = memoryStore();
  const secondId = "00000000-0000-4000-8000-000000000002";
  store.write("ios-pending-1.0-42", meta.commit, JSON.stringify(meta));
  store.write("ios-submission-1.0-42", meta.commit, id);
  store.write("ios-pending-1.0-43", meta.commit, JSON.stringify({ ...meta, build: "43" }));
  store.write("ios-submission-1.0-43", meta.commit, secondId);
  const stub = stubEas([]);
  const run = stub.options.run;
  stub.options.run = (args, timeout) =>
    args[1] === secondId
      ? { status: 0, stdout: JSON.stringify({ id: secondId, status: "FINISHED" }) }
      : run(args, timeout);
  assert.equal(await reconcileIos(store, stub.options), true);
  assert.equal(store.read("ios-1.0-42"), null);
  assert.match(store.read("ios-1.0-43"), /runtime-version: synthetic-runtime/);
});
