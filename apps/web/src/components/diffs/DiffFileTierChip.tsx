import type { DiffFileTier } from "~/lib/diffFileOrder";

/** The muted tag beside a filename that says why a file sits where it does in a smart-ordered diff. */
export function DiffFileTierChip({ tier }: { readonly tier: DiffFileTier }) {
  if (tier === "source") return null;
  return (
    <span className="ms-1.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium leading-none text-muted-foreground">
      {tier === "test" ? "tests" : "generated"}
    </span>
  );
}
