import { cn } from "../lib/utils";
import { StyalWordmark } from "./StyalWordmark";

/** Keep the wordmark readable inside the work log's compact icon slot. */
export function StyalToolIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center", className)} aria-hidden>
      <StyalWordmark className="h-2.5" />
    </span>
  );
}
