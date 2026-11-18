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
  let id = options.id;
  if (!id) {
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
    id = submitted.stdout.match(
      /Submission details: https:\/\/expo\.dev\/accounts\/[^/\s]+\/projects\/[^/\s]+\/submissions\/([0-9a-f-]{36})\b/,
    )?.[1];
    if (!id) {
      throw new Error(
        "EAS did not return a submission ID; do not resubmit without checking EAS Submit.",
      );
    }
    await options.onSubmitted?.(id);
  }
  if (options.scheduleOnly) return false;
  let readable = false;
  console.log(`Waiting up to ${timeout / 60000} minutes for submission ${id}.`);
  const deadline = now() + (timeout || 120_000);
  let backoff = 10_000;
  while (now() < deadline) {
    const result = run(
      ["submit:view", id, "--json"],
      Math.min(120_000, Math.ceil(deadline - now())),
    );
    if (now() >= deadline) break;
    let submission;
    if (result.error || result.status !== 0) {
      console.error(result.stderr || result.error?.message || "EAS status request failed.");
      console.error(`Unable to read submission ${id}; retrying status only.`);
    } else {
      try {
        const jsonStart = result.stdout.search(/^\{/m);
        if (jsonStart < 0) throw new Error("Missing JSON document");
        submission = JSON.parse(result.stdout.slice(jsonStart));
      } catch {
        console.error(`Unable to parse status for submission ${id}; retrying status only.`);
      }
    }
    readable = Boolean(submission);
    if (submission) {
      if (submission.id !== id) throw new Error("EAS returned a different submission ID.");
      console.log(`Submission ${id}: ${submission.status}`);
      switch (submission.status) {
        case "FINISHED":
          console.log(
            "EAS uploaded the binary to App Store Connect; Apple processing is not awaited.",
          );
          return true;
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
    if (timeout === 0) {
      if (readable) return false;
      throw new Error(`Unable to read submission ${id}; reservation retained.`);
    }
    await pause(Math.min(backoff, Math.max(0, deadline - now())));
    backoff = Math.min(backoff * 2, 60_000);
  }
  if (readable) {
    console.log(
      `Submission ${id} remains pending; a later production run will check it without uploading again.`,
    );
    return false;
  }
  throw new Error(
    `Timed out waiting for submission ${id}; check EAS Submit before any manual resubmission.`,
  );
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
}

function tagStore() {
  return {
    list: () => git("tag", "-l", "ios-pending-*").split("\n").filter(Boolean),
    read: (tag) => git("for-each-ref", `refs/tags/${tag}`, "--format=%(contents)") || null,
    write: (tag, commit, message) => {
      git(
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "tag",
        "-a",
        tag,
        commit,
        "-m",
        message,
      );
      git("push", "origin", `refs/tags/${tag}`);
    },
  };
}

function hasPendingIos(store, fingerprint) {
  return store.list().some((tag) => {
    const meta = JSON.parse(store.read(tag));
    return (
      (!fingerprint || meta.fingerprint === fingerprint) &&
      !store.read(`ios-${meta.version}-${meta.build}`)
    );
  });
}

async function reconcileIos(store, options = {}) {
  let pending = false;
  const tags = store.list().filter((tag) => {
    const meta = JSON.parse(store.read(tag));
    return !store.read(`ios-${meta.version}-${meta.build}`);
  });
  const timeout = Math.floor((options.timeout ?? 60 * 60 * 1000) / Math.max(1, tags.length));
  for (const tag of tags) {
    const meta = JSON.parse(store.read(tag));
    const finishedTag = `ios-${meta.version}-${meta.build}`;
    if (store.read(finishedTag)) continue;
    const id = store.read(tag.replace("ios-pending-", "ios-submission-"));
    if (!id)
      throw new Error(
        `${tag} has no submission ID; inspect EAS before recovery, never resubmit blindly.`,
      );
    const finished = await submitIos(null, {
      ...options,
      id,
      timeout,
    });
    if (finished) {
      store.write(
        finishedTag,
        meta.commit,
        `styal for iOS ${meta.version} (${meta.build})\n\nruntime-version: ${meta.fingerprint}`,
      );
    } else {
      pending = true;
    }
  }
  return pending;
}

async function publishIos(ipa, meta, store, options = {}) {
  const tag = `ios-pending-${meta.version}-${meta.build}`;
  // Reserve before upload: even an ambiguous CLI result must prevent a second submission.
  store.write(tag, meta.commit, JSON.stringify(meta));
  const finished = await submitIos(ipa, {
    ...options,
    onSubmitted: (id) =>
      store.write(tag.replace("ios-pending-", "ios-submission-"), meta.commit, id),
  });
  if (finished) {
    store.write(
      `ios-${meta.version}-${meta.build}`,
      meta.commit,
      `styal for iOS ${meta.version} (${meta.build})\n\nruntime-version: ${meta.fingerprint}`,
    );
  }
  return finished;
}

module.exports = { submitIos, reconcileIos, publishIos, hasPendingIos };

if (require.main === module) {
  const { appendFileSync } = require("node:fs");
  const store = tagStore();
  const options = { timeout: 5 * 60 * 60 * 1000 };
  (async () => {
    if (process.argv.includes("--pending")) {
      console.log(hasPendingIos(store, process.env.FINGERPRINT));
    } else if (process.argv.includes("--reconcile")) {
      const pending = await reconcileIos(store, options);
      const finished = store.list().some((tag) => {
        const meta = JSON.parse(store.read(tag));
        return (
          meta.fingerprint === process.env.FINGERPRINT &&
          Boolean(store.read(`ios-${meta.version}-${meta.build}`))
        );
      });
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `pending=${pending}\nfinished=${finished}\nfingerprint=${process.env.FINGERPRINT}\n`,
      );
    } else {
      const { IPA, VERSION, BUILD_NUMBER, FINGERPRINT, COMMIT } = process.env;
      if (!IPA || !VERSION || !BUILD_NUMBER || !FINGERPRINT || !COMMIT)
        throw new Error("Missing iOS build metadata.");
      const finished = await publishIos(
        IPA,
        { version: VERSION, build: BUILD_NUMBER, fingerprint: FINGERPRINT, commit: COMMIT },
        store,
        { ...options, scheduleOnly: true },
      );
      appendFileSync(process.env.GITHUB_OUTPUT, `finished=${finished}\nsubmitted=true\n`);
    }
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
