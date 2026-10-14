import styalMarkUrl from "../../../../assets/brand/mark.svg?url";

/** Mask the shared artwork so the external SVG follows the row's icon color. */
export function StyalToolIcon({ className }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden
      style={{
        display: "inline-block",
        backgroundColor: "currentColor",
        maskImage: `url("${styalMarkUrl}")`,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
      }}
    />
  );
}
