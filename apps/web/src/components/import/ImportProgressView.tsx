import { CheckIcon, MonitorIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ImportProgressView({
  label,
  rows,
  children,
}: {
  label: string;
  rows: readonly {
    id: string;
    title: string;
    status: string;
    complete?: boolean;
    failed?: boolean;
  }[];
  children?: ReactNode;
}) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label={`${label} import progress`}
      className="overflow-hidden rounded-lg border border-border/60 bg-card"
    >
      <h4 className="flex items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-3 text-sm font-medium">
        <MonitorIcon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{label}</span>
      </h4>
      {children}
      <ul className="divide-y divide-border/60" aria-live="polite" aria-relevant="text">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm"
          >
            <span className="min-w-0 flex-1 break-words">{row.title}</span>
            <span
              className={
                row.failed
                  ? "text-xs text-destructive"
                  : "flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
              }
            >
              {row.complete ? <CheckIcon className="size-3.5 text-primary" aria-hidden /> : null}
              {row.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
