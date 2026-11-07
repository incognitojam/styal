import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";

export function AutoPullStatus({
  environmentId,
  cwd,
  label,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  label?: string | undefined;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
  );
  const last = query.data?.autoPull?.lastRun;
  return (
    <div className="pt-3 pb-2 text-xs">
      {label ? <p className="mb-2 font-medium">{label}</p> : null}
      {last ? (
        <div className="space-y-1">
          <p className="min-w-0 break-words first-letter:uppercase">
            {last.outcome}
            {last.detail ? ` · ${last.detail}` : ""}
          </p>
          <p className="text-muted-foreground">
            Last checked:{" "}
            <time dateTime={last.checkedAt}>{new Date(last.checkedAt).toLocaleString()}</time>
          </p>
        </div>
      ) : null}
      {query.error ? (
        <p className="mt-2 text-destructive">Could not load the last check: {query.error}</p>
      ) : query.isPending && query.data === null ? (
        <p className="mt-2 text-muted-foreground">Loading last check…</p>
      ) : !query.data?.autoPull ? (
        <p className="mt-2 text-muted-foreground">
          Automatic pull diagnostics are unavailable from this server.
        </p>
      ) : !last ? (
        <p className="mt-2 text-muted-foreground">No check recorded this server session.</p>
      ) : null}
    </div>
  );
}
