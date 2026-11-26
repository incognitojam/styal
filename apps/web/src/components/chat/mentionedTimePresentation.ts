export type MentionedTimeZone =
  | { readonly offsetMinutes: number; readonly name?: string }
  | { readonly timeZone: string; readonly name?: string };

export interface MentionedTime {
  readonly kind: "clock";
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
  readonly date?: { readonly year?: number; readonly month: number; readonly day: number };
  readonly dayOffset?: number;
  readonly zone: MentionedTimeZone;
}

export interface MentionedTimeAnchor {
  readonly writtenAtMs: number;
}

export interface ResolvedMentionedTime {
  readonly instantMs: number;
  readonly assumedDay: boolean;
}

export function mentionedTimeZoneName(zone: MentionedTimeZone): string {
  if (zone.name !== undefined) return zone.name;
  if ("timeZone" in zone) return zone.timeZone;
  if (zone.offsetMinutes === 0) return "UTC";
  const sign = zone.offsetMinutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(zone.offsetMinutes) / 60);
  const minutes = Math.abs(zone.offsetMinutes) % 60;
  return `UTC${sign}${hours}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}
