import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";

export function AutoPullStatus({
  environmentId,
  cwd,
  label,
  enabled,
  source,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  label?: string | undefined;
  enabled: boolean;
  source: string;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd, includeRemote: false } }),
  );
  const last = query.data?.autoPull?.lastRun;
  return (
    <div className="mb-3 px-4 pb-3 text-xs">
      {label ? <p className="mb-2 font-medium">{label}</p> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-muted-foreground">Effective setting</dt>
        <dd>
          {enabled ? "On" : "Off"} · {source}
        </dd>
        {last ? (
          <>
            <dt className="text-muted-foreground">Last result</dt>
            <dd className="first-letter:uppercase">{last.outcome}</dd>
            <dt className="text-muted-foreground">Last checked</dt>
            <dd>
              <time dateTime={last.checkedAt}>{new Date(last.checkedAt).toLocaleString()}</time>
            </dd>
            {last.detail ? (
              <>
                <dt className="text-muted-foreground">
                  {last.outcome === "failed" ? "Error" : "Reason"}
                </dt>
                <dd className="min-w-0 break-words">{last.detail}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
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
