const { spawnSync } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");

function runEas(args, timeout) {
  return spawnSync("eas", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

async function submitIos(ipa, options = {}) {
  const run = options.run ?? runEas;
  const now = options.now ?? (() => performance.now());
  const pause = options.sleep ?? sleep;
  const timeout = options.timeout ?? 60 * 60 * 1000;
  // EAS CLI 25.3.0 has no submit --json; its details URL carries the ID.
  const submitted = run(
    [
      "submit",
      "--platform",
      "ios",
      "--profile",
      "production",
      "--path",
      ipa,
      "--non-interactive",
      "--no-wait",
    ],
    20 * 60 * 1000,
  );
  process.stdout.write(submitted.stdout ?? "");
  process.stderr.write(submitted.stderr ?? "");
  if (submitted.error || submitted.status !== 0) {
    throw new Error(
      "EAS submit failed; it will not be retried because it may already have scheduled a submission.",
    );
  }
  const id = submitted.stdout.match(
    /Submission details: https:\/\/expo\.dev\/accounts\/[^/\s]+\/projects\/[^/\s]+\/submissions\/([0-9a-f-]{36})\b/,
  )?.[1];
  if (!id) {
    throw new Error(
      "EAS did not return a submission ID; do not resubmit without checking EAS Submit.",
    );
  }
  console.log(`Waiting up to ${timeout / 60000} minutes for submission ${id}.`);
  const deadline = now() + timeout;
  let backoff = 10_000;
  while (now() < deadline) {
    const result = run(
      ["submit:view", id, "--json"],
      Math.min(120_000, Math.ceil(deadline - now())),
    );
    if (now() >= deadline) break;
    if (result.error || result.status !== 0) {
      console.error(result.stderr || result.error?.message || "EAS status request failed.");
      console.error(`Unable to read submission ${id}; retrying status only.`);
    } else {
      const submission = JSON.parse(result.stdout);
      if (submission.id !== id) throw new Error("EAS returned a different submission ID.");
      console.log(`Submission ${id}: ${submission.status}`);
      switch (submission.status) {
        case "FINISHED":
          console.log(
            "EAS uploaded the binary to App Store Connect; Apple processing is not awaited.",
          );
          return;
        case "ERRORED":
        case "CANCELED":
          throw new Error(
            `Submission ${id} ${submission.status}: ${JSON.stringify(submission.error ?? null)}. Check its EAS submission details for logs.`,
          );
        case "AWAITING_BUILD":
        case "IN_QUEUE":
        case "IN_PROGRESS":
          break;
        default:
          throw new Error(`Unrecognized EAS submission status: ${submission.status}`);
      }
      backoff = 10_000;
    }
    await pause(Math.min(backoff, Math.max(0, deadline - now())));
    backoff = Math.min(backoff * 2, 60_000);
  }
  throw new Error(
    `Timed out waiting for submission ${id}; check EAS Submit before any manual resubmission.`,
  );
}

module.exports = { submitIos };

if (require.main === module) {
  if (!process.env.IPA) throw new Error("IPA is required.");
  submitIos(process.env.IPA).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
