import { mFallback, msg } from "gt-i18n";
import { describeHostActivity as describe, type HostActivityCheck } from "./hostActivity.ts";

export const hostActivityReasonLabels = {
  preparing: msg("Preparing"),
  starting: msg("Starting"),
  running: msg("Running"),
  input: msg("Needs input"),
  approval: msg("Needs approval"),
  waiting: msg("Waiting"),
  command: msg("Command"),
  monitor: msg("Watcher"),
  subagent: msg("Subagent"),
  background_task: msg("Task"),
};

export function hostActivitySectionHeading(
  continues: boolean,
  resolve: (message: string) => string = mFallback,
) {
  return resolve(continues ? msg("Resumes on its own") : msg("Stops until you message it"));
}

export function describeHostActivity(
  checks: ReadonlyArray<HostActivityCheck | null>,
  options: Parameters<typeof describe>[1],
  resolve: (message: string) => string = mFallback,
) {
  return describe(checks, {
    ...options,
    copy: {
      unavailable: (host) =>
        resolve(
          host === undefined
            ? msg("Thread names and activity reasons are unavailable from this server.")
            : msg("Thread names and activity reasons are unavailable for {host}.", {
                host: host.replace(/\s+/gu, " ").trim(),
              }),
        ),
      interrupted: (threads, terminals) =>
        resolve(
          threads === 0
            ? msg(
                "{terminals, plural, one {{terminals} terminal session will be interrupted.} other {{terminals} terminal sessions will be interrupted.}}",
                { terminals },
              )
            : terminals === 0
              ? msg(
                  "{threads, plural, one {{threads} thread will be interrupted.} other {{threads} threads will be interrupted.}}",
                  { threads },
                )
              : msg(
                  "{threads, plural, one {{threads} thread} other {{threads} threads}} and {terminals, plural, one {{terminals} terminal session} other {{terminals} terminal sessions}} will be interrupted.",
                  { threads, terminals },
                ),
        ),
      continuing: (count, when) =>
        resolve(
          when === "when styal next starts"
            ? msg(
                "{count, plural, one {{count} thread will continue when styal next starts.} other {{count} threads will continue when styal next starts.}}",
                { count },
              )
            : msg(
                "{count, plural, one {{count} thread will continue after the restart.} other {{count} threads will continue after the restart.}}",
                { count },
              ),
        ),
      unknownTerminals: (count) =>
        resolve(
          msg(
            "Could not check {count, plural, one {{count} terminal session} other {{count} terminal sessions}} for running commands.",
            { count },
          ),
        ),
    },
  });
}
