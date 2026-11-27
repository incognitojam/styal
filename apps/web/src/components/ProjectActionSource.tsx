import type { ProjectActionsResult } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useNowMinute } from "../hooks/useNowMinute";
import { Button } from "./ui/button";

export function ProjectActionSource({
  data,
  onFetch,
}: {
  data: ProjectActionsResult;
  onFetch: () => void;
}) {
  const gt = useGT();
  const source = data.source;
  const now = useNowMinute();
  const minutes =
    source.kind === "remote" && source.fetchedAt
      ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(source.fetchedAt)) / 60_000))
      : null;
  return (
    <div className="space-y-2 px-2 py-2 text-xs text-muted-foreground">
      <div className="flex items-start justify-between gap-3">
        <span>
          {source.kind === "disk"
            ? gt("Actions from t3.json in this folder")
            : minutes === null
              ? gt("Actions from {ref} at {commit}, fetch time unknown", {
                  ref: source.ref,
                  commit: source.commit.slice(0, 7),
                })
              : minutes === 0
                ? gt("Actions from {ref} at {commit}, fetched just now", {
                    ref: source.ref,
                    commit: source.commit.slice(0, 7),
                  })
                : gt("Actions from {ref} at {commit}, fetched {minutes} minutes ago", {
                    ref: source.ref,
                    commit: source.commit.slice(0, 7),
                    minutes,
                  })}
        </span>
        {source.kind === "remote" && (
          <Button size="xs" variant="ghost" onClick={onFetch}>
            <T>Fetch now</T>
          </Button>
        )}
      </div>
      {data.unmerged && source.kind === "remote" && (
        <div className="rounded-md border border-warning/30 p-2">
          <p>
            {gt(
              "This branch's t3.json has changes that aren't on {ref} yet. Actions run from {ref}.",
              { ref: source.ref },
            )}
          </p>
          <p className="mt-1">{data.changedNames.join(", ")}</p>
        </div>
      )}
      {!data.policyAllowed && (
        <p role="status">
          <T>Project commands are disabled by managed policy.</T>
        </p>
      )}
    </div>
  );
}
