import {
  deviceStreamStatsRows,
  type DeviceStreamStats,
} from "@t3tools/client-runtime/device/stream-stats";
import { useEffect, useState } from "react";

/** Reads the stream's counters once a second while shown; nothing runs while hidden. */
export function DeviceStreamStatsOverlay(props: { readonly read: () => DeviceStreamStats | null }) {
  const { read } = props;
  const [stats, setStats] = useState(read);
  useEffect(() => {
    const timer = setInterval(() => setStats(read()), 1_000);
    return () => clearInterval(timer);
  }, [read]);
  if (!stats) return null;
  return (
    <dl
      aria-label="Stream stats"
      className="pointer-events-none absolute top-3 left-3 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-lg border border-border/50 bg-background/90 px-3 py-2 text-xs shadow-sm"
    >
      {deviceStreamStatsRows(stats).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
