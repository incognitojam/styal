import { describe } from "@effect/vitest";
import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-redundant-tooltip", { filename: "fixture.tsx" });
describe("t3code/no-redundant-tooltip", () => {
  rule.invalid(
    "matches visible text",
    `const x = <Tooltip><TooltipTrigger><button>Save</button></TooltipTrigger><TooltipPopup>Save</TooltipPopup></Tooltip>`,
  );
  rule.invalid(
    "matches dynamic expressions",
    `const x = <Tooltip><TooltipTrigger render={<Button />}>{pendingLabel}</TooltipTrigger><TooltipPopup>{pendingLabel}</TooltipPopup></Tooltip>`,
  );
  rule.invalid(
    "matches nested text beside icons",
    `const x = <Tooltip><TooltipTrigger><Button><SaveIcon /><span>Save</span></Button></TooltipTrigger><TooltipPopup>Save</TooltipPopup></Tooltip>`,
  );
  rule.invalid(
    "matches content in render props",
    `const x = <Tooltip><TooltipTrigger render={<Button><SaveIcon aria-hidden />Save</Button>} /><TooltipPopup>Save</TooltipPopup></Tooltip>`,
  );
  rule.valid(
    "keeps icon labels",
    `const x = <Tooltip><TooltipTrigger render={<Button aria-label="Open keybindings.json" />}><FileIcon /></TooltipTrigger><TooltipPopup>Open keybindings.json</TooltipPopup></Tooltip>`,
  );
  rule.valid(
    "keeps truncated text",
    `const x = <Tooltip><TooltipTrigger><span className="truncate">{label}</span></TooltipTrigger><TooltipPopup>{label}</TooltipPopup></Tooltip>`,
  );
  rule.valid(
    "keeps shortcuts and reasons",
    `const x = <Tooltip><TooltipTrigger>Save</TooltipTrigger><TooltipPopup>Save (Ctrl+S)</TooltipPopup></Tooltip>`,
  );
  rule.valid(
    "does not infer component props",
    `const x = <Tooltip><TooltipTrigger><Action label={label} /></TooltipTrigger><TooltipPopup>{label}</TooltipPopup></Tooltip>`,
  );
});
