import { RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FeedbackReportApprovalBanner } from "./FeedbackReportApproval";

describe("FeedbackReportApprovalBanner", () => {
  it("offers posting only beside the full report", async () => {
    const onRespondToApproval = vi.fn(async () => undefined);
    await using screen = await render(
      <FeedbackReportApprovalBanner
        report={{
          title: "A title",
          body: "The body that gets posted",
          repository: "incognitojam/styal",
          account: "octocat",
        }}
        requestId={RuntimeRequestId.make("request-1")}
        isResponding={false}
        canRespond
        disabled={false}
        options={[
          { decision: "accept", label: "Post publicly" },
          { decision: "decline", label: "Don't post" },
        ]}
        onRespondToApproval={onRespondToApproval}
      />,
    );

    await expect.element(screen.getByRole("button", { name: "Don't post" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Post publicly" }).query()).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await expect.element(page.getByText("A title")).toBeVisible();
    await expect.element(page.getByText("The body that gets posted")).toBeVisible();
    // Base UI's inert backdrop sits over the iframe the test renders in, so a pointer click misses.
    page
      .getByRole("button", { name: "Post publicly" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRespondToApproval).toHaveBeenCalledWith(RuntimeRequestId.make("request-1"), "accept");
  });
});
