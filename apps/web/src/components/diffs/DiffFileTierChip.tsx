import { reviewPathTier } from "@t3tools/client-runtime/review-path-order";
import { useGT } from "gt-react";

export function DiffFileTierChip({ path }: { readonly path: string }) {
  const gt = useGT();
  const tier = reviewPathTier(path);
  if (tier === 0) return null;
  return (
    <span className="ms-1.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-sans text-3xs font-medium leading-none text-muted-foreground">
      {tier === 1 ? gt("tests") : gt("generated")}
    </span>
  );
}
