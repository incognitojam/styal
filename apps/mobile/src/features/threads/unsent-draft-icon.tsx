import { SymbolView } from "../../components/AppSymbol";

/** Marks a thread whose composer holds unsent text, in the amber used for drafts. */
export function UnsentDraftIcon() {
  return (
    <SymbolView
      name="square.and.pencil"
      size={12}
      tintColorClassName="accent-adaptive-amber-700-300"
      type="monochrome"
    />
  );
}
