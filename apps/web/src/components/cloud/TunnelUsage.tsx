import { TriangleAlertIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
const MAX_SEGMENTS = 10;
export function TunnelUsageMeter({
  used,
  limit,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly className?: string;
}) {
  const full = used >= limit;
  const fill = full ? "bg-warning" : "bg-foreground/72";
  return (
    <div className={cn("flex max-w-sm flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={cn("tabular-nums", full ? "text-warning-foreground" : "text-foreground")}>
          {used} of {limit} tunnels in use
        </span>
      </div>
      <div
        role="meter"
        aria-label="styal Link tunnels in use"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="flex h-1.5 gap-1"
      >
        {limit <= MAX_SEGMENTS ? (
          Array.from({ length: limit }, (_, index) => (
            <span
              key={index}
              className={cn("flex-1 rounded-full", index < used ? fill : "bg-muted")}
            />
          ))
        ) : (
          <span className="flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full", fill)}
              style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

export function TunnelLimitAlert() {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Your account has reached its tunnel limit.</AlertTitle>
      <AlertDescription>
        Unlink an environment you no longer use from your styal Link account page, or connect over
        Tailscale.
      </AlertDescription>
    </Alert>
  );
}
