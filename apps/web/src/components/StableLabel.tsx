/** Keeps the width of a label the button showed before, so neither button moves. */
export function StableLabel({
  label,
  previous,
}: {
  readonly label: string;
  readonly previous?: string | undefined;
}) {
  if (previous === undefined || previous === label) return label;
  return (
    <span className="grid">
      <span className="col-start-1 row-start-1">{label}</span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {previous}
      </span>
    </span>
  );
}
