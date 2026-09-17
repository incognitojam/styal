import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ADD_PROVIDER_WIZARD_STEPS } from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderStepButtons(
  currentStep: number,
  instanceIdError: string | null,
  onNavigation: Parameters<typeof AddProviderInstanceWizardSteps>[0]["onNavigation"],
) {
  await act(async () => {
    renderer = create(
      <AddProviderInstanceWizardSteps
        currentStep={currentStep}
        summaries={["Codex", "Codex Workspace", null]}
        instanceIdError={instanceIdError}
        onNavigation={onNavigation}
      />,
    );
  });
  return renderer!.root.findAllByType("button");
}

describe("AddProviderInstanceWizardSteps", () => {
  it("gates the actual Config header click through Identity validation", async () => {
    const onNavigation = vi.fn();
    const buttons = await renderStepButtons(0, "Instance ID is required.", onNavigation);

    expect(buttons).toHaveLength(ADD_PROVIDER_WIZARD_STEPS.length);
    await act(async () => buttons[2]!.props.onClick());

    expect(onNavigation).toHaveBeenCalledOnce();
    expect(onNavigation).toHaveBeenCalledWith({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("marks the wizard step separately from the clicked button focus", async () => {
    const buttons = await renderStepButtons(1, "Instance ID is required.", vi.fn());

    expect(buttons[0]!.props["aria-current"]).toBeUndefined();
    expect(buttons[1]!.props["aria-current"]).toBe("step");
    expect(buttons[2]!.props["aria-current"]).toBeUndefined();
  });

  it("preserves the actual backward header click", async () => {
    const onNavigation = vi.fn();
    const buttons = await renderStepButtons(2, "Instance ID is required.", onNavigation);

    await act(async () => buttons[0]!.props.onClick());

    expect(onNavigation).toHaveBeenCalledWith({ kind: "navigate", step: 0 });
  });
});
